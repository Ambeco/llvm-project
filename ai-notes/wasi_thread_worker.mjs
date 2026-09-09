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

const { wasmPath, memory, tid, startArg, preopens, tidCounterSAB,
       extraImportsModule, extraImportsConfig } = workerData;
const tidCounter = new Int32Array(tidCounterSAB);

try {
  const wasi = new WASI({ version: 'preview1', args: ['thread'], env: {}, preopens });
  const bytes = await readFile(wasmPath);
  const wasmModule = await WebAssembly.compile(bytes);

  const importObject = wasi.getImportObject();
  importObject.env = { memory };
  importObject.wasi = {
    'thread-spawn': makeThreadSpawn({ wasmPath, memory, preopens, tidCounter,
                                     extraImportsModule, extraImportsConfig }),
  };
  // A function can't cross the workerData structured-clone boundary, so an
  // embedder whose module imports something beyond plain WASI/env.memory/
  // thread-spawn (see makeThreadSpawn's doc comment in wasi_thread_hook.mjs)
  // supplies a module that rebuilds equivalent functions from
  // `extraImportsConfig` instead. Omitting this when needed makes
  // WebAssembly.instantiate() below throw -- see the catch block, and
  // documents/remaining_work.md's 2026-09-09 entry for why that failure is
  // otherwise invisible (postMessage back to a parent blocked inside a
  // synchronous wasm call, e.g. a thread pool's wait(), is never delivered).
  if (extraImportsModule) {
    const { buildImports } = await import(extraImportsModule);
    Object.assign(importObject, buildImports(extraImportsConfig, { memory }));
  }

  const instance = await WebAssembly.instantiate(wasmModule, importObject);

  // NOT wasi.initialize(): besides binding node:wasi's syscalls to our
  // externally-supplied `memory` (needed the same way for every module,
  // command or reactor -- see the file-level comment on
  // makeFakeInstance()), wasi.initialize() also calls the module's
  // _initialize() export if present. _initialize is a *reactor's*
  // one-time top-level setup entry point (see
  // lldb/tools/lldb-wasm-reactor/CMakeLists.txt's -mexec-model=reactor
  // comment), not a per-thread one -- calling it again here, in a spawned
  // thread's own fresh instance sharing already-initialized memory with
  // the main instance, traps (`unreachable`) inside wasi-libc's own
  // double-init guard. A command-style module (clang.wasm/lld.wasm) has no
  // _initialize export at all, so calling wasi.initialize() for its own
  // spawned threads was always harmless by accident, not by design --
  // confirmed directly (`node -e "console.log(WASI.prototype.initialize
  // .toString())"`): initialize() is just finalizeBindings() plus that
  // conditional _initialize() call. See documents/remaining_work.md's
  // 2026-09-09 entry for the incident this was found from.
  wasi.finalizeBindings(makeFakeInstance(instance, memory, { forThread: true }));

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
