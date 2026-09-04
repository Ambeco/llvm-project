// worker_threads entry point spawned by wasi_spawn_shim.mjs's spawn hook.
// Runs one child invocation of clang.wasm
// (in practice, the cc1 invocation the driver in the parent instance asked
// to spawn) to completion in its own thread + its own fresh wasm instance,
// then reports the exit code back through the SharedArrayBuffer the parent
// is blocked on.
//
// This mirrors, at reference-implementation scale, the "run the compile in
// its own Worker" shape from README.md's "JS Framework" section -- a real
// VS Code for Web extension would use a browser Worker here instead of
// worker_threads, and would additionally catch a *terminated* worker (for
// interrupt handling) and render its own call stack, neither of which a
// synchronous smoke test needs.
import { readFile } from 'node:fs/promises';
import { WASI } from 'node:wasi';
import { workerData } from 'node:worker_threads';
import { installSpawnHook } from './wasi_spawn_shim.mjs';

const { wasmPath, argv, env, preopens, sab } = workerData;
const status = new Int32Array(sab);

function reportExit(code) {
  Atomics.store(status, 1, code);
  Atomics.store(status, 0, 1);
  Atomics.notify(status, 0);
}

try {
  const wasi = new WASI({
    version: 'preview1',
    args: argv,
    env: env ? Object.fromEntries(env.map((kv) => {
      const eq = kv.indexOf('=');
      return [kv.slice(0, eq), kv.slice(eq + 1)];
    })) : process.env,
    preopens,
  });

  const bytes = await readFile(wasmPath);
  const wasmModule = await WebAssembly.compile(bytes);

  // No custom imports needed to instantiate -- see Unix/Program.inc: the
  // spawn hook is an optional post-instantiation extension point, not a
  // required wasm import.
  const instance = await WebAssembly.instantiate(wasmModule, wasi.getImportObject());

  // Recursion support: if this child itself needs to spawn a grandchild
  // (e.g. a future assembler invocation), install the same hook, pointed at
  // the same wasm binary and preopens. Best-effort: a leaf binary that
  // never itself calls ExecuteAndWait (e.g. wasm-ld, in the current smoke
  // tests) may have had Program.cpp's WASI code -- and so this export --
  // dead-stripped by the linker, so skip installing rather than hard-fail.
  if (instance.exports.__wasi_shim_set_spawn_hook)
    installSpawnHook(instance, { wasmPath, preopens });

  let exitCode = 0;
  try {
    // node:wasi's start() returns the proc_exit() code directly on a clean
    // exit; it only throws for an actual trap/abort (e.g. our own
    // report_fatal_error calls), in which case there's no well-defined exit
    // code to report beyond "something went wrong".
    const ret = wasi.start(instance);
    if (typeof ret === 'number')
      exitCode = ret;
  } catch (e) {
    console.error('wasi_spawn_worker: child instance trapped:', e);
    exitCode = -1;
  }
  reportExit(exitCode);
} catch (e) {
  console.error('wasi_spawn_worker: failed to run child:', e);
  reportExit(-1);
}
