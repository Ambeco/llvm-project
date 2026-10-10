// Child process for clangd_stream_harness.mjs: runs clangd.wasm with the
// process's real stdin/stdout/stderr pipes (fds 0/1/2), so a parent can talk
// to it interactively. Config arrives as JSON in CLANGD_RUN.
import { readFile } from 'node:fs/promises';
import { WASI } from 'node:wasi';
import { instantiateThreaded, makeFakeInstance, readImportedMemoryLimits } from './wasi_thread_hook.mjs';

const cfg = JSON.parse(process.env.CLANGD_RUN);
const wasi = new WASI({ version: 'preview1', args: ['clangd', ...cfg.args], env: {}, preopens: cfg.preopens, stdin: 0, stdout: 1, stderr: 2 });
const bytes = await readFile(cfg.wasm);
const module = await WebAssembly.compile(bytes);
// A wasi-threads build (build-clangd-threads.bat) imports its memory; it needs
// shared memory + wasi.thread-spawn from the host.
let instance, memory;
if (readImportedMemoryLimits(bytes)) {
  ({ instance, memory } = await instantiateThreaded(module, bytes, wasi.getImportObject(),
    { wasmPath: cfg.wasm, preopens: cfg.preopens }));
} else instance = await WebAssembly.instantiate(module, wasi.getImportObject());
let code = 0;
try { code = wasi.start(memory ? makeFakeInstance(instance, memory) : instance) ?? 0; } catch (e) { console.error('clangd trapped:', e); code = 99; }
process.exit(code);
