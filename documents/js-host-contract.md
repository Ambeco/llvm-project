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

  **Implemented** as a proof of concept in `wasi-tests/wasi_spawn_shim.mjs`
  (`installSpawnHook()`) + `wasi-tests/wasi_spawn_worker.mjs`, using Node
  `worker_threads` + `Atomics.wait` to block the calling instance
  synchronously while a second wasm instance (in its own Worker) runs the
  child to completion -- resolving, per spawn request, to either the
  *same* wasm module (`cc1`, which lives inside `clang.wasm` itself) or a
  genuinely different one (`wasm-ld`), by resolving `argv[0]` against the
  preopen map (see `resolveGuestPath()` in the shim). Verified end to end
  by `wasi-tests/run_clang_link_smoketest.mjs`: compiles, links, and *runs* a
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
- **Crash recovery does not exist.** `CrashRecoveryContext::Enable()` is a
  no-op on WASI, so with `-DCLANG_SPAWN_CC1=OFF` (the single-process build,
  `clang.wasm` from `build-single-threaded.bat`) a cc1 crash traps the whole
  instance. The host must report that trap itself, and must run cleanup
  (see above) since the module cannot.
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
  of concept in `wasi-tests/wasi_driver_worker.mjs` +
  `wasi-tests/run_clang_parallel_smoketest.mjs`: compiling 8 files
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
  raw import section by hand, see `wasi-tests/wasi_thread_hook.mjs`'s
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
  **Implemented** in `wasi-tests/wasi_thread_hook.mjs` +
  `wasi-tests/wasi_thread_worker.mjs`; verified end to end both standalone
  (`wasi-tests/run_wasi_threads_prototype.mjs`: 4 real pthreads, a
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
  threaded. **Verified working**: `wasi-tests/run_clang_threaded_output_smoketest.mjs`
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

## clangd.wasm (single-threaded build)

`build-single-threaded/bin/clangd.wasm` is a plain WASI command (no
imports beyond `wasi_snapshot_preview1`, no threads, no spawn hook). Run it as
`clangd -sync -background-index=false` plus the arguments below; verified by
`wasi-tests/run_clangd_tests.mjs` (file-fed sessions) and
`wasi-tests/run_clangd_stream_tests.mjs` (real pipes).

- **Transport:** LSP JSON-RPC over fd 0 / fd 1, `Content-Length` framing. The
  host must keep both open for the whole session (a long-lived stream, unlike
  a one-shot compile). Closing stdin ends clangd (exit code 1 unless
  `shutdown` + `exit` came first). Server-to-client requests such as
  `workspace/applyEdit` must be answered.
- **Preopens:** the workspace (any path; project files are addressed by the
  `file://` URIs the client sends), the sysroot and clang resource dir
  (read-only is fine), and a **writable `/tmp`** -- preamble PCHs are temp
  files, and without it every preamble build fails with "Could not create
  temporary file for PCH". Pass the resource dir explicitly
  (`--resource-dir=...` or `-resource-dir=` in the compile flags);
  auto-detection fails and logs an error.
- **Compile flags:** from `compile_commands.json` (`-compile-commands-dir=`),
  or injected by the client via `workspace/didChangeConfiguration` with
  `compilationDatabaseChanges` (no file needed; this is the intended
  vscwClang path). Use the flags in `compile-flags.json` (explicit libc++
  `-isystem`s; `node:wasi` on Windows cannot list directories, so include-path
  auto-detection finds nothing).
- **Reloads:** clangd re-stats `compile_commands.json` at most every 5 s
  (`RevalidateAfter`); `didChangeWatchedFiles` does not bypass that. Edited
  headers on disk are picked up on the next `didChange` of a file that
  includes them. By default headers are read from disk, not from unsaved
  editor buffers; pass `-use-dirty-headers` to use open buffers.
- **No background index:** `-background-index` is a startup error in this
  build. Project-wide symbols come from the dynamic index of files the client
  has opened, and `didOpen` followed by `didClose` leaves a file's symbols in
  it (the "sweep"; ~1.5 s per file with a few std headers). Nothing persists.
- **Include-path completion** (`#include "ut|`) returned nothing under
  `node:wasi` on Windows, probably the same missing directory listing; recheck
  on the real host.
- **Stdin quirk:** Node's `node:wasi` `fd_read` on a Windows pipe corrupts a
  large buffered `fread` when the pipe delivers a short read (the bytes land in
  stdio's buffer, not the destination). clangd's transport reads message
  bodies with `getc_unlocked` under `__wasi__` to avoid it; a host with a
  sound `fd_read` is unaffected either way.

