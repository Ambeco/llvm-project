// Streaming-protocol tests for clangd.wasm: a real child process with real
// stdin/stdout pipes, so we can wait for replies, chain requests, split
// frames, send garbage, edit files on disk mid-session, and kill the pipe.
// These prove the host contract for a long-lived bidirectional stream, which
// the file-fed tests in run_clangd_tests.mjs cannot.
//
// Usage:
//   node --experimental-wasm-type-reflection --experimental-wasi-unstable-preview1 wasi-tests/run_clangd_stream_tests.mjs [name-substring ...]
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { start, writeCompile } from './clangd_stream_harness.mjs';
import { at, uri, frame, cppFlags, applyEdits } from './clangd_harness.mjs';

const check = (cond, msg) => { if (!cond) throw new Error(msg); };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errorsOf = (d) => (d ?? []).filter((x) => x.severity === 1);
/** Waits for the publishDiagnostics that actually matches `pred`, skipping any stale
 * republish from in-flight async work that races ahead of the edit being waited on. */
const diagsWhen = (c, name, from, pred) =>
  c.waitNote((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri(name) && pred(m.params.diagnostics), 60000, from)
    .then((m) => m.params.diagnostics);
const hoverText = (h) => (typeof h?.contents === 'string' ? h.contents : h?.contents?.value ?? '');

/** Starts clangd, runs fn(client), always kills the child; returns fn's result. */
async function withClient(opts, fn) {
  const c = await start(opts);
  try { return await fn(c); } finally { if (!c.closed) c.child.kill(); }
}
const one = (name, text, extra = {}) => ({ files: { [name]: text }, compile: [{ file: name, flags: cppFlags }], ...extra });

test('stream: request/reply and diagnostics interleave on live pipes', () => {
  const src = 'int add(int a, int b) { return a + b; }\nint main() { return add(1, nope); }\n';
  return withClient(one('a.cpp', src), async (c) => {
    await c.init();
    const n = c.notes.length;
    c.open('a.cpp', src);
    const d = await c.diags('a.cpp', n);
    check(errorsOf(d).length === 1, JSON.stringify(d));
    const h = await c.request('textDocument/hover', { textDocument: { uri: uri('a.cpp') }, position: at(src, 'add', 1) });
    check(/int add/.test(hoverText(h)), hoverText(h));
    check((await c.shutdown()) === 0, `exit ${c.exitCode}`);
  });
});

test('stream: frames split into tiny chunks across writes', () => {
  const src = 'int widget_count = 3;\n';
  return withClient(one('a.cpp', src), async (c) => {
    await c.init();
    c.open('a.cpp', src);
    await c.diags('a.cpp', 0);
    const raw = c.child.stdin;
    let tail = Promise.resolve(); // serialize: auto-replies to server requests also go through write()
    c.write = (obj) => {
      const b = Buffer.from(frame(obj));
      tail = tail.then(async () => { for (let i = 0; i < b.length; i += 5) { raw.write(b.subarray(i, i + 5)); await sleep(3); } });
    };
    const h = await c.request('textDocument/hover', { textDocument: { uri: uri('a.cpp') }, position: at(src, 'widget_count', 2) });
    check(/widget_count/.test(hoverText(h)), hoverText(h));
  });
});

test('stream: a 1 MB document opens and answers', () => {
  let src = '';
  for (let i = 0; src.length < 1_000_000; i++) src += `int big_function_${i}(int v) { return v + ${i}; }\n`;
  src += 'int last_one = 1;\n';
  return withClient(one('a.cpp', src), async (c) => {
    await c.init();
    c.open('a.cpp', src);
    const d = await c.diags('a.cpp', 0);
    check(errorsOf(d).length === 0, JSON.stringify(d).slice(0, 300));
    const h = await c.request('textDocument/hover', { textDocument: { uri: uri('a.cpp') }, position: at(src, 'last_one', 2) });
    check(/last_one/.test(hoverText(h)), hoverText(h));
  });
});

test('stream: 60 pipelined requests are all answered', () => {
  const src = 'int target_name = 1;\n';
  return withClient(one('a.cpp', src), async (c) => {
    await c.init();
    c.open('a.cpp', src);
    await c.diags('a.cpp', 0);
    const all = await Promise.all(Array.from({ length: 60 }, () => c.request('textDocument/hover', { textDocument: { uri: uri('a.cpp') }, position: at(src, 'target_name', 2) })));
    check(all.every((h) => /target_name/.test(hoverText(h))), 'every hover should answer');
  });
});

test('stream: exit without shutdown exits with code 1', () => withClient(one('a.cpp', 'int x;\n'), async (c) => {
  await c.init();
  c.notify('exit', undefined);
  check((await c.exited) === 1, `exit code ${c.exitCode}`);
}));

test('stream: closing stdin (host crash) ends clangd instead of hanging', () => withClient(one('a.cpp', 'int x;\n'), async (c) => {
  await c.init();
  c.child.stdin.end();
  const r = await Promise.race([c.exited, sleep(20000).then(() => 'hung')]);
  check(r !== 'hung', 'clangd did not exit after stdin EOF');
}));

test('stream: malformed JSON body is skipped, session continues', () => {
  const src = 'int survivor = 1;\n';
  return withClient(one('a.cpp', src), async (c) => {
    await c.init();
    c.open('a.cpp', src);
    await c.diags('a.cpp', 0);
    const junk = '{this is not json';
    c.writeRaw(Buffer.from(`Content-Length: ${junk.length}\r\n\r\n${junk}`));
    const h = await c.request('textDocument/hover', { textDocument: { uri: uri('a.cpp') }, position: at(src, 'survivor', 2) });
    check(/survivor/.test(hoverText(h)), hoverText(h));
  });
});

test('stream: call hierarchy incoming/outgoing chain', () => {
  const src = 'int leaf() { return 1; }\nint middle() { return leaf(); }\nint top() { return middle(); }\n';
  return withClient(one('a.cpp', src), async (c) => {
    await c.init();
    c.open('a.cpp', src);
    await c.diags('a.cpp', 0);
    const prep = await c.request('textDocument/prepareCallHierarchy', { textDocument: { uri: uri('a.cpp') }, position: at(src, 'middle', 1) });
    const inc = await c.request('callHierarchy/incomingCalls', { item: prep[0] });
    const out = await c.request('callHierarchy/outgoingCalls', { item: prep[0] });
    check(inc.some((x) => x.from.name === 'top'), JSON.stringify(inc));
    check(out.some((x) => x.to.name === 'leaf'), JSON.stringify(out));
  });
});

test('stream: type hierarchy subtypes/supertypes chain', () => {
  const src = 'struct Base { virtual void f(); };\nstruct Mid : Base { void f() override; };\nstruct Leaf : Mid { void f() override; };\n';
  return withClient(one('a.cpp', src), async (c) => {
    await c.init();
    c.open('a.cpp', src);
    await c.diags('a.cpp', 0);
    const prep = await c.request('textDocument/prepareTypeHierarchy', { textDocument: { uri: uri('a.cpp') }, position: at(src, 'Mid', 1) });
    const sub = await c.request('typeHierarchy/subtypes', { item: prep[0] });
    const sup = await c.request('typeHierarchy/supertypes', { item: prep[0] });
    check(sub.some((x) => x.name === 'Leaf'), JSON.stringify(sub));
    check(sup.some((x) => x.name === 'Base'), JSON.stringify(sup));
  });
});

test('stream: implementation request finds overrides', () => {
  const src = 'struct Base { virtual void run() = 0; };\nstruct Impl : Base { void run() override {} };\n';
  return withClient(one('a.cpp', src), async (c) => {
    await c.init();
    c.open('a.cpp', src);
    await c.diags('a.cpp', 0);
    const r = await c.request('textDocument/implementation', { textDocument: { uri: uri('a.cpp') }, position: at(src, 'run', 1) });
    check(r?.some((x) => x.range.start.line === 1), JSON.stringify(r));
  });
});

test('stream: executeCommand clangd.applyFix sends workspace/applyEdit', () => {
  const src = 'int main() {\n  int x = 1\n  return x;\n}\n';
  return withClient(one('a.cpp', src), async (c) => {
    await c.init();
    c.open('a.cpp', src);
    const d = await c.diags('a.cpp', 0);
    const actions = await c.request('textDocument/codeAction', { textDocument: { uri: uri('a.cpp') }, range: d[0].range, context: { diagnostics: d } });
    const fix = actions.find((a) => a.command === 'clangd.applyFix' || a.command?.command === 'clangd.applyFix');
    check(fix, JSON.stringify(actions));
    await c.request('workspace/executeCommand', { command: 'clangd.applyFix', arguments: fix.arguments ?? fix.command.arguments });
    const apply = c.serverRequests.find((r) => r.method === 'workspace/applyEdit');
    check(apply, 'server never sent workspace/applyEdit');
    const edited = applyEdits(src, apply.params.edit.changes[uri('a.cpp')]);
    check(/int x = 1;/.test(edited), edited);
  });
});

test('stream: compile_commands.json rewritten on disk takes effect after the 5 s revalidate window', () => {
  const src = '#ifndef NEEDS_FLAG\n#error need flag\n#endif\nint ok;\n';
  return withClient(one('a.cpp', src), async (c) => {
    await c.init();
    let n = c.notes.length;
    c.open('a.cpp', src);
    check(errorsOf(await c.diags('a.cpp', n)).length === 1, 'expected #error before the flag');
    await writeCompile(c.dir, [{ file: 'a.cpp', flags: [...cppFlags, '-DNEEDS_FLAG'] }]);
    await sleep(5500); // clangd re-stats compile_commands.json at most every 5 s (RevalidateAfter)
    c.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: uri('compile_commands.json'), type: 2 }] });
    n = c.notes.length;
    c.notify('textDocument/didChange', { textDocument: { uri: uri('a.cpp'), version: 2 }, contentChanges: [{ text: src + '\n' }] });
    await diagsWhen(c, 'a.cpp', n, (d) => errorsOf(d).length === 0);
  });
});

