// Reconstructs lldb-wasm-reactor.wasm's `wasm_dbg` import module inside a
// spawned wasi-thread worker (see wasi_thread_hook.mjs's `makeThreadSpawn`
// doc comment for why this can't just be passed a function directly).
// `config` is whatever cloneable data a real host needs to rebuild
// equivalent read_memory/write_memory closures -- run_lldb_wasm_reactor_smoketest.mjs
// doesn't stop the target at a real address, so its own closures always
// throw; this file mirrors that same "loud, not silent" behavior for
// spawned threads rather than defaulting to a silent short-read.
export function buildImports(config, { memory }) {
  return {
    wasm_dbg: {
      read_memory() { throw new Error('unexpected read_memory call in this smoketest'); },
      write_memory() { throw new Error('unexpected write_memory call in this smoketest'); },
    },
  };
}
