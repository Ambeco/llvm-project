// Child process for clangd_stream_harness.mjs: runs clangd.wasm with the
// process's real stdin/stdout/stderr pipes (fds 0/1/2), so a parent can talk
// to it interactively. Config arrives as JSON in CLANGD_RUN.
import { readFile } from 'node:fs/promises';
import { WASI } from 'node:wasi';

const cfg = JSON.parse(process.env.CLANGD_RUN);
const wasi = new WASI({ version: 'preview1', args: ['clangd', ...cfg.args], env: {}, preopens: cfg.preopens, stdin: 0, stdout: 1, stderr: 2 });
const module = await WebAssembly.compile(await readFile(cfg.wasm));
const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
let code = 0;
try { code = wasi.start(instance) ?? 0; } catch (e) { console.error('clangd trapped:', e); code = 99; }
process.exit(code);
