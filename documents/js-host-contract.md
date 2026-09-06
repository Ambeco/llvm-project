# The JS host contract: what hosting JavaScript must provide

This is the canonical, exact recipe for what a JavaScript host must do to
run `clang.wasm`/`lld.wasm` (the threaded build) or any `-pthread`
WASI-threads output binary they produce. `documents/threaded-file-io-rpc-plan.md`
and other docs refer back to this file as the authoritative copy of this
contract — if anything elsewhere in `documents/` ever seems to disagree
with this file, trust this file and fix the other one.

Moved here from README.md's old "JS Framework" section, unchanged in
substance, so the README can stay a short fork summary instead of a full
API reference.

Running the resulting `clang.wasm` requires the hosting JavaScript to
provide functionality no WASI host does by default:

- **Install a spawn hook after instantiation**, to unlock functionality
  that otherwise fails loudly the moment anything tries to use it. No wasm
  import is required for `clang.wasm` to instantiate at all -- see
  `Unix/Program.inc` for why this is a table-indirect function pointer, not
  an import. A host that wants real subprocess support (needed for `cc1`
  invocation -- the build forces `-DCLANG_SPAWN_CC1=ON`, so every `cc1`
  invocation goes through this path -- and for invoking `wasm-ld` for
  linking) does, after `WebAssembly.instantiate()`:
  1. Grow `instance.exports.__indirect_function_table` by one slot
     (`table.grow(1)` -- needs the module linked with
     `-Wl,--export-table -Wl,--growable-table`; see `documents/notes.md`).
  2. Wrap a JS callback as a typed wasm function
     (`new WebAssembly.Function({parameters: ['i32','i32'], results:
     ['i32']}, jsFn)` -- needs Node's `--experimental-wasm-type-reflection`
     flag; unflagged in modern browsers already) and write it into that
     slot (`table.set(newIndex, wrapped)`).
  3. Call `instance.exports.__wasi_shim_set_spawn_hook(newIndex)`.

  **Implemented** as a proof of concept in `ai-notes/wasi_spawn_shim.mjs`
  (`installSpawnHook()`) + `ai-notes/wasi_spawn_worker.mjs`, using Node
  `worker_threads` + `Atomics.wait` to block the calling instance
  synchronously while a second wasm instance (in its own Worker) runs the
  child to completion -- resolving, per spawn request, to either the
  *same* wasm module (`cc1`, which lives inside `clang.wasm` itself) or a
  genuinely different one (`wasm-ld`), by resolving `argv[0]` against the
  preopen map (see `resolveGuestPath()` in the shim). Verified end to end
  by `ai-notes/run_clang_link_smoketest.mjs`: compiles, links, and *runs* a
  real "Hello, world!" through this exact path. A real extension should
  follow the same shape with a browser Worker instead: decode the wire
  format documented next to `CurrentSpawnHook` in `Unix/Program.inc`,
  resolve which binary to load, run the child argv in a fresh Worker +
  wasm instance, and resolve with its exit code.
  - (Lower priority) a Unix-domain-socket primitive backing
    `raw_socket_stream`/`ListeningSocket`, if some future feature needs it.
    Nothing in a normal compile currently does.
- **Run the compile in its own Web Worker**, separate from whatever drives
  it, so that:
  - it can be interrupted/killed by terminating the Worker (WASI has no
    Ctrl-C/signal equivalent -- see `Unix/Signals.inc` and
    `Unix/Watchdog.inc`, described in `documents/design.md`'s per-file
    change list);
  - that Worker should catch the resulting exception (a terminated Worker
    surfaces as one) and render the call stack itself -- in-wasm backtrace
    printing is unavailable (no `siginfo_t`, no symbol info from `dladdr`);
  - when the hosting JS terminates the Worker (whether for an interrupt or a
    detected crash), **it is the hosting JS's responsibility**, not the
    Worker's, to invoke the cleanup entry point
    (`llvm::sys::RunInterruptHandlers()` / `CleanupOnSignal()`) to remove any
    temp files the compile registered before it died.
- **Never call `CrashRecoveryContext::Enable()`** (directly or by flipping
  `-DCLANG_SPAWN_CC1=OFF`) without also implementing real crash recovery --
  it's wired to fail loudly specifically because there's no way to honor it.
- (Optional) provide a `$COLUMNS` environment variable if terminal-width-
  aware output formatting matters; there's no `ioctl`/`TIOCGWINSZ` to query
  it from.
- **For compiling multiple files, run one driver instance per file
  concurrently** rather than one driver invocation per file in sequence.
  Each top-level `clang.wasm` instance is already fully isolated (its own
  linear memory, no sharing) the moment it's instantiated, so this needs
  no wasm-side changes at all -- just run N Workers, each doing its own
  `WebAssembly.instantiate` + `installSpawnHook` + `wasi.start()`, same
  shape as the single-file case just repeated. **Implemented** as a proof
  of concept in `ai-notes/wasi_driver_worker.mjs` +
  `ai-notes/run_clang_parallel_smoketest.mjs`: compiling 8 files
  concurrently this way took ~156ms wall-clock vs. ~89ms for 1 file --
  nowhere near the ~712ms sequential compilation would take, confirming
  real concurrency. This is a *different* mechanism from clang.wasm's own
  real in-module multithreading (below) -- process-like isolation (no
  shared memory) versus real shared-memory threads -- and remains the
  cheaper, always-available option for the common case (an independent
  compile per file in a multi-file project), regardless of whether
  in-module threading ever helps a given single compile.
