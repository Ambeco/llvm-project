// Proves the V1 "sweep" indexing approach: opening a file in clangd -sync and
// then closing it leaves its symbols in the dynamic index, so cross-file
// workspace/symbol, definition and references still resolve. The plugin can
// therefore index a project by didOpen/didClose-ing each file while idle.
//
// Usage:
//   node --experimental-wasm-type-reflection --experimental-wasi-unstable-preview1 wasi-tests/run_clangd_sweep_smoketest.mjs [path/to/clangd.wasm]
import { writeFile, mkdtemp, readFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { WASI } from 'node:wasi';
import { tmpdir } from 'node:os';
import path from 'node:path';
const repoRoot = path.resolve(import.meta.dirname, '..');
const wasmPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(repoRoot, 'build-single-threaded', 'bin', 'clangd.wasm');
const dir = await mkdtemp(path.join(tmpdir(), 'sweep-')), tmp = await mkdtemp(path.join(tmpdir(), 'sweeptmp-'));
const A = 'int foo_unique_symbol(int x) { return x + 1; }\n';
const B = 'int foo_unique_symbol(int x);\nint main() { return foo_unique_symbol(2); }\n';
const frame = (o) => { const s = JSON.stringify(o); return `Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`; };
const open = (u, t) => ({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: u, languageId: 'cpp', version: 1, text: t } } });
const ua = 'file:///work/a.cpp', ub = 'file:///work/b.cpp';
const msgs = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: null, rootUri: 'file:///work', capabilities: {} } },
  { jsonrpc: '2.0', method: 'initialized', params: {} },
  open(ua, A),
  { jsonrpc: '2.0', id: 5, method: 'workspace/symbol', params: { query: 'foo_unique' } }, // while a is open
  { jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri: ua } } },
  { jsonrpc: '2.0', id: 6, method: 'workspace/symbol', params: { query: 'foo_unique' } }, // after close
  open(ub, B),
  { jsonrpc: '2.0', id: 2, method: 'textDocument/definition', params: { textDocument: { uri: ub }, position: { line: 1, character: 22 } } },
  { jsonrpc: '2.0', id: 3, method: 'textDocument/references', params: { textDocument: { uri: ub }, position: { line: 1, character: 22 }, context: { includeDeclaration: true } } },
  { jsonrpc: '2.0', id: 4, method: 'shutdown' }, { jsonrpc: '2.0', method: 'exit' },
].map(frame).join('');
const [i, o, e] = ['in', 'out', 'err'].map((n) => path.join(dir, n));
await writeFile(i, msgs);
const fds = [openSync(i, 'r'), openSync(o, 'w'), openSync(e, 'w')];
const wasi = new WASI({ version: 'preview1', args: ['clangd', '-sync', '-background-index=false'], env: {}, preopens: { '/work': dir, '/tmp': tmp }, stdin: fds[0], stdout: fds[1], stderr: fds[2] });
const inst = await WebAssembly.instantiate(await WebAssembly.compile(await readFile(wasmPath)), wasi.getImportObject());
try { wasi.start(inst); } catch (x) { console.log('trap', x.message); }
fds.forEach(closeSync);
const buf = await readFile(o);
const byId = new Map();
for (let p = 0; p < buf.length;) {
  const h = buf.indexOf('\r\n\r\n', p); const len = +/Content-Length: (\d+)/.exec(buf.subarray(p, h).toString('latin1'))[1];
  const m = JSON.parse(buf.subarray(h + 4, h + 4 + len).toString('utf8')); p = h + 4 + len;
  if (m.id !== undefined) byId.set(m.id, m.result);
}
const inA = (r) => r?.some((x) => (x.uri ?? x.location?.uri) === ua);
const checks = {
  'workspace/symbol finds a.cpp while open': inA(byId.get(5)),
  'workspace/symbol finds a.cpp after didClose': inA(byId.get(6)),
  'definition from b.cpp lands in closed a.cpp': inA(byId.get(2)),
  'references include closed a.cpp': inA(byId.get(3)),
};
for (const [n, ok] of Object.entries(checks)) console.log(`${ok ? 'ok  ' : 'FAIL'} ${n}`);
const pass = Object.values(checks).every(Boolean);
console.log(pass ? 'SMOKETEST PASSED' : 'SMOKETEST FAILED');
process.exit(pass ? 0 : 1);
