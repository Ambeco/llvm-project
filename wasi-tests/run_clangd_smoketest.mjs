// Proves the single-threaded clangd.wasm (build-single-threaded, built with
// CLANGD_ALLOW_NO_THREADS) answers LSP requests on a STOCK WASI host: plain
// node:wasi, stdin/stdout redirected to files. Runs `clangd -sync
// -background-index=false`, opens a file with errors, and checks diagnostics,
// hover and definition replies.
//
// Usage:
//   node --experimental-wasm-type-reflection --experimental-wasi-unstable-preview1 wasi-tests/run_clangd_smoketest.mjs [path/to/clangd.wasm]
import { writeFile, mkdtemp, readFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { WASI } from 'node:wasi';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { argv } from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const wasmPath = argv[2] ? path.resolve(argv[2]) : path.join(repoRoot, 'build-single-threaded', 'bin', 'clangd.wasm');
const workDir = await mkdtemp(path.join(tmpdir(), 'clangd-wasm-'));
const tmpDir = await mkdtemp(path.join(tmpdir(), 'clangd-wasm-tmp-')); // preamble PCHs are written under /tmp

const source = 'int add(int a, int b) { return a + b; }\nint main() {\n  int x = "str";\n  return add(1, 2) + y;\n}\n';
const uri = 'file:///work/test.cpp';
const frame = (obj) => { const s = JSON.stringify(obj); return `Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`; };
const pos = (line, character) => ({ line, character });
const input = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: null, rootUri: 'file:///work', capabilities: {} } },
  { jsonrpc: '2.0', method: 'initialized', params: {} },
  { jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'cpp', version: 1, text: source } } },
  { jsonrpc: '2.0', id: 2, method: 'textDocument/hover', params: { textDocument: { uri }, position: pos(3, 10) } },
  { jsonrpc: '2.0', id: 3, method: 'textDocument/definition', params: { textDocument: { uri }, position: pos(3, 10) } },
  { jsonrpc: '2.0', id: 4, method: 'shutdown' },
  { jsonrpc: '2.0', method: 'exit' },
].map(frame).join('');

const inPath = path.join(workDir, 'lsp_in.txt'), outPath = path.join(workDir, 'lsp_out.txt'), errPath = path.join(workDir, 'lsp_err.txt');
await writeFile(inPath, input);
await writeFile(path.join(workDir, 'test.cpp'), source);
const [inFd, outFd, errFd] = [openSync(inPath, 'r'), openSync(outPath, 'w'), openSync(errPath, 'w')];

const args = ['clangd', '-sync', '-background-index=false', '-log=verbose'];
const wasi = new WASI({ version: 'preview1', args, env: {}, preopens: { '/work': workDir, '/tmp': tmpDir }, stdin: inFd, stdout: outFd, stderr: errFd });
const module = await WebAssembly.compile(await readFile(wasmPath));
const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
let exitCode;
try { exitCode = wasi.start(instance) ?? 0; } catch (e) { console.error('clangd trapped:', e); exitCode = -1; }
[inFd, outFd, errFd].forEach(closeSync);

const outBuf = await readFile(outPath);
const out = outBuf.toString('utf8');
const messages = [];
for (let pos = 0; pos < outBuf.length;) {
  const hdrEnd = outBuf.indexOf('\r\n\r\n', pos);
  if (hdrEnd < 0) break;
  const len = Number(/Content-Length: (\d+)/.exec(outBuf.subarray(pos, hdrEnd).toString('latin1'))?.[1]);
  if (!len) break;
  messages.push(JSON.parse(outBuf.subarray(hdrEnd + 4, hdrEnd + 4 + len).toString('utf8')));
  pos = hdrEnd + 4 + len;
}
const byId = (id) => messages.find((x) => x.id === id);
const diags = messages.find((x) => x.method === 'textDocument/publishDiagnostics')?.params.diagnostics ?? [];
const checks = {
  'exit code 0': exitCode === 0,
  'initialize replied': !!byId(1)?.result?.capabilities,
  'diagnostics published (>=2)': diags.length >= 2,
  'diagnostic mentions undeclared y': diags.some((d) => /undeclared identifier 'y'/.test(d.message)),
  'hover replied': !!byId(2)?.result,
  'definition points at add()': byId(3)?.result?.[0]?.range?.start?.line === 0,
};
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
if (!Object.values(checks).every(Boolean)) {
  console.log('--- stdout ---\n' + out.slice(0, 3000));
  console.log('--- stderr ---\n' + (await readFile(errPath, 'utf8')).slice(-3000));
  console.log('SMOKETEST FAILED');
  process.exit(1);
}
console.log('SMOKETEST PASSED');