- **Real in-module multithreading is also implemented**: `clang.wasm`/
  `lld.wasm` are built against `wasm32-unknown-wasip1-threads` with
  `-DLLVM_ENABLE_THREADS=ON` (see `build.bat`) -- real `std::thread`/
  pthreads, real shared `WebAssembly.Memory`, real `wasi.thread-spawn`.
  This needs a host that supplies the "install a spawn hook" mechanism
  above *and* separately implements the `wasi-threads` ABI: construct a
  shared `WebAssembly.Memory` matching the module's declared min/max
  limits (`WebAssembly.Module.imports()` doesn't expose these -- parse the
  raw import section by hand, see `ai-notes/wasi_thread_hook.mjs`'s
  `readImportedMemoryLimits()`), supply it as `env.memory` to every
  instance (including the first/main one -- the module no longer owns its
  memory at all), and implement `wasi.thread-spawn(start_arg) -> tid`: on
  each call, spin up a Worker, instantiate the same module against that
  same shared memory, and call its exported `wasi_thread_start(tid,
  start_arg)`. Unlike subprocess spawn, this never has to block: real
  `pthread_create()` semantics return as soon as the thread exists, not
  when it finishes, so the host just allocates a `tid` and returns.
  Mutex/condvar/join synchronization needs *no* additional host code at
  all -- it's wasm's own `memory.atomic.wait32`/`notify` instructions
  operating on the shared memory, handled entirely by the engine.
  **Implemented** in `ai-notes/wasi_thread_hook.mjs` +
  `ai-notes/wasi_thread_worker.mjs`; verified end to end both standalone
  (`ai-notes/run_wasi_threads_prototype.mjs`: 4 real pthreads, a
  mutex-protected shared counter, exactly correct after concurrent
  increments) and wired into the real `clang.wasm`/`lld.wasm` build (all
  four smoke tests pass). One real host-side gotcha:
  [`node:wasi`](https://nodejs.org/api/wasi.html)'s `WASI` class
  hard-requires `instance.exports.memory` and throws otherwise -- it does
  not support a module whose memory is *imported*, which every
  wasi-threads module's must be. Worked around with `makeFakeInstance()`:
  a plain object duck-typing an `Instance` (node:wasi only ever reads
  `.exports` off whatever it's given), with `memory` added and -- for
  anything that isn't the main/command instance -- `_start` removed so
  `wasi.initialize()` doesn't refuse it. **Check whether a real browser
  WASI host (e.g. VS Code for Web's `wasm-wasi-core`) has the same
  limitation before assuming it "just works" there** -- see
  `documents/vscode-wasi-host.md` (its `host.initialize(memory ??
  instance)` fallback suggests it was actually built with this case in
  mind, unlike `node:wasi`, but this hasn't been verified by actually
  running against it).
  Two build-only gotchas, no source patch needed: `wasm-ld` defaults a
  shared memory's max to its min unless `--max-memory` is passed
  explicitly (clang started with ~7MB of heap and crashed on its first
  allocation before this was set to 2GiB), and `clang.wasm`'s own default
  target now being the `-threads` triple meant `compiler-rt`'s builtins
  needed a second, separate build pass targeting plain `wasm32-wasip1` --
  see `build.bat` and `ai-notes/wip.md` for both.
  **Not yet observed**: whether any of this project's own smoke-test
  workloads (tiny "Hello World" compiles) are actually large enough to
  trigger a real `thread-spawn` call from *clang.wasm's own internal
  work* -- `LLVM_ENABLE_THREADS=ON` only makes threading *available*;
  nothing in these particular tests has been confirmed to actually use it
  yet. (Separately, and easy to conflate with the above: whether a
  program *clang.wasm compiles* can itself use real threads is a
  completely independent question -- inherited, unmodified mainline clang
  WebAssembly driver support, unrelated to whether clang.wasm itself runs
  threaded. **Verified working**: `ai-notes/run_clang_threaded_output_smoketest.mjs`
  has clang.wasm compile+link a real 4-pthread program
  (`--target=wasm32-wasip1-threads -pthread`, plus explicit
  `-Wl,--import-memory -Wl,--max-memory=` -- not auto-added by `-pthread`,
  same as native wasi-sdk `clang++`) and runs the output through the same
  thread-hosting machinery: `counter = 400000` exactly, all 4 threads
  correctly spawn and join.)
  **Now addressed** (see `documents/threaded-file-io-rpc-plan.md`): real
  file I/O consistency across threads (multiple threads of one process
  doing concurrent `fd_read`/`fd_write` against the same mounted
  filesystem) used to be entirely open -- the standalone prototype above
  does no file I/O at all, so it sidestepped the question. Fixed via
  `compiler-rt/lib/wasi_threaded_io`, linked automatically by the driver
  into every `-pthread` WASI-threads output binary.