test('stream: workspace/didChangeConfiguration injects compile flags (the vscwClang path)', () => {
  const src = '#ifndef INJECTED\n#error need injected flag\n#endif\nint ok;\n';
  return withClient({ files: { 'a.cpp': src } }, async (c) => {
    await c.init();
    let n = c.notes.length;
    c.open('a.cpp', src);
    check(errorsOf(await c.diags('a.cpp', n)).length >= 1, 'expected an error with default fallback flags');
    n = c.notes.length;
    c.notify('workspace/didChangeConfiguration', { settings: { compilationDatabaseChanges: { '/work/a.cpp': { workingDirectory: '/work', compilationCommand: ['clang', ...cppFlags, '-DINJECTED', '/work/a.cpp'] } } } });
    await diagsWhen(c, 'a.cpp', n, (d) => errorsOf(d).length === 0);
  });
});

test('stream: header edited on disk invalidates the preamble', () => {
  const main = '#include "api.h"\nint main() { return api(1); }\n';
  return withClient({ ...one('a.cpp', main), files: { 'a.cpp': main, 'api.h': 'int api(int);\n' } }, async (c) => {
    await c.init();
    let n = c.notes.length;
    c.open('a.cpp', main);
    check(errorsOf(await c.diags('a.cpp', n)).length === 0, 'clean at first');
    await sleep(1100); // mtime granularity
    await writeFile(path.join(c.dir, 'api.h'), 'int api(int, int);\n');
    c.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: uri('api.h'), type: 2 }] });
    n = c.notes.length;
    c.notify('textDocument/didChange', { textDocument: { uri: uri('a.cpp'), version: 2 }, contentChanges: [{ text: main + '\n' }] });
    await diagsWhen(c, 'a.cpp', n, (d) => errorsOf(d).length === 1);
  });
});

