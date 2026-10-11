// Interactive LSP client for clangd.wasm: spawns clangd_stdio_runner.mjs with
// real pipes, so a test can send a message, wait for the reply (or a server
// notification), and decide what to send next. This is the closest this repo
// gets to the long-lived bidirectional stdin/stdout stream a real host provides.
import { spawn } from 'node:child_process';
import { writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { frame, wasmPath, cppFlags, uri, threaded } from './clangd_harness.mjs';
import { findResourceDir } from './wasi_spawn_shim.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const sysrootPath = 'C:/Users/mooin/AppData/Local/wasi-sdk/wasi-sdk-34.0-x86_64-windows/share/wasi-sysroot';
const resourceDir = await findResourceDir(path.join(repoRoot, 'build-single-threaded', 'lib', 'clang'));

export class Client {
  constructor(child, dir) {
    this.child = child; this.dir = dir;
    this.buf = Buffer.alloc(0); this.nextId = 1; this.pending = new Map();
    this.notes = []; this.serverRequests = []; this.waiters = []; this.stderr = '';
    this.exited = new Promise((resolve) => child.on('exit', (code, sig) => { this.exitCode = code ?? sig; this.closed = true; this.wake(); resolve(this.exitCode); }));
    child.stdout.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.drain(); });
    child.stderr.on('data', (d) => { this.stderr += d; if (process.env.CLANGD_ECHO_STDERR) process.stderr.write(d); });
    child.stdin.on('error', () => {});
  }
  drain() {
    for (;;) {
      const h = this.buf.indexOf('\r\n\r\n');
      if (h < 0) return;
      const len = Number(/Content-Length: (\d+)/.exec(this.buf.subarray(0, h).toString('latin1'))?.[1]);
      if (this.buf.length < h + 4 + len) return;
      const m = JSON.parse(this.buf.subarray(h + 4, h + 4 + len).toString('utf8'));
      this.buf = this.buf.subarray(h + 4 + len);
      this.onMessage(m);
    }
  }
  onMessage(m) {
    if (m.method && m.id !== undefined) { // server -> client request
      this.serverRequests.push(m);
      const result = m.method === 'workspace/applyEdit' ? { applied: true } : null;
      this.write({ jsonrpc: '2.0', id: m.id, result });
    } else if (m.method) this.notes.push(m);
    else { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.reject(Object.assign(new Error(m.error.message), { error: m.error })) : p.resolve(m.result); } }
    this.wake();
  }
  wake() { this.waiters = this.waiters.filter((w) => { if (w.check() || this.closed) { w.resolve(); return false; } return true; }); }
  write(obj) { this.child.stdin.write(frame(obj)); }
  /** Raw bytes, for framing tests. */
  writeRaw(buf) { this.child.stdin.write(buf); }
  notify(method, params) { this.write({ jsonrpc: '2.0', method, params }); }
  request(method, params, timeoutMs = 60000) {
    const id = this.nextId++;
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`timeout waiting for ${method}`)); }, timeoutMs);
      this.exited.then(() => { if (this.pending.delete(id)) reject(new Error(`clangd exited (${this.exitCode}) before answering ${method}\n${this.stderr.slice(-800)}`)); });
    });
    this.write({ jsonrpc: '2.0', id, method, params });
    return p;
  }
  /** Resolves with the first (not-yet-consumed-by-index) notification matching pred, waiting up to timeoutMs. */
  async waitNote(pred, timeoutMs = 60000, from = 0) {
    const find = () => this.notes.slice(from).find(pred);
    if (!find()) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout waiting for notification')), timeoutMs);
        this.waiters.push({ check: () => !!find(), resolve: () => { clearTimeout(t); resolve(); } });
      });
    }
    const n = find();
    if (!n) throw new Error(`clangd exited (${this.exitCode}) while waiting for a notification\n${this.stderr.slice(-800)}`);
    return n;
  }
  /** Next publishDiagnostics for `name` that arrives after `from` notifications. */
  diags(name, from = this.notes.length) {
    return this.waitNote((n) => n.method === 'textDocument/publishDiagnostics' && n.params.uri === uri(name), 60000, from).then((n) => n.params.diagnostics);
  }
  async init(capabilities = { textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } }) {
    const r = await this.request('initialize', { processId: null, rootUri: 'file:///work', capabilities });
    this.notify('initialized', {});
    return r;
  }
  open(name, text, languageId = 'cpp', version = 1) {
    this.notify('textDocument/didOpen', { textDocument: { uri: uri(name), languageId, version, text } });
  }
  async shutdown() {
    await this.request('shutdown', undefined);
    this.notify('exit', undefined);
    return this.exited;
  }
}

