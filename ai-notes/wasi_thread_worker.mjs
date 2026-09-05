// worker_threads entry point for one spawned wasi-thread (NOT a spawned
// subprocess -- see wasi_spawn_worker.mjs for that, a different mechanism
// entirely). Instantiates a *fresh* module (re-reads/re-compiles from
// wasmPath -- same tradeoff wasi_spawn_worker.mjs makes) against the
// *same* shared WebAssembly.Memory the main instance was given, then
// calls the module's exported wasi_thread_start(tid, startArg) directly
// -- NOT wasi.start()/_start, which is the normal *process* entry point,
// not a thread's.
//
// Uses node:wasi (not a hand-rolled syscall subset) via the
// makeFakeInstance() duck-typing trick in wasi_thread_hook.mjs, so a
// thread can do real file I/O exactly like the main instance can -- this
// matters for a real compiler like clang.wasm, unlike this repo's minimal
// standalone pthread-mutex test program.
import { readFile } from 'node:fs/promises';
import { WASI } from 'node:wasi';
import { workerData, parentPort } from 'node:worker_threads';
import { makeThreadSpawn, makeFakeInstance } from './wasi_thread_hook.mjs';
import { installSpawnHook } from './wasi_spawn_shim.mjs';

const { wasmPath, memory, tid, startArg, preopens, tidCounterSAB } = workerData;
const tidCounter = new Int32Array(tidCounterSAB);

try {
  const wasi = new WASI({ version: 'preview1', args: ['thread'], env: {}, preopens });
  const bytes = await readFile(wasmPath);
  const wasmModule = await WebAssembly.compile(bytes);

  const importObject = wasi.getImportObject();
  importObject.env = { memory };
  importObject.wasi = {
    'thread-spawn': makeThreadSpawn({ wasmPath, memory, preopens, tidCounter }),
  };

  const instance = await WebAssembly.instantiate(wasmModule, importObject);

  // Binds node:wasi's syscalls to our externally-supplied `memory` instead
  // of the (nonexistent, for an imported-memory module) instance.exports
  // .memory -- see wasi_thread_hook.mjs's file comment. forThread:true
  // because this is not the command/_start entry point.
  wasi.initialize(makeFakeInstance(instance, memory, { forThread: true }));

  // Nested subprocess-spawn support (Program.inc's own extension point,
  // unrelated to wasi-threads): best-effort, since a leaf binary that
  // never calls ExecuteAndWait may have had this dead-stripped.
  if (instance.exports.__wasi_shim_set_spawn_hook)
    installSpawnHook(instance, { wasmPath, preopens, memory });

  parentPort.postMessage({ log: `starting (tid=${tid}, startArg=${startArg})` });
  instance.exports.wasi_thread_start(tid, startArg);
  parentPort.postMessage({ log: 'finished' });
} catch (e) {
  parentPort.postMessage({ log: `trapped: ${e}` });
}
