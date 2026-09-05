// Real wasi-threads support (Node worker_threads + a genuinely shared
// WebAssembly.Memory), separate from wasi_spawn_shim.mjs's subprocess-spawn
// hook. Different ABI, different mechanism:
//
// - Subprocess spawn (wasi_spawn_shim.mjs) is OUR OWN design: an optional
//   table-indirect function pointer, self-contained by default, no host
//   required. See llvm/lib/Support/Unix/Program.inc.
// - Thread spawn (this file) is wasi-libc/libpthread's PRE-EXISTING,
//   fixed ABI (the "wasi-threads" proposal): the module unconditionally
//   *imports* `wasi.thread-spawn(start_arg) -> tid` and `env.memory` (a
//   shared WebAssembly.Memory) -- these are required imports, not
//   optional, so a host MUST supply them for such a module to instantiate
//   at all. Nothing we can make self-contained-by-default here; it's
//   wasi-libc's contract, not ours.
//
// Read llvm-project's ai-notes/wip.md before extending this -- there's an
// open, NOT-yet-solved design question about sharing WASI file-descriptor
// state across threads for real concurrent file I/O (see the "hybrid
// I/O-owner + RPC" note there).
//
// IMPORTANT, discovered empirically: node:wasi's WASI class hard-requires
// `instance.exports.memory` (throws "instance.exports.memory property must
// be a WebAssembly.Memory object" otherwise) -- it does not support a
// module whose memory is *imported*, which every wasi-threads module's
// must be. Worked around here via makeFakeInstance(): a plain object
// duck-typing an Instance (just `{ exports: {...} }`), with `memory` added
// and (for anything that isn't the main/command instance) `_start`
// removed so wasi.initialize() doesn't refuse it ("The instance.exports
// ._start property must be undefined" otherwise -- it's specifically
// reserved for command-style entry, which a thread's own entry point,
// wasi_thread_start, is not). node:wasi only reads `.exports` off whatever
// object it's given, so this is safe -- confirmed empirically, not by
// reading node's internals.

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const threadWorkerScript = fileURLToPath(new URL('./wasi_thread_worker.mjs', import.meta.url));

/// Parse the wasm import section by hand to find `env.memory`'s declared
/// min/max page counts -- WebAssembly.Module.imports() doesn't expose
/// memory limits (only kind/module/name), but the engine validates a
/// supplied WebAssembly.Memory against these limits at instantiation, so
/// we need the real numbers, not guesses. (wasm-wasi-core, VS Code for
/// Web's WASI host, has this exact same gap -- see documents/vscode-wasi-host.md
/// -- its doesImportMemory() only checks presence, not limits, so this
/// logic would still be needed there too.)
export function readImportedMemoryLimits(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 8; // skip magic + version
  function readVarU32() {
    let v = 0, shift = 0;
    for (;;) {
      const b = view.getUint8(i); i++;
      v |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return v >>> 0;
      shift += 7;
    }
  }
  while (i < bytes.length) {
    const sectionId = view.getUint8(i); i++;
    const size = readVarU32();
    const sectionEnd = i + size;
    if (sectionId === 2) { // import section
      const count = readVarU32();
      for (let n = 0; n < count; n++) {
        const modLen = readVarU32(); i += modLen; // module name (skip)
        const nameLen = readVarU32();
        const name = new TextDecoder().decode(bytes.subarray(i, i + nameLen));
        i += nameLen;
        const kind = view.getUint8(i); i++;
        if (kind === 2) { // memory
          const flags = view.getUint8(i); i++;
          const min = readVarU32();
          const max = (flags & 1) ? readVarU32() : undefined;
          if (name === 'memory')
            return { min, max, shared: !!(flags & 2) };
        } else if (kind === 0) { // func -- typeidx
          readVarU32();
        } else if (kind === 1) { // table
          i++; // reftype
          const tflags = view.getUint8(i); i++;
          readVarU32();
          if (tflags & 1) readVarU32();
        } else if (kind === 3) { // global
          i++; // valtype
          i++; // mutability
        }
      }
    }
    i = sectionEnd;
  }
  return null; // module doesn't import memory -- not a threads build
}