/** Starts clangd with `files` on disk under /work; returns a Client (call .dir for the host path). */
export async function start({ files = {}, compile = [], args = [] } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'clangd-s-'));
  const tmp = await mkdtemp(path.join(tmpdir(), 'clangd-stmp-'));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  await writeCompile(dir, compile);
  const cfg = { wasm: process.env.CLANGD_WASM ?? wasmPath,
    args: [...(threaded && process.env.CLANGD_SYNC !== '1' ? [] : ['-sync']), ...(process.env.CLANGD_BG_INDEX === '1' ? [] : ['-background-index=false']), '-log=verbose', ...(compile.length ? ['-compile-commands-dir=/work'] : []), ...args],
    preopens: { '/work': dir, '/tmp': tmp, '/sysroot': sysrootPath, '/resource': resourceDir } };
  const child = spawn(process.execPath, ['--experimental-wasm-type-reflection', '--experimental-wasi-unstable-preview1', '--no-warnings', path.join(import.meta.dirname, 'clangd_stdio_runner.mjs')],
    { env: { ...process.env, CLANGD_RUN: JSON.stringify(cfg) }, stdio: ['pipe', 'pipe', 'pipe'] });
  return new Client(child, dir);
}

export async function writeCompile(dir, compile) {
  if (!compile.length) return;
  await writeFile(path.join(dir, 'compile_commands.json'), JSON.stringify(compile.map(({ file, flags }) => ({
    directory: '/work', file: `/work/${file}`, arguments: ['clang', ...(flags ?? cppFlags), `/work/${file}`] }))));
}

/**
 * Async-mode equivalent of clangd_harness.mjs's session(): drives the same
 * `steps` over live pipes, waiting for each reply (and for the diagnostics a
 * didOpen/didChange/didClose produces) before sending the next, so clangd's
 * worker threads finish before shutdown. Same return shape as session().
 */
export async function asyncSession({ files = {}, compile = [], steps = [], args = [], initOptions, caps = {} } = {}) {
  const c = await start({ files, compile: compile.map((x) => ({ ...x })), args });
  const res = {}, errors = {};
  try {
    const initR = await c.request('initialize', { processId: null, rootUri: 'file:///work', initializationOptions: initOptions,
      capabilities: { ...caps, textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true }, ...caps.textDocument } } });
    res.init = initR;
    c.notify('initialized', {});
    for (const s of steps) {
      if (s.as) {
        try {
          res[s.as] = await c.request(s.m, s.p);
          // The dynamic index is filled from the preamble after the first diagnostics, so an
          // early completion can legitimately be empty; there is no event to wait on.
          for (let i = 0; s.m === 'textDocument/completion' && !res[s.as]?.items?.length && i < 80; i++) {
            await new Promise((r) => setTimeout(r, 250));
            res[s.as] = await c.request(s.m, s.p);
          }
        } catch (e) { if (e.error) errors[s.as] = e.error; else throw e; }
      } else {
        const from = c.notes.length;
        c.notify(s.n, s.p);
        if (/^textDocument\/did(Open|Change|Close)$/.test(s.n))
          await c.waitNote((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === s.p.textDocument.uri, 60000, from).catch(() => {});
      }
    }
    await c.request('shutdown', undefined);
    c.notify('exit', undefined);
    await c.exited;
  } finally { if (!c.closed) c.child.kill(); }
  return { res, errors, notes: c.notes, exitCode: c.exitCode, trap: undefined, stderr: c.stderr, dir: c.dir, memBytes: undefined };
}
