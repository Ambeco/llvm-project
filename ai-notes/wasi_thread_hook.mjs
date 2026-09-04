// Prototype: real wasi-threads support (Node worker_threads + a genuinely
// shared WebAssembly.Memory), separate from wasi_spawn_shim.mjs's
// subprocess-spawn hook. Different ABI, different mechanism:
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
// I/O-owner + RPC" note there). This prototype's test program does no
// file I/O at all, so it doesn't need to answer that question yet.

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const threadWorkerScript = fileURLToPath(new URL('./wasi_thread_worker.mjs', import.meta.url));

/// Parse the wasm import section by hand to find `env.memory`'s declared
/// min/max page counts -- WebAssembly.Module.imports() doesn't expose
/// memory limits (only kind/module/name), but the engine validates a
/// supplied WebAssembly.Memory against these limits at instantiation, so
/// we need the real numbers, not guesses.
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
  throw new Error('no imported memory found in module');
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
