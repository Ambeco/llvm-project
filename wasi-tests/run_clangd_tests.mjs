// LSP feature tests for the single-threaded clangd.wasm (build-single-threaded,
// `clangd -sync -background-index=false`) on a stock node:wasi host. Each test
// is one clangd session; see clangd_harness.mjs.
//
// Usage:
//   node --experimental-wasm-type-reflection --experimental-wasi-unstable-preview1 wasi-tests/run_clangd_tests.mjs [name-substring ...]
// With no arguments every test runs. Set CLANGD_WASM to test another binary.
import {
  session, open, close, change, req, td, uri, at, nth, cppFlags, cFlags, diagsFor, allDiagsFor, applyEdits,
} from './clangd_harness.mjs';

const check = (cond, msg) => { if (!cond) throw new Error(msg); };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** One-file session compiled with the libc++ flags (plus extra), returns the session. */
async function one(name, text, steps, { flags = [], languageId = 'cpp', files = {}, compile = [], args = [] } = {}) {
  const base = languageId === 'c' ? cFlags : cppFlags;
  const s = await session({
    files: { [name]: text, ...files },
    compile: [{ file: name, flags: [...base, ...flags] }, ...compile],
    steps: [open(name, text, languageId), ...steps], args,
  });
  check(s.exitCode === 0, `clangd exit code ${s.exitCode} ${s.trap ?? ''}\n${s.stderr.slice(-1500)}`);
  return s;
}
const labels = (r) => (r?.items ?? r ?? []).map((i) => (i.filterText ?? i.label).trim());
const errorsOf = (d) => (d ?? []).filter((x) => x.severity === 1);
const hoverText = (h) => (typeof h?.contents === 'string' ? h.contents : h?.contents?.value ?? '');
const uris = (locs) => (locs ?? []).map((l) => l.uri ?? l.targetUri);

// ---- protocol / lifecycle ----
test('init: advertises the core capabilities', async () => {
  const s = await one('a.cpp', 'int x;\n', []);
  const c = s.res.init.capabilities;
  for (const k of ['hoverProvider', 'completionProvider', 'definitionProvider', 'referencesProvider', 'renameProvider',
    'documentSymbolProvider', 'workspaceSymbolProvider', 'codeActionProvider', 'signatureHelpProvider',
    'documentFormattingProvider', 'semanticTokensProvider', 'inlayHintProvider', 'foldingRangeProvider'])
    check(c[k], `missing capability ${k}`);
  check(s.res.init.serverInfo.version.includes('wasm32'), 'serverInfo should name the wasm target');
});
test('proto: unknown method returns MethodNotFound, session survives', async () => {
  const s = await one('a.cpp', 'int x;\n', [req('bogus', 'textDocument/doesNotExist', td('a.cpp')), req('h', 'textDocument/hover', td('a.cpp', { position: at('int x;', 'x') }))]);
  check(s.errors.bogus?.code === -32601, `expected -32601, got ${JSON.stringify(s.errors.bogus)}`);
  check(s.res.h, 'hover after the error should still work');
});
test('lifecycle: didClose clears diagnostics', async () => {
  const s = await one('a.cpp', 'int main(){ return nope; }\n', [close('a.cpp')]);
  check(errorsOf(allDiagsFor(s, 'a.cpp')[0]).length === 1, 'first publish should carry the error');
  check((diagsFor(s, 'a.cpp') ?? ['x']).length === 0, 'last publish should be empty after close');
});
test('lifecycle: memory usage request answers', async () => {
  const s = await one('a.cpp', 'int x;\n', [req('m', '$/memoryUsage', {})]);
  check(s.res.m && typeof s.res.m === 'object', `no memory tree: ${JSON.stringify(s.res.m)}`);
});

