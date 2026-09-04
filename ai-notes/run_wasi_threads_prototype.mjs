// Prototype proving real wasi-threads (shared-memory pthreads) work end to
// end via Node worker_threads. Not part of the clang.wasm smoke tests --
// this runs a small standalone C program (4 pthreads each incrementing a
// mutex-protected shared counter 100000 times) built directly against
// wasm32-wasip1-threads, to isolate "does the thread-spawn/shared-memory
// mechanism work at all" from "does clang.wasm specifically use it" (see
// ai-notes/wip.md for why -- LLVM_ENABLE_THREADS=ON only makes threading
// *available*, doesn't guarantee it's exercised by a given compile).
//
// Usage:
//   node --experimental-wasi-unstable-preview1 ai-notes/run_wasi_threads_prototype.mjs <path-to-pthread-test.wasm>
import { argv as processArgv } from 'node:process';
import { readImportedMemoryLimits, makeThreadSpawn, loadModule } from './wasi_thread_hook.mjs';
import { makeWasiSnapshotPreview1, ProcExit } from './wasi_thread_syscalls.mjs';

const wasmPath = processArgv[2];
if (!wasmPath) {
  console.error('usage: run_wasi_threads_prototype.mjs <path-to-pthread-test.wasm>');
  process.exit(1);
}

const { bytes, module: wasmModule } = await loadModule(wasmPath);
const { min, max, shared } = readImportedMemoryLimits(bytes);
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

const importObject = {
  wasi_snapshot_preview1: makeWasiSnapshotPreview1(memory),
  env: { memory },
  wasi: { 'thread-spawn': makeThreadSpawn({ wasmPath, memory, preopens: {}, tidCounter }) },
};

console.error('Instantiating main instance...');
const instance = await WebAssembly.instantiate(wasmModule, importObject);

console.error('Running _start...');
let exitCode = 0;
try {
  instance.exports._start();
} catch (e) {
  if (e instanceof ProcExit) {
    exitCode = e.code;
  } else {
    console.error('Main instance trapped:', e);
    exitCode = -1;
  }
}
console.error(`Exited with code ${exitCode}`);
console.error(exitCode === 0 ? 'PROTOTYPE PASSED' : 'PROTOTYPE FAILED');
process.exit(exitCode);
