// Reference implementation of the spawn hook llvm/lib/Support/Unix/
// Program.inc's WASI Execute() calls through (see that file for the
// wire-format comment this decodes). No wasm import is required to
// instantiate clang.wasm -- it's self-contained by default, failing loudly
// (report_fatal_error) if anything tries to spawn a subprocess without a
// hook installed. installSpawnHook() below is how a host opts in to real
// subprocess support *after* instantiation: it wraps a JS callback as a
// typed wasm function (WebAssembly.Function -- needs Node's
// --experimental-wasm-type-reflection flag), places it into the module's
// own exported indirect-call table (needs the module linked with
// -Wl,--export-table -- see build.bat), and calls the module's exported
// __wasi_shim_set_spawn_hook() to point Program.inc's function-pointer hook
// at that new table slot.
//
// This is a *minimal proof of concept*, not the real VS Code for Web
// extension: it uses Node's worker_threads + Atomics.wait to block the
// calling wasm instance synchronously, matching the "run compiles in a
// Worker" shape described in README.md's "JS Framework" section, but with a
// real OS-thread Worker instead of a browser Worker.
//
// Not implemented here (left for the real extension): I/O redirection,
// timeouts, detached/background processes, resource-usage stats -- the
// Program.inc patch fails loudly (report_fatal_error) if any of those are
// requested, so this shim never has to reject a request that the wasm side
// would otherwise silently trust.

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const workerScript = fileURLToPath(new URL('./wasi_spawn_worker.mjs', import.meta.url));

/// build/lib/clang/<N> is named after the LLVM major version, which changes
/// on every dev cycle (23 -> 24 already happened once this session, when
/// this repo got rebased onto llvm-project's current main); a stale build/
/// dir can leave more than one such directory behind, so pick the highest
/// numbered one rather than hardcoding a version that will eventually go
/// stale again.
export async function findResourceDir(clangLibDir) {
  const entries = (await readdir(clangLibDir)).filter((e) => /^\d+$/.test(e));
  if (entries.length === 0)
    throw new Error(`No versioned resource dir found under ${clangLibDir}`);
  entries.sort((a, b) => Number(b) - Number(a));
  return path.join(clangLibDir, entries[0]);
}

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

/// Install real subprocess-spawn support into an *already-instantiated*
/// wasm instance, via the exported-table + function-pointer-hook mechanism
/// documented in Unix/Program.inc. `instance` must come from a module
/// linked with -Wl,--export-table (see build.bat). `preopens`/
/// `defaultWasmPath` describe how to set up the *child* instance that
/// actually runs the spawned argv (matching the parent's own view of the
/// filesystem, since the spawned program -- cc1 or wasm-ld -- expects to
/// see the same preopened directories the driver does). `defaultWasmPath`
/// is used when argv[0] doesn't resolve to a real file via `preopens` (the
/// cc1-in-the-same-binary case -- see resolveGuestPath below); when it does
/// resolve (e.g. an actual `wasm-ld` binary path), that resolved file is
/// loaded for the child instead.
///
/// Requires Node's --experimental-wasm-type-reflection flag (for
/// WebAssembly.Function -- unflagged in modern browsers already, this is
/// purely a Node-reference-host requirement).
///
/// `memory` is optional: pass it explicitly for a wasi-threads build
/// (whose memory is *imported*, so `instance.exports.memory` doesn't
/// exist -- see wasi_thread_hook.mjs); omitted, this falls back to
/// `instance.exports.memory`, correct for a non-threaded build.
export function installSpawnHook(instance, { wasmPath: defaultWasmPath, preopens, memory }) {
  const table = instance.exports.__indirect_function_table;
  if (!table) {
    throw new Error(
      'wasi_spawn_shim: instance has no exported __indirect_function_table -- ' +
      'was clang.wasm linked with -Wl,--export-table? (see build.bat)');
  }
  const mem = memory ?? instance.exports.memory;

  function spawnSync(ptr, len) {
    const bytes = new Uint8Array(mem.buffer, ptr, len);
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
  }

  // Program.inc's SpawnHookFn is `int (*)(const uint8_t*, size_t)` --
  // pointer and size_t are both i32 on wasm32.
  const wrapped = new WebAssembly.Function(
    { parameters: ['i32', 'i32'], results: ['i32'] },
    spawnSync);

  const newIndex = table.length;
  table.grow(1);
  table.set(newIndex, wrapped);
  instance.exports.__wasi_shim_set_spawn_hook(newIndex);
}
