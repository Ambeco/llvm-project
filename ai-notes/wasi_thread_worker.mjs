// worker_threads entry point for one spawned wasi-thread (NOT a spawned
// subprocess -- see wasi_spawn_worker.mjs for that, a different mechanism
// entirely). Instantiates a *fresh* module (re-reads/re-compiles from
// wasmPath -- same tradeoff wasi_spawn_worker.mjs makes, simplicity over
// the extra work of transferring an already-compiled WebAssembly.Module)
// against the *same* shared WebAssembly.Memory the main instance was
// given, then calls the module's exported wasi_thread_start(tid, startArg)
// directly -- NOT wasi.start()/_start, which is the normal *process*
// entry point, not a thread's.
import { readFile } from 'node:fs/promises';
import { workerData, parentPort } from 'node:worker_threads';
import { makeThreadSpawn } from './wasi_thread_hook.mjs';
import { makeWasiSnapshotPreview1, ProcExit } from './wasi_thread_syscalls.mjs';

const { wasmPath, memory, tid, startArg, preopens, tidCounterSAB } = workerData;
const tidCounter = new Int32Array(tidCounterSAB);

try {
  const bytes = await readFile(wasmPath);
  const wasmModule = await WebAssembly.compile(bytes);

  const importObject = {
    wasi_snapshot_preview1: makeWasiSnapshotPreview1(memory),
    env: { memory },
    wasi: { 'thread-spawn': makeThreadSpawn({ wasmPath, memory, preopens, tidCounter }) },
  };

  const instance = await WebAssembly.instantiate(wasmModule, importObject);
  parentPort.postMessage({ log: `starting (tid=${tid}, startArg=${startArg})` });
  instance.exports.wasi_thread_start(tid, startArg);
  parentPort.postMessage({ log: 'finished' });
} catch (e) {
  if (e instanceof ProcExit)
    parentPort.postMessage({ log: `called proc_exit(${e.code}) from a thread (unexpected for this test)` });
  else
    parentPort.postMessage({ log: `trapped: ${e}` });
}
