// Background-index test for the wasi-threads clangd build (build-clangd-threads.bat):
// runs clangd WITHOUT -background-index=false, opens one file, and checks that
// the indexer picks up a never-opened file from compile_commands.json.
//
// Usage:
//   CLANGD_THREADED=1 node --experimental-wasm-type-reflection --experimental-wasi-unstable-preview1 wasi-tests/run_clangd_bgindex_smoketest.mjs
process.env.CLANGD_BG_INDEX = '1';
const { start } = await import('./clangd_stream_harness.mjs');
const { threaded, cppFlags, uri, at } = await import('./clangd_harness.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => { console.log(`FAIL ${msg}`); console.log('SMOKETEST FAILED'); process.exit(1); };
if (!threaded) fail('needs the wasi-threads build: set CLANGD_THREADED=1');

const lib = 'int bg_indexed_symbol(int v) { return v * 2; }\n';
const main = 'int bg_indexed_symbol(int);\nint main() { return bg_indexed_symbol(1); }\n';
const c = await start({
  files: { 'lib.cpp': lib, 'main.cpp': main },
  compile: [{ file: 'lib.cpp', flags: cppFlags }, { file: 'main.cpp', flags: cppFlags }],
});
try {
  await c.init();
  c.open('main.cpp', main);
  await c.diags('main.cpp', 0);
  const t0 = Date.now();
  let found;
  while (Date.now() - t0 < 180000 && !found) {
    const w = await c.request('workspace/symbol', { query: 'bg_indexed_symbol' });
    found = w.find((s) => s.location.uri === uri('lib.cpp'));
    if (!found) await sleep(500);
  }
  if (!found) fail(`bg_indexed_symbol never appeared in workspace/symbol\n${c.stderr.slice(-1500)}`);
  console.log(`ok   background index found a closed file's symbol after ${Date.now() - t0} ms`);
  const defs = await c.request('textDocument/definition', { textDocument: { uri: uri('main.cpp') }, position: at(main, 'bg_indexed_symbol(1)', 2) });
  const locs = (defs ?? []).map((l) => l.uri ?? l.targetUri);
  if (!locs.includes(uri('lib.cpp'))) fail(`go-to-definition did not reach lib.cpp: ${JSON.stringify(defs)}`);
  console.log('ok   go-to-definition resolves into the never-opened file');
  const code = await c.shutdown();
  if (code !== 0) fail(`exit ${code}`);
  console.log('ok   clean shutdown (exit 0)');
} catch (e) { fail(String(e.message ?? e)); }
console.log('SMOKETEST PASSED');
process.exit(0);
