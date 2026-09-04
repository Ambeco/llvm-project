// Reference implementation of the `env.__wasi_shim_spawn_sync` import that
// llvm/lib/Support/Unix/Program.inc's WASI Execute() calls out to (see that
// file for the wire-format comment this decodes). This is a *minimal proof
// of concept*, not the real VS Code for Web extension: it uses Node's
// worker_threads + Atomics.wait to block the calling wasm instance
// synchronously, matching the "run compiles in a Worker" shape described in
// README.md's "JS Framework" section, but with a real OS-thread Worker
// instead of a browser Worker.
//
// Not implemented here (left for the real extension): I/O redirection,
// timeouts, detached/background processes, resource-usage stats -- the
// Program.inc patch fails loudly (report_fatal_error) if any of those are
// requested, so this shim never has to reject a request that the wasm side
// would otherwise silently trust.

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const workerScript = fileURLToPath(new URL('./wasi_spawn_worker.mjs', import.meta.url));

/// Decode the Program.inc wire format: a little-endian blob of
///   u32 argc; argc * (u32 len, bytes)
///   u32 envc; envc * (u32 len, bytes)     -- envc == 0xFFFFFFFF means inherit
function decodeSpawnBlob(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0;
  function readU32() {
    const v = view.getUint32(off, /*littleEndian=*/true);
    off += 4;
    return v;
  }
  function readStrings(count) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const len = readU32();
      out.push(Buffer.from(bytes.buffer, bytes.byteOffset + off, len).toString('utf8'));
      off += len;
    }
    return out;
  }

  const argc = readU32();
  const argv = readStrings(argc);
  const envc = readU32();
  const env = envc === 0xFFFFFFFF ? null : readStrings(envc);
  return { argv, env };
}

/// Resolve a WASI guest path (as seen by the calling instance, e.g.
/// "/bin/wasm-ld") to a real host filesystem path, using the same preopen
/// map the instance itself was configured with. Picks the longest matching
/// preopen prefix (so e.g. both "/" and "/bin" being preopened resolves
/// "/bin/wasm-ld" against "/bin", not "/"). Returns null if nothing matches
/// -- the caller falls back to spawning the *same* binary that's doing the
/// spawning, which is correct for cc1 (argv[0] is "" there -- see
/// Unix/Program.inc and CC1Command::Execute -- since cc1 lives in the same
/// clang.wasm binary rather than being a separate executable on disk).
function resolveGuestPath(preopens, guestPath) {
  let bestPrefix = null;
  for (const guestPrefix of Object.keys(preopens)) {
    if ((guestPath === guestPrefix || guestPath.startsWith(guestPrefix + '/')) &&
        (bestPrefix === null || guestPrefix.length > bestPrefix.length)) {
      bestPrefix = guestPrefix;
    }
  }
  if (bestPrefix === null)
    return null;
  const hostDir = preopens[bestPrefix];
  const rest = guestPath.slice(bestPrefix.length).replace(/^\/+/, '');
  return rest ? `${hostDir}/${rest}` : hostDir;
}

/// Build the `env.__wasi_shim_spawn_sync(ptr, len) -> i32` import for a wasm
/// instance. `memoryRef` is a `{ current: WebAssembly.Memory }` box so the
/// import can be created before the instance (and thus its memory export)
/// exists -- fill in `memoryRef.current` right after instantiation.
/// `preopens`/`defaultWasmPath` describe how to set up the *child* instance
/// that actually runs the spawned argv (matching the parent's own view of
/// the filesystem, since the spawned program -- cc1 or wasm-ld -- expects to
/// see the same preopened directories the driver does). `defaultWasmPath` is
/// used when argv[0] doesn't resolve to a real file via `preopens` (the
/// cc1-in-the-same-binary case above); when it does resolve (e.g. an actual
/// `wasm-ld` binary path), that resolved file is loaded instead.
export function makeSpawnSyncImport({ memoryRef, wasmPath: defaultWasmPath, preopens }) {
  return function __wasi_shim_spawn_sync(ptr, len) {
    const bytes = new Uint8Array(memoryRef.current.buffer, ptr, len);
    // Copy out of wasm memory before handing off to the worker (structured
    // clone of a view into a growable ArrayBuffer would be unsafe otherwise).
    const blobCopy = bytes.slice();
    const { argv, env } = decodeSpawnBlob(blobCopy);

    const resolved = argv[0] ? resolveGuestPath(preopens, argv[0]) : null;
    const wasmPath = resolved ?? defaultWasmPath;

    // [0] = 0 while running, 1 once the worker has written the exit code.
    // [1] = the exit code itself, once [0] is 1.
    const sab = new SharedArrayBuffer(8);
    const status = new Int32Array(sab);
    Atomics.store(status, 0, 0);

    const worker = new Worker(workerScript, {
      workerData: { wasmPath, argv, env, preopens, sab },
    });
    // Errors the worker couldn't itself catch (e.g. it crashed before
    // installing its own handler) still need to unblock the wait below,
    // otherwise a bug here hangs the parent forever instead of failing.
    worker.on('error', (err) => {
      console.error('wasi_spawn_shim: child worker error:', err);
      Atomics.store(status, 1, -1);
      Atomics.store(status, 0, 1);
      Atomics.notify(status, 0);
    });

    console.error(`wasi_spawn_shim: spawning ${argv.join(' ')}`);
    Atomics.wait(status, 0, 0); // Blocks this thread -- see Program.inc.
    worker.terminate();

    const exitCode = Atomics.load(status, 1);
    console.error(`wasi_spawn_shim: child exited with code ${exitCode}`);
    return exitCode;
  };
}
