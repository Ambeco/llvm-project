// worker_threads entry point for one independent top-level clang.wasm
// *driver* invocation (not a cc1 child -- see wasi_spawn_worker.mjs for
// that). Used to compile several files concurrently: each file gets its
// own Worker, its own fresh wasm instance (own linear memory -- no sharing,
// this is process-like isolation, not thread-like), and its own spawn hook
// installed, which in turn spawns its own cc1 child as a *nested*
// worker_threads Worker (Node supports this fine). This is the practical
// "multi-process" parallelism this project can already exploit today,
// without touching LLVM_ENABLE_THREADS or any wasm-side threading support
// at all -- see ai-notes/wip.md's "multi-file parallel compile" note for
// why this is the cheap win versus real wasi-threads support.
import { readFile } from 'node:fs/promises';
import { WASI } from 'node:wasi';
import { workerData, parentPort } from 'node:worker_threads';
import { installSpawnHook } from './wasi_spawn_shim.mjs';
import { instantiateThreaded, makeFakeInstance } from './wasi_thread_hook.mjs';

const { wasmPath, clangArgs, preopens } = workerData;

let exitCode = 0;
try {
  const wasi = new WASI({ version: 'preview1', args: clangArgs, env: {}, preopens });
  const bytes = await readFile(wasmPath);
  const wasmModule = await WebAssembly.compile(bytes);
  // clang.wasm is built against wasm32-wasip1-threads -- each of these
  // independent driver instances still gets its own private shared memory
  // (instantiateThreaded creates a fresh one per call), matching the
  // process-like isolation this script is demonstrating; only *within* one
  // such instance's own spawned threads is memory actually shared.
  const { instance, memory } = await instantiateThreaded(
    wasmModule, bytes, wasi.getImportObject(), { wasmPath, preopens });
  installSpawnHook(instance, { wasmPath, preopens, memory });

  try {
    const ret = wasi.start(makeFakeInstance(instance, memory));
    if (typeof ret === 'number')
      exitCode = ret;
  } catch (e) {
    parentPort.postMessage({ log: `driver instance trapped: ${e}` });
    exitCode = -1;
  }
} catch (e) {
  parentPort.postMessage({ log: `failed to run driver: ${e}` });
  exitCode = -1;
}

parentPort.postMessage({ exitCode });
