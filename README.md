# The LLVM Compiler Infrastructure

[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/llvm/llvm-project/badge)](https://securityscorecards.dev/viewer/?uri=github.com/llvm/llvm-project)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/8273/badge)](https://www.bestpractices.dev/projects/8273)
[![libc++](https://github.com/llvm/llvm-project/actions/workflows/libcxx-pr-conformance-tests.yaml/badge.svg?branch=main&event=schedule)](https://github.com/llvm/llvm-project/actions/workflows/libcxx-pr-conformance-tests.yaml?query=event%3Aschedule)

## About this fork

This fork of Clang is a testing ground from [mainline
Clang](https://github.com/llvm/llvm-project) for some minor adjustments
enabling Clang to be compiled to wasi+wasm, for eventual use in a Visual
Studio Code for Web extension that compiles and runs (and ideally debugs)
C++ programs without any local install. It's built with `wasi-sdk` against
the `wasm32-wasip1-threads` target (clang.wasm/lld.wasm run with real
`LLVM_ENABLE_THREADS=ON` multithreading; *compiled output* still defaults
to plain, non-threaded `wasm32-wasip1` unless the user asks otherwise);
see `build.bat` for the full toolchain invocation.

### Changes

History is split across two branches, on the theory that upstream LLVM
should only ever be asked to take the first kind of change below:

- **`upstream-fixes`**: changes defensible on their own terms, independent
  of this fork's goals -- an outright bug (wrong on every platform, not just
  WASI), or a platform-support fallback that mechanically extends a pattern
  the codebase already uses elsewhere for a comparable degraded platform
  (AIX, Haiku, Emscripten, etc.), inventing no new policy.
- **`wasm-wasi`** (based on `upstream-fixes`): everything above, plus
  changes that assert a stance specific to this project -- most notably,
  "when we can't implement something, fail loudly instead of guessing" for
  the gaps nothing else in LLVM has ever had to paper over (WASI has no
  process model and no signal delivery at all, not just a smaller one).

#### `upstream-fixes`

(Originally included a fix for a real upstream typo -- `Compiler.h`
checked the never-defined `__WASM__` instead of `__wasm__` -- but once
this branch was rebased onto `llvm-project`'s current `main`, that
cherry-pick came back empty: the typo was already fixed independently
upstream. Dropped from this branch as redundant; not something to redo.)

- `llvm/include/llvm/ADT/bit.h`: recognize `__wasi__` as a platform with a
  usable `<endian.h>` (wasi-libc has one; it just wasn't in the OS list).
- `llvm/cmake/modules/HandleLLVMOptions.cmake`: treat the wasm32-wasi target
  as Unix-like (`LLVM_ON_UNIX=1`) so LLVMSupport's `Unix/*.inc` platform
  implementations get compiled at all, instead of neither the Unix nor the
  Windows ones. Mirrors the existing precedent for Emscripten (POSIX-ish
  libc, not a real Unix kernel), which already gets `LLVM_ON_UNIX=1` via
  CMake's own `UNIX` variable; WASI just doesn't trip that variable the way
  Emscripten's toolchain does.
- `llvm/lib/Support/Unix/Unix.h`: guard the `<sys/wait.h>` include, which
  doesn't exist on WASI.
- `llvm/lib/Support/ProgramStack.cpp`: no `RLIMIT_STACK`; falls back to the
  same fixed 8MiB default already used on non-Unix platforms.
- `clang/tools/driver/cc1_main.cpp`: same `RLIMIT_STACK` gap as
  `ProgramStack.cpp` above, reached via `CLANG_HAVE_RLIMITS` (a
  `check_include_file(sys/resource.h)` check that only confirms the header
  exists, not that its rlimit content is usable on WASI). The file already
  had an empty-stub fallback for platforms without rlimits; WASI now takes
  that path too.
- `llvm/lib/Support/Unix/Process.inc`: no core dumps to prevent (already
  true), no `TIOCGWINSZ` (terminal width falls back to 0/`$COLUMNS`), no
  signal masking needed around closing a file descriptor (there are no
  signals to mask).
- `llvm/lib/Support/Unix/Path.inc`: no user database (tilde-username
  expansion and the `getpwuid_r` home-directory fallback fail gracefully,
  same as an ordinary lookup failure), no `posix_madvise` (no-op, same as
  other platforms without madvise), no `umask`/real `fchown`, no on-disk
  path for the running executable (`getMainExecutable` returns `""`).
- `llvm/lib/Support/LockFileManager.cpp`: no `getsid()` to check whether a
  lock's owning process is still alive, and no real multi-process contention
  to detect in the first place on this target (each build runs in its own
  isolated module instance). Conservatively assume the lock is held.
  Reclassified here from an earlier pass that put it on `wasm-wasi` as a
  "policy choice" -- [llvm/llvm-project#92677](https://github.com/llvm/llvm-project/pull/92677)
  reaches the identical fix via the identical reasoning, which is real
  external validation this is a mechanical fallback like the rest of this
  list, not a project-specific stance.
- `llvm/lib/Support/Unix/Program.inc`: real subprocess spawning
  (`Execute`/`Wait`, i.e. `posix_spawn`) doesn't exist on WASI. `Execute()`
  now calls through `CurrentSpawnHook`, a plain C function pointer -- on
  wasm32 that's just an index into the module's own indirect-call table, so
  this needs **no wasm import and no host cooperation** just to link or
  instantiate the module; it defaults to a stub that fails loudly
  (`report_fatal_error`). This is genuinely self-contained, not a
  project-specific policy call: a host that wants real subprocess support
  can, *after* instantiation, grow the module's exported indirect-call
  table (module must be linked with `--export-table`/`--growable-table`;
  see below), write its own function into the new slot, and call the
  exported `__wasi_shim_set_spawn_hook()` to install it -- entirely
  optional, entirely post-instantiation. See `wasm-wasi`'s
  `ai-notes/wasi_spawn_shim.mjs` for a reference host doing exactly this,
  and "JS Framework" below for what a real host provides.

#### `wasm-wasi` (additionally)

- `llvm/lib/Support/CrashRecoveryContext.cpp`: WASI has no signal delivery
  and no working `setjmp`/`longjmp`, so real crash recovery is impossible in
  a single module instance; `Enable()` now fails loudly instead of silently
  pretending to work. The build relies on `-DCLANG_SPAWN_CC1=ON` (see
  `build.bat`) so `Enable()` is never actually called by the driver.
- `llvm/lib/Support/Unix/Signals.inc`: WASI can't install real signal
  handlers, so handler registration (crash backtraces, Ctrl-C, cleanup-on-
  signal) becomes a silent no-op -- nothing depends on it succeeding. The
  underlying cleanup machinery (`RemoveFileOnSignal`, `RunInterruptHandlers`,
  `CleanupOnSignal`) stays fully functional and exported, for a JS host to
  call directly instead of relying on a signal to trigger it. **Deliberately
  different from [#92677](https://github.com/llvm/llvm-project/pull/92677)'s
  approach**: that PR intercepts one layer up, in `Signals.cpp` itself
  (bypassing `Unix/Signals.inc` for WASI entirely), and stubs
  `RunInterruptHandlers`/`RemoveFileOnSignal`/`CleanupOnSignal` to silent
  no-ops along with everything else. That would make our own JS-host cleanup
  contract (see "JS Framework" below) impossible to implement -- those three
  functions have to stay real for a host to call them. Not a style choice.
- `llvm/lib/Support/Unix/Watchdog.inc`: no `alarm()`/signals, so the
  watchdog timer is a no-op; real timeout enforcement is expected to happen
  by the JS host terminating the Worker (see below).
- `llvm/lib/Support/raw_socket_stream.cpp`: no BSD sockets API on WASI;
  socket operations fail loudly rather than silently.

### Build note: link libraries

`build.bat` links against `-lwasi-emulated-signal -lwasi-emulated-getpid
-lwasi-emulated-mman -lwasi-emulated-process-clocks -ldl` -- all real,
first-party libraries wasi-sdk ships (found by reading the `#error` text in
the relevant sysroot headers, or by checking `lib/wasm32-wasip1/` directly
for `-ldl`). `_GNU_SOURCE` is also set globally in `CMAKE_C_FLAGS`/
`CMAKE_CXX_FLAGS`: wasi-libc's `features.h` auto-enables POSIX-visibility
declarations unless `__STRICT_ANSI__` is defined, which LLVM's `-std=c++17`
(not `-std=gnu++17`) does -- this one flag fixed a large batch of
`sigfillset`/`siginfo_t`/`SA_NODEFER`-style "undeclared identifier" errors
that individually looked like missing-symbol bugs. `-Wl,--export-table
-Wl,--growable-table` are also required, for `Unix/Program.inc`'s spawn
hook (see above): the first exports the module's indirect-call table so a
JS host can find it at all, the second removes its fixed maximum size so
`Table.prototype.grow()` doesn't fail once a host tries to add a slot to it.

### JS Framework

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
     `-Wl,--export-table -Wl,--growable-table`; see "Build note" above).
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
    `Unix/Watchdog.inc` above);
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
  **Genuinely open, not addressed**: real file I/O consistency across
  threads (multiple threads of one process doing concurrent
  `fd_read`/`fd_write` against the same mounted filesystem) -- the
  standalone prototype does no file I/O at all, so it sidesteps this
  entirely. See `ai-notes/wip.md` for an assessment of the options (a
  centralized I/O-owner thread other threads RPC to, versus each thread
  doing real I/O with `pread`-style explicit offsets) -- leaning toward
  the RPC approach, since it reuses the same synchronous cross-worker
  pattern already proven for subprocess spawning, but neither is
  implemented.

Welcome to the LLVM project!

This repository contains the source code for LLVM, a toolkit for the
construction of highly optimized compilers, optimizers, and run-time
environments.

The LLVM project has multiple components. The core of the project is
itself called "LLVM". This contains all of the tools, libraries, and header
files needed to process intermediate representations and convert them into
object files. Tools include an assembler, disassembler, bitcode analyzer, and
bitcode optimizer.

C-like languages use the [Clang](https://clang.llvm.org/) frontend. This
component compiles C, C++, Objective-C, and Objective-C++ code into LLVM bitcode
-- and from there into object files, using LLVM.

Other components include:
the [libc++ C++ standard library](https://libcxx.llvm.org),
the [LLD linker](https://lld.llvm.org), and more.

## Getting the Source Code and Building LLVM

Consult the
[Getting Started with LLVM](https://llvm.org/docs/GettingStarted.html#getting-the-source-code-and-building-llvm)
page for information on building and running LLVM.

For information on how to contribute to the LLVM project, please take a look at
the [Contributing to LLVM](https://llvm.org/docs/Contributing.html) guide.

## Getting in touch

Join the [LLVM Discourse forums](https://discourse.llvm.org/), [Discord
chat](https://discord.gg/xS7Z362),
[LLVM Office Hours](https://llvm.org/docs/GettingInvolved.html#office-hours) or
[Regular sync-ups](https://llvm.org/docs/GettingInvolved.html#online-sync-ups).

The LLVM project has adopted a [code of conduct](https://llvm.org/docs/CodeOfConduct.html) for
participants to all modes of communication within the project.