// ---- diagnostics ----
test('diag: errors reported with codes and ranges', async () => {
  const s = await one('a.cpp', 'int main() { int x = "s"; return y; }\n', []);
  const d = diagsFor(s, 'a.cpp');
  check(d.length === 2, `expected 2 diagnostics, got ${d.length}`);
  check(d.some((x) => x.code === 'init_conversion_failed') && d.some((x) => x.code === 'undeclared_var_use'), 'expected clang diagnostic codes');
  check(d.every((x) => x.source === 'clang' && x.severity === 1), 'expected clang errors');
});
test('diag: -Wall warnings carry severity 2', async () => {
  const s = await one('a.cpp', 'int main() { int unused; return 0; }\n', [], { flags: ['-Wall'] });
  const d = diagsFor(s, 'a.cpp');
  check(d.some((x) => x.severity === 2 && /unused/.test(x.message)), `expected unused warning: ${JSON.stringify(d)}`);
});
test('diag: missing include is reported', async () => {
  const s = await one('a.cpp', '#include "does_not_exist.h"\nint x;\n', []);
  check(diagsFor(s, 'a.cpp').some((x) => /does_not_exist\.h' file not found/.test(x.message)), JSON.stringify(diagsFor(s, 'a.cpp')));
});
test('diag: libc++ headers parse cleanly', async () => {
  const s = await one('a.cpp', '#include <vector>\n#include <string>\n#include <map>\n#include <algorithm>\nint main() { std::vector<std::string> v; v.push_back("a"); std::map<int, int> m; m[1] = 2; std::sort(v.begin(), v.end()); return (int)v.size(); }\n', []);
  check(errorsOf(diagsFor(s, 'a.cpp')).length === 0, JSON.stringify(diagsFor(s, 'a.cpp')));
});
test('diag: C file with <stdio.h>', async () => {
  const s = await one('a.c', '#include <stdio.h>\nint main(void) { printf("hi\\n"); return undefined_thing; }\n', [], { languageId: 'c' });
  const d = errorsOf(diagsFor(s, 'a.c'));
  check(d.length === 1 && /undefined_thing/.test(d[0].message), JSON.stringify(d));
});
test('diag: compile_commands -D flag takes effect', async () => {
  const src = '#ifndef NEEDS_FOO\n#error need NEEDS_FOO\n#endif\nint ok;\n';
  const without = await one('a.cpp', src, []);
  const withFlag = await one('a.cpp', src, [], { flags: ['-DNEEDS_FOO'] });
  check(errorsOf(diagsFor(without, 'a.cpp')).length === 1, 'expected #error without the flag');
  check(errorsOf(diagsFor(withFlag, 'a.cpp')).length === 0, 'expected no error with the flag');
});
test('diag: didChange re-parses (bug fixed in later version)', async () => {
  const bad = '#include <vector>\nint main() { return nope; }\n';
  const good = '#include <vector>\nint main() { return 0; }\n';
  const s = await one('a.cpp', bad, [change('a.cpp', 2, good)]);
  const all = allDiagsFor(s, 'a.cpp');
  check(errorsOf(all[0]).length === 1, 'v1 should have an error');
  check(errorsOf(all.at(-1)).length === 0, `v2 should have no errors, got ${JSON.stringify(all.at(-1))}`);
});
test('diag: didChange introduces an error (preamble reuse)', async () => {
  const good = '#include <vector>\nint main() { return 0; }\n';
  const bad = '#include <vector>\nint main() { return nope; }\n';
  const s = await one('a.cpp', good, [change('a.cpp', 2, bad)]);
  check(errorsOf(diagsFor(s, 'a.cpp')).length === 1, JSON.stringify(diagsFor(s, 'a.cpp')));
});
test('diag: fix-it code action for a missing semicolon', async () => {
  const src = 'int main() {\n  int x = 1\n  return x;\n}\n';
  const probe = await one('a.cpp', src, []);
  const d = diagsFor(probe, 'a.cpp');
  check(d.length >= 1, 'expected a diagnostic to fix');
  const s = await one('a.cpp', src, [req('ca', 'textDocument/codeAction', td('a.cpp', { range: d[0].range, context: { diagnostics: d } }))]);
  const fix = (s.res.ca ?? []).find((a) => a.command === 'clangd.applyFix' || a.command?.command === 'clangd.applyFix' || a.edit);
  check(fix, `no fix-it action: ${JSON.stringify(s.res.ca)}`);
  const changes = fix.edit?.changes ?? fix.arguments?.[0]?.changes ?? fix.command.arguments[0].changes;
  const fixed = applyEdits(src, changes[uri('a.cpp')]);
  check(/int x = 1;/.test(fixed), `fix did not add ';': ${JSON.stringify(fixed)}`);
});
test('config: .clangd Add flag and Suppress', async () => {
  const src = '#ifndef FROM_CLANGD_FILE\n#error need flag\n#endif\nint main() { return nope; }\n';
  const s = await one('a.cpp', src, [], { files: { '.clangd': 'CompileFlags:\n  Add: [-DFROM_CLANGD_FILE]\nDiagnostics:\n  Suppress: undeclared_var_use\n' } });
  check(diagsFor(s, 'a.cpp').length === 0, `expected .clangd to apply: ${JSON.stringify(diagsFor(s, 'a.cpp'))}`);
});

// ---- completion / signature help ----
test('completion: struct members after "."', async () => {
  const src = 'struct Widget { int width; int height; void resize(int w); };\nint main() {\n  Widget w;\n  w.\n}\n';
  const s = await one('a.cpp', src, [req('c', 'textDocument/completion', td('a.cpp', { position: { line: 3, character: 4 } }))]);
  const l = labels(s.res.c);
  for (const want of ['width', 'height', 'resize']) check(l.includes(want), `missing ${want} in ${l.slice(0, 15)}`);
});
test('completion: identifiers in scope', async () => {
  const src = 'int global_counter;\nint other_value;\nint main() {\n  return glo\n}\n';
  const s = await one('a.cpp', src, [req('c', 'textDocument/completion', td('a.cpp', { position: at(src, 'glo\n', 3) }))]);
  check(labels(s.res.c).includes('global_counter'), labels(s.res.c).slice(0, 10).join());
  check(!labels(s.res.c).includes('other_value'), 'fuzzy match should rank/filter by prefix');
});
test('completion: std::vector members from libc++', async () => {
  const src = '#include <vector>\nint main() {\n  std::vector<int> v;\n  v.push\n}\n';
  const s = await one('a.cpp', src, [req('c', 'textDocument/completion', td('a.cpp', { position: at(src, 'push\n', 4) }))]);
  check(labels(s.res.c).some((x) => x.startsWith('push_back')), labels(s.res.c).slice(0, 10).join());
});
test('completion: std:: namespace members', async () => {
  const src = '#include <string>\nint main() {\n  std::str\n}\n';
  const s = await one('a.cpp', src, [req('c', 'textDocument/completion', td('a.cpp', { position: at(src, 'str\n', 3) }))]);
  check(labels(s.res.c).includes('string'), labels(s.res.c).slice(0, 10).join());
});
test('completion: member of a class from a local header', async () => {
  const hdr = 'struct Config { int verbosity; bool enabled; };\n';
  const src = '#include "config.h"\nint main() {\n  Config c;\n  c.\n}\n';
  const s = await one('a.cpp', src, [req('c', 'textDocument/completion', td('a.cpp', { position: { line: 3, character: 4 } }))], { files: { 'config.h': hdr } });
  check(labels(s.res.c).includes('verbosity') && labels(s.res.c).includes('enabled'), labels(s.res.c).join());
});
test('completion: C file', async () => {
  const src = 'struct point { int x; int y; };\nint main(void) {\n  struct point p;\n  p.\n}\n';
  const s = await one('a.c', src, [req('c', 'textDocument/completion', td('a.c', { position: { line: 3, character: 4 } }))], { languageId: 'c' });
  check(labels(s.res.c).includes('x') && labels(s.res.c).includes('y'), labels(s.res.c).join());
});
test('completion: after an emoji on the same line (UTF-16 offsets)', async () => {
  const src = 'struct S { int field_one; };\nint main() { const char* e = "😀"; S s; s.fie\n}\n';
  const s = await one('a.cpp', src, [req('c', 'textDocument/completion', td('a.cpp', { position: at(src, 'fie\n', 3) }))]);
  check(labels(s.res.c).includes('field_one'), labels(s.res.c).join());
});
test('signatureHelp: active parameter tracks the comma', async () => {
  const src = 'int add(int a, int b) { return a + b; }\nint main() {\n  return add(1, \n}\n';
  const s = await one('a.cpp', src, [req('sh', 'textDocument/signatureHelp', td('a.cpp', { position: at(src, 'add(1, ', 7) }))]);
  const sig = s.res.sh?.signatures?.[0];
  check(sig && /add\(int a, int b\)/.test(sig.label), JSON.stringify(s.res.sh));
  check(s.res.sh.activeParameter === 1, `activeParameter ${s.res.sh.activeParameter}`);
});

// ---- hover ----
test('hover: function call shows signature', async () => {
  const src = 'int add(int a, int b) { return a + b; }\nint main() { return add(1, 2); }\n';
  const s = await one('a.cpp', src, [req('h', 'textDocument/hover', td('a.cpp', { position: nth(src, 'add', 1, 1) }))]);
  check(/int add\(int a, int b\)/.test(hoverText(s.res.h)), hoverText(s.res.h));
});
test('hover: doc comment is included', async () => {
  const src = '/// Adds two numbers together.\nint add(int a, int b) { return a + b; }\nint main() { return add(1, 2); }\n';
  const s = await one('a.cpp', src, [req('h', 'textDocument/hover', td('a.cpp', { position: nth(src, 'add', 1, 1) }))]);
  check(/Adds two numbers together/.test(hoverText(s.res.h)), hoverText(s.res.h));
});
test('hover: std::vector variable type', async () => {
  const src = '#include <vector>\nint main() {\n  std::vector<int> items;\n  return (int)items.size();\n}\n';
  const s = await one('a.cpp', src, [req('h', 'textDocument/hover', td('a.cpp', { position: nth(src, 'items', 1, 1) }))]);
  check(/vector<int>/.test(hoverText(s.res.h)), hoverText(s.res.h));
});
test('hover: auto deduces the type', async () => {
  const src = 'int main() {\n  auto value = 42;\n  return value;\n}\n';
  const s = await one('a.cpp', src, [req('h', 'textDocument/hover', td('a.cpp', { position: at(src, 'auto', 1) }))]);
  check(/int/.test(hoverText(s.res.h)), hoverText(s.res.h));
});
test('hover: after emoji and non-ASCII identifier', async () => {
  const src = 'int café = 1;\nconst char* e = "😀😀"; int use = café;\n';
  const s = await one('a.cpp', src, [req('h', 'textDocument/hover', td('a.cpp', { position: nth(src, 'café', 1, 1) }))]);
  check(/café/.test(hoverText(s.res.h)), hoverText(s.res.h));
});

// ---- navigation ----
const nav = 'struct Shape { int sides; };\nint area(Shape s);\nint area(Shape s) { return s.sides; }\nint main() {\n  Shape sh;\n  return area(sh);\n}\n';
test('nav: definition of a call lands on the definition', async () => {
  const s = await one('a.cpp', nav, [req('d', 'textDocument/definition', td('a.cpp', { position: nth(nav, 'area', 2, 1) }))]);
  check(s.res.d?.[0]?.range.start.line === 2, JSON.stringify(s.res.d));
});
test('nav: declaration of a call lands on the declaration', async () => {
  const s = await one('a.cpp', nav, [req('d', 'textDocument/declaration', td('a.cpp', { position: nth(nav, 'area', 2, 1) }))]);
  check(s.res.d?.[0]?.range.start.line === 1, JSON.stringify(s.res.d));
});
test('nav: typeDefinition of a variable', async () => {
  const s = await one('a.cpp', nav, [req('d', 'textDocument/typeDefinition', td('a.cpp', { position: nth(nav, 'sh', 0, 0) }))]);
  check(s.res.d?.[0]?.range.start.line === 0, JSON.stringify(s.res.d));
});
test('nav: definition into a local header', async () => {
  const src = '#include "util.h"\nint main() { return helper(1); }\n';
  const s = await one('a.cpp', src, [req('d', 'textDocument/definition', td('a.cpp', { position: at(src, 'helper', 1) }))], { files: { 'util.h': 'inline int helper(int v) { return v * 2; }\n' } });
  check(uris(s.res.d)[0] === uri('util.h'), JSON.stringify(s.res.d));
});
test('nav: definition into libc++ headers on the sysroot', async () => {
  const src = '#include <vector>\nint main() { std::vector<int> v; v.clear(); return 0; }\n';
  const s = await one('a.cpp', src, [req('d', 'textDocument/definition', td('a.cpp', { position: at(src, 'clear', 1) }))]);
  check(uris(s.res.d)[0]?.startsWith('file:///sysroot/include/'), JSON.stringify(s.res.d));
});
test('nav: references within a file', async () => {
  const s = await one('a.cpp', nav, [req('r', 'textDocument/references', td('a.cpp', { position: nth(nav, 'area', 2, 1), context: { includeDeclaration: true } }))]);
  check(s.res.r?.length === 3, `expected decl + def + call, got ${JSON.stringify(s.res.r)}`);
});
test('nav: documentHighlight marks reads and writes', async () => {
  const src = 'int main() {\n  int n = 0;\n  n = n + 1;\n  return n;\n}\n';
  const s = await one('a.cpp', src, [req('h', 'textDocument/documentHighlight', td('a.cpp', { position: at(src, 'n = 0') }))]);
  check(s.res.h?.length >= 4, JSON.stringify(s.res.h));
  check(s.res.h.some((x) => x.kind === 3) && s.res.h.some((x) => x.kind === 2), 'expected both Read(2) and Write(3) highlights');
});
test('nav: prepareCallHierarchy names the function', async () => {
  const s = await one('a.cpp', nav, [req('c', 'textDocument/prepareCallHierarchy', td('a.cpp', { position: nth(nav, 'area', 2, 1) }))]);
  check(s.res.c?.[0]?.name === 'area', JSON.stringify(s.res.c));
});
test('nav: prepareTypeHierarchy names the class', async () => {
  const src = 'struct Base {};\nstruct Derived : Base {};\n';
  const s = await one('a.cpp', src, [req('t', 'textDocument/prepareTypeHierarchy', td('a.cpp', { position: at(src, 'Derived', 1) }))]);
  check(s.res.t?.[0]?.name === 'Derived', JSON.stringify(s.res.t));
});
test('nav: switchSourceHeader finds the header', async () => {
  const s = await one('foo.cpp', '#include "foo.h"\nvoid foo() {}\n', [req('sw', 'textDocument/switchSourceHeader', { uri: uri('foo.cpp') })], { files: { 'foo.h': 'void foo();\n' } });
  check(s.res.sw === uri('foo.h'), JSON.stringify(s.res.sw));
});

// ---- rename ----
test('rename: prepareRename and in-file rename', async () => {
  const src = 'int counter = 0;\nint bump() { return ++counter; }\nint peek() { return counter; }\n';
  const pos = at(src, 'counter', 1);
  const s = await one('a.cpp', src, [req('p', 'textDocument/prepareRename', td('a.cpp', { position: pos })), req('r', 'textDocument/rename', td('a.cpp', { position: pos, newName: 'tally' }))]);
  check(s.res.p, 'prepareRename should return a range');
  const out = applyEdits(src, s.res.r.changes[uri('a.cpp')]);
  check(out === src.replaceAll('counter', 'tally'), out);
});
test('rename: across a header and source (both open)', async () => {
  const hdr = 'int compute(int v);\n';
  const src = '#include "api.h"\nint compute(int v) { return v; }\nint main() { return compute(3); }\n';
  const s = await session({
    files: { 'api.h': hdr, 'a.cpp': src },
    compile: [{ file: 'a.cpp', flags: cppFlags }],
    steps: [open('api.h', hdr), open('a.cpp', src), req('r', 'textDocument/rename', td('a.cpp', { position: at(src, 'compute', 1), newName: 'evaluate' }))],
  });
  check(s.exitCode === 0, `exit ${s.exitCode}`);
  const ch = s.res.r?.changes ?? {};
  check(ch[uri('api.h')] && ch[uri('a.cpp')], `expected edits in both files: ${JSON.stringify(s.res.r)} ${JSON.stringify(s.errors)}`);
  check(applyEdits(hdr, ch[uri('api.h')]) === 'int evaluate(int v);\n', 'header edit');
});
test('rename: refuses to rename a std symbol', async () => {
  const src = '#include <vector>\nint main() { std::vector<int> v; v.clear(); }\n';
  const s = await one('a.cpp', src, [req('r', 'textDocument/rename', td('a.cpp', { position: at(src, 'clear', 1), newName: 'wipe' }))]);
  check(s.errors.r, `expected an error: ${JSON.stringify(s.res.r)}`);
});

// ---- symbols ----
test('symbols: documentSymbol is hierarchical', async () => {
  const src = 'class Animal {\npublic:\n  void speak();\n  int legs;\n};\nvoid Animal::speak() {}\nnamespace zoo { int count; }\n';
  const s = await one('a.cpp', src, [req('ds', 'textDocument/documentSymbol', td('a.cpp'))]);
  const names = s.res.ds.map((x) => x.name);
  check(names.includes('Animal') && names.includes('zoo'), names.join());
  const animal = s.res.ds.find((x) => x.name === 'Animal');
  check(animal.children?.some((c) => c.name === 'speak') && animal.children.some((c) => c.name === 'legs'), JSON.stringify(animal.children));
});
test('symbols: workspace/symbol over open files', async () => {
  const src = 'int find_me_please() { return 1; }\n';
  const s = await one('a.cpp', src, [req('w', 'workspace/symbol', { query: 'find_me' })]);
  check(s.res.w?.some((x) => x.name === 'find_me_please'), JSON.stringify(s.res.w));
});

// ---- formatting / syntactic features ----
test('format: default (LLVM) style', async () => {
  const src = 'int main(){int x=1;return x;}\n';
  const s = await one('a.cpp', src, [req('f', 'textDocument/formatting', td('a.cpp', { options: { tabSize: 2, insertSpaces: true } }))]);
  check(applyEdits(src, s.res.f) === 'int main() {\n  int x = 1;\n  return x;\n}\n', JSON.stringify(applyEdits(src, s.res.f)));
});
test('format: honors a .clang-format file', async () => {
  const src = 'int main(){int x=1;return x;}\n';
  const s = await one('a.cpp', src, [req('f', 'textDocument/formatting', td('a.cpp', { options: { tabSize: 2, insertSpaces: true } }))], { files: { '.clang-format': 'BasedOnStyle: LLVM\nIndentWidth: 8\n' } });
  check(applyEdits(src, s.res.f).includes('\n        int x = 1;'), JSON.stringify(applyEdits(src, s.res.f)));
});
test('format: range formatting touches only the range', async () => {
  const src = 'int  a=1;\nint  b=2;\n';
  const s = await one('a.cpp', src, [req('f', 'textDocument/rangeFormatting', td('a.cpp', { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 9 } }, options: { tabSize: 2, insertSpaces: true } }))]);
  check(applyEdits(src, s.res.f) === 'int  a=1;\nint b = 2;\n', JSON.stringify(applyEdits(src, s.res.f)));
});
test('semanticTokens: full response is well-formed', async () => {
  const src = 'struct S { int field; };\nint main() { S s; return s.field; }\n';
  const s = await one('a.cpp', src, [req('t', 'textDocument/semanticTokens/full', td('a.cpp'))]);
  check(s.res.t?.data?.length > 0 && s.res.t.data.length % 5 === 0, JSON.stringify(s.res.t)?.slice(0, 200));
});
test('inlayHints: parameter names and deduced types', async () => {
  const src = 'int add(int first, int second) { return first + second; }\nint main() {\n  auto total = add(1, 2);\n  return total;\n}\n';
  const s = await one('a.cpp', src, [req('i', 'textDocument/inlayHint', td('a.cpp', { range: { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } } }))]);
  const l = (s.res.i ?? []).map((h) => (typeof h.label === 'string' ? h.label : h.label.map((p) => p.value).join('')));
  check(l.includes('first:') && l.includes('second:'), l.join('|'));
  check(l.some((x) => /int/.test(x)), `expected deduced int hint: ${l.join('|')}`);
});
test('foldingRange: function bodies fold', async () => {
  const src = 'int main() {\n  int x = 1;\n  return x;\n}\n';
  const s = await one('a.cpp', src, [req('f', 'textDocument/foldingRange', td('a.cpp'))]);
  check(s.res.f?.some((r) => r.startLine === 0 && r.endLine >= 2), JSON.stringify(s.res.f));
});
test('selectionRange: ranges nest outward', async () => {
  const src = 'int main() { return (1 + 2) * 3; }\n';
  const s = await one('a.cpp', src, [req('sr', 'textDocument/selectionRange', td('a.cpp', { positions: [at(src, '1 + 2')] }))]);
  check(s.res.sr?.[0]?.parent, JSON.stringify(s.res.sr));
});
test('documentLink: #include links resolve', async () => {
  const src = '#include "util.h"\nint x;\n';
  const s = await one('a.cpp', src, [req('l', 'textDocument/documentLink', td('a.cpp'))], { files: { 'util.h': '// h\n' } });
  check(s.res.l?.some((x) => x.target === uri('util.h')), JSON.stringify(s.res.l));
});
test('codeAction: refactorings offered on a selection (no diagnostics)', async () => {
  const src = 'int main() {\n  int r = (1 + 2) * 3;\n  return r;\n}\n';
  const s = await one('a.cpp', src, [req('ca', 'textDocument/codeAction', td('a.cpp', { range: { start: at(src, '1 + 2'), end: at(src, '1 + 2', 5) }, context: { diagnostics: [] } }))]);
  check((s.res.ca ?? []).length > 0, `expected tweaks, got ${JSON.stringify(s.res.ca)}`);
});