/// Build a plain object duck-typing a WebAssembly.Instance for node:wasi's
/// benefit -- see the file-level comment for why. Pass `forThread: true`
/// for anything that isn't the main/command instance (i.e. every spawned
/// thread): its `_start` gets removed so `wasi.initialize()` accepts it.
export function makeFakeInstance(instance, memory, { forThread } = {}) {
  const exports = { ...instance.exports, memory };
  if (forThread)
    delete exports._start;
  return { exports };
}

/// Build the `wasi.thread-spawn(startArg) -> tid` import function, shared
/// (by construction -- the same tidCounter SharedArrayBuffer) across the
/// main instance and every thread it (recursively) spawns. Returns
/// synchronously, per real pthread_create() semantics: a thread is
/// considered "spawned" the moment it's created, not when it finishes --
/// unlike subprocess spawn, this never has to block on Atomics.wait.
export function makeThreadSpawn({ wasmPath, memory, preopens, tidCounter }) {
  return function threadSpawn(startArg) {
    const tid = Atomics.add(tidCounter, 0, 1);
    const worker = new Worker(threadWorkerScript, {
      workerData: { wasmPath, memory, tid, startArg, preopens, tidCounterSAB: tidCounter.buffer },
    });
    worker.on('error', (err) => {
      console.error(`wasi_thread_hook: thread ${tid} worker error:`, err);
    });
    worker.on('message', (msg) => {
      if (msg.log) console.error(`[thread ${tid}] ${msg.log}`);
    });
    return tid;
  };
}

export async function loadModule(wasmPath) {
  const bytes = await readFile(wasmPath);
  return { bytes, module: await WebAssembly.compile(bytes) };
}

/// Convenience wrapper for the common case: instantiate a wasi-threads
/// module (main/top-level instance, not a spawned thread) against a fresh
/// shared memory + thread-spawn hook, layered onto whatever import object
/// the caller already built (e.g. from `wasi.getImportObject()`, plus
/// wasi_spawn_shim.mjs's subprocess-spawn hook if relevant). Each call gets
/// its *own* tid counter -- every top-level instance is an independent
/// "process" as far as thread-id numbering goes, even though the same
/// wasmPath/module is reused across many such calls (e.g. one per file in
/// run_clang_parallel_smoketest.mjs).
///
/// Returns `{ instance, memory }`; pass both to
/// `makeFakeInstance(instance, memory)` before `wasi.start()`/
/// `wasi.initialize()`, and to `installSpawnHook(instance, { ..., memory })`
/// if also installing the subprocess-spawn hook.
export async function instantiateThreaded(wasmModule, bytes, importObjectBase, { wasmPath, preopens }) {
  const limits = readImportedMemoryLimits(bytes);
  if (!limits)
    throw new Error(`${wasmPath}: does not import memory -- not built with wasi-threads support`);
  const { min, max, shared } = limits;
  if (!shared || max === undefined)
    throw new Error(`${wasmPath}: memory is not shared+bounded -- needs ` +
      '-Wl,--import-memory -Wl,--shared-memory and an explicit -Wl,--max-memory');

  const memory = new WebAssembly.Memory({ initial: min, maximum: max, shared: true });
  const tidCounter = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(tidCounter, 0, 1); // 0 is conventionally the main thread

  const importObject = { ...importObjectBase };
  importObject.env = { ...importObjectBase.env, memory };
  importObject.wasi = {
    ...importObjectBase.wasi,
    'thread-spawn': makeThreadSpawn({ wasmPath, memory, preopens, tidCounter }),
  };

  const instance = await WebAssembly.instantiate(wasmModule, importObject);
  return { instance, memory };
}
