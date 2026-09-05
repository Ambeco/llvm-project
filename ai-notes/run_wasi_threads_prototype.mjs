// Prototype proving real wasi-threads (shared-memory pthreads) work end to
// end via Node worker_threads + node:wasi (not a hand-rolled syscall
// subset -- see wasi_thread_hook.mjs's file comment for the
// makeFakeInstance() trick this needs). Not part of the clang.wasm smoke
// tests -- this runs a small standalone C program (4 pthreads each
// incrementing a mutex-protected shared counter 100000 times) built
// directly against wasm32-wasip1-threads, to isolate "does the
// thread-spawn/shared-memory mechanism work at all" from "does clang.wasm
// specifically use it" (see ai-notes/wip.md).
//
// Usage:
//   node --experimental-wasi-unstable-preview1 ai-notes/run_wasi_threads_prototype.mjs <path-to-pthread-test.wasm>
import { WASI } from 'node:wasi';
import { argv as processArgv } from 'node:process';
import { readImportedMemoryLimits, makeThreadSpawn, makeFakeInstance, loadModule } from './wasi_thread_hook.mjs';

const wasmPath = processArgv[2];
if (!wasmPath) {
  console.error('usage: run_wasi_threads_prototype.mjs <path-to-pthread-test.wasm>');
  process.exit(1);
}

const { bytes, module: wasmModule } = await loadModule(wasmPath);
const limits = readImportedMemoryLimits(bytes);
if (!limits)
  throw new Error('module does not import memory -- not built with -pthread/wasi-threads support');
const { min, max, shared } = limits;
console.error(`Imported memory: min=${min} pages, max=${max} pages, shared=${shared}`);
if (!shared || max === undefined)
  throw new Error('module memory is not shared+bounded -- was it linked with ' +
    '--shared-memory --import-memory and an explicit --max-memory?');

const memory = new WebAssembly.Memory({ initial: min, maximum: max, shared: true });

// tidCounter[0] is the next thread id to hand out. Shared across every
// worker (main + all spawned threads) via a SharedArrayBuffer, so
// concurrent thread-spawn calls from different threads still get unique
// ids -- Atomics.add is a real atomic RMW, safe across threads.
const tidCounter = new Int32Array(new SharedArrayBuffer(4));
Atomics.store(tidCounter, 0, 1); // 0 is conventionally the main thread

const wasi = new WASI({ version: 'preview1', args: ['t2'], env: {}, preopens: {} });
const importObject = wasi.getImportObject();
importObject.env = { memory };
importObject.wasi = {
  'thread-spawn': makeThreadSpawn({ wasmPath, memory, preopens: {}, tidCounter }),
};

console.error('Instantiating main instance...');
const instance = await WebAssembly.instantiate(wasmModule, importObject);

console.error('Running _start...');
let exitCode = 0;
try {
  // forThread:false (default) -- this IS the command/_start entry point.
  const ret = wasi.start(makeFakeInstance(instance, memory));
  if (typeof ret === 'number')
    exitCode = ret;
} catch (e) {
  console.error('Main instance trapped:', e);
  exitCode = -1;
}
console.error(`Exited with code ${exitCode}`);
console.error(exitCode === 0 ? 'PROTOTYPE PASSED' : 'PROTOTYPE FAILED');
process.exit(exitCode);