// ---- cross-file / sweep ----
test('sweep: header + source, definition resolves into closed file', async () => {
  const s = await session({
    files: { 'lib.cpp': 'int lib_function_xyz(int a) { return a; }\n', 'main.cpp': 'int lib_function_xyz(int);\nint main() { return lib_function_xyz(1); }\n' },
    compile: [{ file: 'lib.cpp', flags: cppFlags }, { file: 'main.cpp', flags: cppFlags }],
    steps: [open('lib.cpp', 'int lib_function_xyz(int a) { return a; }\n'), close('lib.cpp'),
      open('main.cpp', 'int lib_function_xyz(int);\nint main() { return lib_function_xyz(1); }\n'),
      req('d', 'textDocument/definition', td('main.cpp', { position: nth('int lib_function_xyz(int);\nint main() { return lib_function_xyz(1); }\n', 'lib_function_xyz', 1, 1) }))],
  });
  check(uris(s.res.d)[0] === uri('lib.cpp'), JSON.stringify(s.res.d));
});
test('sweep: 25 generated files all become searchable', async () => {
  const files = {}, steps = [], compile = [];
  for (let i = 0; i < 25; i++) {
    const t = `int sweepfn_${i}(int v) { return v + ${i}; }\n`;
    files[`f${i}.cpp`] = t; compile.push({ file: `f${i}.cpp`, flags: cppFlags });
    steps.push(open(`f${i}.cpp`, t), close(`f${i}.cpp`));
  }
  steps.push(req('w', 'workspace/symbol', { query: 'sweepfn_' }));
  const s = await session({ files, compile, steps });
  check(s.exitCode === 0, `exit ${s.exitCode}`);
  check((s.res.w ?? []).length === 25, `expected 25 symbols, got ${(s.res.w ?? []).length}`);
});
test('sweep: references from a header-sharing pair of files', async () => {
  const hdr = 'int shared_api(int);\n';
  const a = '#include "shared.h"\nint shared_api(int v) { return v; }\n';
  const b = '#include "shared.h"\nint use_it() { return shared_api(2); }\n';
  const s = await session({
    files: { 'shared.h': hdr, 'a.cpp': a, 'b.cpp': b },
    compile: [{ file: 'a.cpp', flags: cppFlags }, { file: 'b.cpp', flags: cppFlags }],
    steps: [open('a.cpp', a), close('a.cpp'), open('b.cpp', b),
      req('r', 'textDocument/references', td('b.cpp', { position: at(b, 'shared_api', 1), context: { includeDeclaration: true } }))],
  });
  const u = new Set(uris(s.res.r));
  check(u.has(uri('a.cpp')) && u.has(uri('b.cpp')), JSON.stringify([...u]));
});