test('stream: 25 open/close cycles of the same file stay healthy', () => {
  const src = '#include <vector>\nint cycle_symbol = 1;\n';
  return withClient(one('a.cpp', src), async (c) => {
    await c.init();
    for (let i = 0; i < 25; i++) {
      const n = c.notes.length;
      c.open('a.cpp', src, 'cpp', i + 1);
      await c.diags('a.cpp', n);
      c.notify('textDocument/didClose', { textDocument: { uri: uri('a.cpp') } });
    }
    const w = await c.request('workspace/symbol', { query: 'cycle_symbol' });
    check(w.length === 1, JSON.stringify(w));
  });
});

test('stream: shutdown after heavy use exits 0', () => {
  const src = '#include <vector>\n#include <map>\n#include <string>\nstd::map<std::string, std::vector<int>> table;\n';
  return withClient(one('a.cpp', src), async (c) => {
    await c.init();
    c.open('a.cpp', src);
    await c.diags('a.cpp', 0);
    for (let i = 0; i < 10; i++) await c.request('textDocument/completion', { textDocument: { uri: uri('a.cpp') }, position: at(src, 'table', 0) });
    check((await c.shutdown()) === 0, `exit ${c.exitCode}`);
  });
});

const filters = process.argv.slice(2);
const selected = tests.filter((t) => !filters.length || filters.some((f) => t.name.includes(f)));
let failed = 0;
const t0 = Date.now();
for (const { name, fn } of selected) {
  const start0 = Date.now();
  try { await fn(); console.log(`ok   ${name} (${Date.now() - start0} ms)`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n       ${String(e.message ?? e).split('\n').join('\n       ').slice(0, 1500)}`); }
}
console.log(`\n${selected.length - failed}/${selected.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(failed ? 'SMOKETEST FAILED' : 'SMOKETEST PASSED');
process.exit(failed ? 1 : 0);
