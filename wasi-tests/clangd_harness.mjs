// Shared helpers for the clangd.wasm LSP tests: runs one `clangd -sync
// -background-index=false` session on a stock node:wasi host, with stdin read
// from a pre-built file (so every request in a session must be known up
// front; replies are matched back by name afterwards).
import { writeFile, mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { WASI } from 'node:wasi';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findResourceDir } from './wasi_spawn_shim.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
export const wasmPath = path.join(repoRoot, 'build-single-threaded', 'bin', 'clangd.wasm');
const sysrootPath = 'C:/Users/mooin/AppData/Local/wasi-sdk/wasi-sdk-34.0-x86_64-windows/share/wasi-sysroot';
const resourceDir = await findResourceDir(path.join(repoRoot, 'build-single-threaded', 'lib', 'clang'));
const module = await WebAssembly.compile(await readFile(process.env.CLANGD_WASM ?? wasmPath));

export const cppFlags = ['--target=wasm32-wasip1', '--sysroot=/sysroot', '-resource-dir=/resource',
  '-isystem/sysroot/include/wasm32-wasip1/noeh/c++/v1', '-isystem/sysroot/include/c++/v1', '-fno-exceptions'];
export const cFlags = ['--target=wasm32-wasip1', '--sysroot=/sysroot', '-resource-dir=/resource'];

export const uri = (name) => `file:///work/${name.split('/').map(encodeURIComponent).join('/')}`;
export const frame = (o) => { const s = JSON.stringify(o); return `Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`; };

/** Position of the first occurrence of `needle` in `text`, plus `delta` characters (UTF-16, as LSP wants). */
export function at(text, needle, delta = 0) {
  const i = text.indexOf(needle);
  if (i < 0) throw new Error(`test bug: ${JSON.stringify(needle)} not found in source`);
  const before = text.slice(0, i + delta);
  const lines = before.split('\n');
  return { line: lines.length - 1, character: lines[lines.length - 1].length };
}
/** Like at(), but the n-th (0-based) occurrence. */
export function nth(text, needle, n, delta = 0) {
  let i = -1;
  for (let k = 0; k <= n; k++) i = text.indexOf(needle, i + 1);
  if (i < 0) throw new Error(`test bug: occurrence ${n} of ${JSON.stringify(needle)} not found`);
  const lines = text.slice(0, i + delta).split('\n');
  return { line: lines.length - 1, character: lines[lines.length - 1].length };
}

export const open = (name, text, languageId = 'cpp', version = 1) =>
  ({ n: 'textDocument/didOpen', p: { textDocument: { uri: uri(name), languageId, version, text } } });
export const close = (name) => ({ n: 'textDocument/didClose', p: { textDocument: { uri: uri(name) } } });
export const change = (name, version, text) =>
  ({ n: 'textDocument/didChange', p: { textDocument: { uri: uri(name), version }, contentChanges: [{ text }] } });
export const req = (as, m, p) => ({ as, m, p });
export const td = (name, extra = {}) => ({ textDocument: { uri: uri(name) }, ...extra });

/**
 * Runs one session. `files` are written under /work; `compile` (optional)
 * is a list of {file, flags} written to compile_commands.json; `steps` are
 * {n, p} notifications or {as, m, p} named requests. Returns
 * {res: {name: result|undefined}, errors: {name: error}, notes: [...], exitCode, stderr}.
 */
export async function session({ files = {}, compile = [], steps = [], args = [], initOptions, caps = {} } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'clangd-t-'));
  const tmp = await mkdtemp(path.join(tmpdir(), 'clangd-tmp-'));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  if (compile.length) {
    await writeFile(path.join(dir, 'compile_commands.json'), JSON.stringify(compile.map(({ file, flags }) => ({
      directory: '/work', file: `/work/${file}`, arguments: ['clang', ...flags, `/work/${file}`] }))));
  }
  const msgs = [{ jsonrpc: '2.0', id: 'init', method: 'initialize',
    params: { processId: null, rootUri: 'file:///work', capabilities: { ...caps, textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true }, ...caps.textDocument } }, initializationOptions: initOptions } },
  { jsonrpc: '2.0', method: 'initialized', params: {} }];
  const names = new Map();
  let id = 100;
  for (const s of steps) {
    if (s.as) { names.set(id, s.as); msgs.push({ jsonrpc: '2.0', id: id++, method: s.m, params: s.p }); }
    else msgs.push({ jsonrpc: '2.0', method: s.n, params: s.p });
  }
  names.set(id, '$shutdown'); msgs.push({ jsonrpc: '2.0', id: id++, method: 'shutdown' });
  msgs.push({ jsonrpc: '2.0', method: 'exit' });

  const [inP, outP, errP] = ['in', 'out', 'err'].map((x) => path.join(dir, `.${x}`));
  await writeFile(inP, msgs.map(frame).join(''));
  const fds = [openSync(inP, 'r'), openSync(outP, 'w'), openSync(errP, 'w')];
  const compileArgs = compile.length ? ['-compile-commands-dir=/work'] : [];
  const wasi = new WASI({ version: 'preview1', args: ['clangd', '-sync', '-background-index=false', '-log=verbose', ...compileArgs, ...args],
    env: {}, preopens: { '/work': dir, '/tmp': tmp, '/sysroot': sysrootPath, '/resource': resourceDir }, stdin: fds[0], stdout: fds[1], stderr: fds[2] });
  const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
  let exitCode, trap;
  try { exitCode = wasi.start(instance) ?? 0; } catch (e) { exitCode = -1; trap = String(e.message ?? e); }
  fds.forEach(closeSync);

  const buf = await readFile(outP);
  const res = {}, errors = {}, notes = [];
  for (let p = 0; p < buf.length;) {
    const h = buf.indexOf('\r\n\r\n', p);
    if (h < 0) break;
    const len = Number(/Content-Length: (\d+)/.exec(buf.subarray(p, h).toString('latin1'))?.[1]);
    const m = JSON.parse(buf.subarray(h + 4, h + 4 + len).toString('utf8'));
    p = h + 4 + len;
    if (m.id !== undefined && m.method === undefined) {
      const name = m.id === 'init' ? 'init' : names.get(m.id);
      if (m.error) errors[name] = m.error; else res[name] = m.result;
    } else if (m.method) notes.push(m);
  }
  const stderr = await readFile(errP, 'utf8');
  const memBytes = instance.exports.memory?.buffer.byteLength;
  return { res, errors, notes, exitCode, trap, stderr, dir, memBytes };
}

/** Latest publishDiagnostics for a file in a session. */
export const diagsFor = (s, name) =>
  s.notes.filter((n) => n.method === 'textDocument/publishDiagnostics' && n.params.uri === uri(name)).at(-1)?.params.diagnostics;
export const allDiagsFor = (s, name) =>
  s.notes.filter((n) => n.method === 'textDocument/publishDiagnostics' && n.params.uri === uri(name)).map((n) => n.params.diagnostics);

/** Apply LSP TextEdits (UTF-16 positions) to text. */
export function applyEdits(text, edits) {
  const lines = text.split('\n');
  const off = (pos) => lines.slice(0, pos.line).reduce((a, l) => a + l.length + 1, 0) + pos.character;
  return [...edits].sort((a, b) => off(b.range.start) - off(a.range.start))
    .reduce((t, e) => t.slice(0, off(e.range.start)) + e.newText + t.slice(off(e.range.end)), text);
}