// ---- robustness ----
test('stress: 3000-line file produces diagnostics and answers hover', async () => {
  let src = '';
  for (let i = 0; i < 3000; i++) src += `int generated_${i}(int v) { return v + ${i}; }\n`;
  src += 'int main() { return generated_2999(1) + missing_symbol; }\n';
  const s = await one('a.cpp', src, [req('h', 'textDocument/hover', td('a.cpp', { position: at(src, 'generated_2999', 1) }))]);
  check(errorsOf(diagsFor(s, 'a.cpp')).length === 1, JSON.stringify(diagsFor(s, 'a.cpp')));
  check(/generated_2999/.test(hoverText(s.res.h)), hoverText(s.res.h));
});
test('stress: many rapid edits end in the latest state', async () => {
  const steps = [];
  for (let v = 2; v <= 30; v++) steps.push(change('a.cpp', v, v === 30 ? 'int final_state_ok;\n' : `int broken_${v} = ;\n`));
  const s = await one('a.cpp', 'int start;\n', steps);
  check((diagsFor(s, 'a.cpp') ?? ['x']).length === 0, `final diagnostics should be clean: ${JSON.stringify(diagsFor(s, 'a.cpp'))}`);
});

// ---- runner ----
const filters = process.argv.slice(2);
const selected = tests.filter((t) => !filters.length || filters.some((f) => t.name.includes(f)));
let failed = 0;
const t0 = Date.now();
for (const { name, fn } of selected) {
  const start = Date.now();
  try { await fn(); console.log(`ok   ${name} (${Date.now() - start} ms)`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n       ${String(e.message ?? e).split('\n').join('\n       ').slice(0, 1500)}`); }
}
console.log(`\n${selected.length - failed}/${selected.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(failed ? 'SMOKETEST FAILED' : 'SMOKETEST PASSED');
process.exit(failed ? 1 : 0);
