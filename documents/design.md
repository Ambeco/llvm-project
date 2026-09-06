# Design: Clang/LLVM on WebAssembly/WASI for VS Code for Web

## Overall goal

Compile Clang/LLVM (`clang`, `lld`, `compiler-rt`) to `wasm32-wasip1` via
wasi-sdk, so a VS Code for Web extension can host a real, in-browser C/C++
toolchain — compiling and linking real programs entirely client-side, no
server round-trip. The toolchain build lives in this repo (a fork of
`llvm-project`); the browser-side extension that hosts it is intended to
live in its own separate repo (not started).

## Branch structure and why

Two long-lived branches, both rebased onto a shallow (`--depth=1`) fetch
of `llvm-project`'s real `main`:

- **`upstream-fixes`** — the PR-ready candidate. Scoped strictly to
  changes defensible on their own terms as upstream contributions: a
  genuine bug (two `__WASM__`/`__wasm__` typos), a mechanical extension of
  a platform-support pattern the codebase already uses elsewhere (adding
  `defined(__wasi__)` branches to existing `Unix/*.inc`-style files, the
  same shape used for every other Unix-like platform), or a mechanism
  that's genuinely self-contained and needs no host cooperation (the
  `Unix/Program.inc` spawn-hook design — see below). Deliberately excludes
  anything that only makes sense given *this project's own* opinionated
  choices.
- **`wasm-wasi`** (based on `upstream-fixes`) — everything that requires a
  JS host to do anything useful, or reflects a project-specific policy
  choice rather than a universal fix: the loud-failure-on-missing-
  functionality stance for `CrashRecoveryContext`/`Signals.inc`/
  `Watchdog.inc`/`raw_socket_stream.cpp`, all `ai-notes/` documentation and
  reference JS host scripts, `build.bat`, and the real spawn-hook
  implementation. This is what actually gets built and tested.

Rationale for the split: keep the door open to eventually upstreaming the
narrow, defensible portion, without entangling it with choices that are
specific to this project's deployment target (a browser, no real OS,
willing to fail loudly rather than silently degrade). See `ai-notes/wip.md`
for the detailed per-commit bucketing and the prior-art comparison against
[llvm/llvm-project#92677](https://github.com/llvm/llvm-project/pull/92677)
(an open, unmerged upstream PR doing very similar work — read that context
before opening any PR from `upstream-fixes`).

**Why mergeability is a real goal, not just tidiness**: this isn't the
first attempt to get Clang running on wasm/WASI — notably
[YoWASP](https://yowasp.org/), whose effort to get comparable changes into
mainline mostly stalled on the lack of wasm atomics support in LLVM as of
2024 (see the [RFC
thread](https://discourse.llvm.org/t/rfc-building-llvm-for-webassembly/79073)
and [#92677](https://github.com/llvm/llvm-project/pull/92677), which this
project builds on and compares itself against throughout). Wasm atomics
now exist, which is part of why this attempt is viable at all — but the
lesson taken from that history is to keep the upstream-defensible portion
genuinely separable from day one, rather than trying to untangle it later.
This is also why most changes are guarded behind `__wasm__`/`__wasi__`
rather than assumed, and why the single-threaded, single-process build
(`build-single-threaded.bat`) is a deliberate design goal in its own
right: a `clang.wasm` that instantiates and runs on any plain WASI host
with zero custom JavaScript is a much easier sell upstream than one that
only makes sense given this project's own browser-hosting opinions.

### Per-file change list (the branch split's evidence, not just its policy)

The paragraphs above state the *policy* for what goes on which branch;
this is the concrete list of what's actually there and why each item
belongs where it does, kept here (not in the README, which per this
project's convention doesn't retain upstream mainline structure) so it
stays attached to the design reasoning as the branches evolve.

#### `upstream-fixes`

(Originally included a fix for a real upstream typo — `Compiler.h` checked
the never-defined `__WASM__` instead of `__wasm__` — but once this branch
was rebased onto `llvm-project`'s current `main`, that cherry-pick came
back empty: the typo was already fixed independently upstream. Dropped
from this branch as redundant; not something to redo.)

- `llvm/include/llvm/ADT/bit.h`: recognize `__wasi__` as a platform with a
  usable `<endian.h>` (wasi-libc has one; it just wasn't in the OS list).
- `llvm/cmake/modules/HandleLLVMOptions.cmake`: treat the wasm32-wasi
  target as Unix-like (`LLVM_ON_UNIX=1`) so LLVMSupport's `Unix/*.inc`
  platform implementations get compiled at all, instead of neither the
  Unix nor the Windows ones. Mirrors the existing precedent for Emscripten
  (POSIX-ish libc, not a real Unix kernel), which already gets
  `LLVM_ON_UNIX=1` via CMake's own `UNIX` variable; WASI just doesn't trip
  that variable the way Emscripten's toolchain does.
- `llvm/lib/Support/Unix/Unix.h`: guard the `<sys/wait.h>` include, which
  doesn't exist on WASI.
- `llvm/lib/Support/ProgramStack.cpp`: no `RLIMIT_STACK`; falls back to
  the same fixed 8MiB default already used on non-Unix platforms.
- `clang/tools/driver/cc1_main.cpp`: same `RLIMIT_STACK` gap as
  `ProgramStack.cpp` above, reached via `CLANG_HAVE_RLIMITS` (a
  `check_include_file(sys/resource.h)` check that only confirms the
  header exists, not that its rlimit content is usable on WASI). The file
  already had an empty-stub fallback for platforms without rlimits; WASI
  now takes that path too.
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
  lock's owning process is still alive, and no real multi-process
  contention to detect in the first place on this target (each build runs
  in its own isolated module instance). Conservatively assume the lock is
  held. Reclassified here from an earlier pass that put it on `wasm-wasi`
  as a "policy choice" — [#92677](https://github.com/llvm/llvm-project/pull/92677)
  reaches the identical fix via the identical reasoning, which is real
  external validation this is a mechanical fallback like the rest of this
  list, not a project-specific stance.
- `llvm/lib/Support/Unix/Program.inc`: real subprocess spawning
  (`Execute`/`Wait`, i.e. `posix_spawn`) doesn't exist on WASI.
  `Execute()` now calls through `CurrentSpawnHook`, a plain C function
  pointer — on wasm32 that's just an index into the module's own
  indirect-call table, so this needs **no wasm import and no host
  cooperation** just to link or instantiate the module; it defaults to a
  stub that fails loudly (`report_fatal_error`). This is genuinely
  self-contained, not a project-specific policy call: a host that wants
  real subprocess support can, *after* instantiation, grow the module's
  exported indirect-call table (module must be linked with
  `--export-table`/`--growable-table`; see `documents/notes.md`), write
  its own function into the new slot, and call the exported
  `__wasi_shim_set_spawn_hook()` to install it — entirely optional,
  entirely post-instantiation. See `ai-notes/wasi_spawn_shim.mjs` for a
  reference host doing exactly this, and `documents/js-host-contract.md`
  for what a real host provides.

#### `wasm-wasi` (additionally)

- `llvm/lib/Support/CrashRecoveryContext.cpp`: WASI has no signal delivery
  and no working `setjmp`/`longjmp`, so real crash recovery is impossible
  in a single module instance; `Enable()` now fails loudly instead of
  silently pretending to work. The build relies on `-DCLANG_SPAWN_CC1=ON`
  (see `build.bat`) so `Enable()` is never actually called by the driver.
- `llvm/lib/Support/Unix/Signals.inc`: WASI can't install real signal
  handlers, so handler registration (crash backtraces, Ctrl-C,
  cleanup-on-signal) becomes a silent no-op — nothing depends on it
  succeeding. The underlying cleanup machinery (`RemoveFileOnSignal`,
  `RunInterruptHandlers`, `CleanupOnSignal`) stays fully functional and
  exported, for a JS host to call directly instead of relying on a signal
  to trigger it. **Deliberately different from
  [#92677](https://github.com/llvm/llvm-project/pull/92677)'s approach**:
  that PR intercepts one layer up, in `Signals.cpp` itself (bypassing
  `Unix/Signals.inc` for WASI entirely), and stubs
  `RunInterruptHandlers`/`RemoveFileOnSignal`/`CleanupOnSignal` to silent
  no-ops along with everything else. That would make our own JS-host
  cleanup contract (see `documents/js-host-contract.md`) impossible to
  implement — those three functions have to stay real for a host to call
  them. Not a style choice; do not "simplify" this to match #92677 later.
- `llvm/lib/Support/Unix/Watchdog.inc`: no `alarm()`/signals, so the
  watchdog timer is a no-op; real timeout enforcement is expected to
  happen by the JS host terminating the Worker (see
  `documents/js-host-contract.md`).
- `llvm/lib/Support/raw_socket_stream.cpp`: no BSD sockets API on WASI;
  socket operations fail loudly rather than silently.

## Key design decisions

### Spawning subprocesses: an optional table-hook, not a required import

`clang`'s driver expects to spawn real subprocesses (`cc1` for compilation,
`wasm-ld` for linking) via `Unix/Program.inc`. Rather than adding a
required wasm import (which would mean the module *cannot instantiate at
all* without a JS host providing it), the design serializes argv/env into
linear memory and calls through an indirect-call table slot
(`env.__wasi_shim_spawn_sync`-shaped) that a host installs *after*
instantiation by growing the exported table and writing a
`WebAssembly.Function`-wrapped callback into the new slot. This means
`clang.wasm` instantiates with zero custom imports on its own — genuinely
self-contained — and a JS host opts in to subprocess support rather than
being required to provide it just to load the module. This is why the
mechanism lives on `upstream-fixes`: it needs no host cooperation to exist,
only to be useful.

The reference host implementation (`ai-notes/wasi_spawn_shim.mjs` +
`wasi_spawn_worker.mjs`) spawns each child as a Node `worker_threads`
Worker, blocking the caller synchronously via `Atomics.wait` (mirroring
real fork/exec-and-wait semantics) until the child's exit code is
available.

### Real multithreading: `wasm32-wasip1-threads`, not a hack

Real pthreads are enabled as the actual primary build configuration
(`build.bat` targets `wasm32-unknown-wasip1-threads`,
`-DLLVM_ENABLE_THREADS=ON`, `-pthread`), not merely prototyped. This uses
the standard `wasi-threads` proposal ABI: a required `wasi.thread-spawn`
import (host spawns a Worker sharing the same `WebAssembly.Memory`) and a
required shared `env.memory` import — genuinely required, unlike the
optional spawn hook above, since shared-memory threading is a wasm/host
contract wasi-libc itself defines, not something this project designed.
Mutex/condvar/join synchronization needs *no* additional host JS at all
once the memory is shared — it's wasm's own `memory.atomic.wait32`/
`notify32` instructions, handled entirely by the engine.

This is viable specifically because VS Code for Web's actual deployment
target (`vscode.dev`) is already cross-origin isolated
(`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy:
require-corp`), which is the prerequisite for `SharedArrayBuffer`/shared
`WebAssembly.Memory` to exist in a browser at all. See
`documents/vscode-wasi-host.md` for the confirmed `wasm-wasi-core` API
surface this depends on.

### Two kinds of parallelism, solved differently

- **Multi-file parallelism** (compiling several independent source files
  concurrently — the common case for a real project): needs *no* wasm-side
  changes at all. Each top-level `clang.wasm` driver instance is already
  fully isolated (fresh linear memory) the moment it's instantiated, so
  running N independent Workers, each doing its own instantiate +
  install-spawn-hook + `wasi.start()`, gives real concurrent compilation
  for free. Implemented in `ai-notes/wasi_driver_worker.mjs`; measured
  genuinely sub-linear scaling (not just "not slower").
- **In-module threading** (`LLVM_ENABLE_THREADS=ON` — parallelizing work
  *within* a single compile/link, e.g. LLD's parallel section writing, or
  a future ThinLTO backend): needed the real pthreads support described
  above. Confirmed low-impact for small/typical workloads (no
  `thread-spawn` observed firing during a trivial one-file compile-and-
  link — `ThreadPoolStrategy`'s heuristics decide it's not worth it below
  some size threshold) but real and increasingly relevant as project size
  grows.

### Threading in *output* programs is independent, and already worked

A user's own `-pthread`-targeted program, compiled by our `clang.wasm`, is
governed entirely by mainline, unmodified upstream Clang/WASM support — it
doesn't depend on anything this project changed, and was verified
separately from clang.wasm's own internal threading (see
`ai-notes/run_clang_threaded_output_smoketest.mjs`). Don't conflate "does
clang.wasm run threaded" with "do programs clang.wasm compiles support
threading" — they're independent questions, both now answered yes.

### Reference JS host is Node, not the real target

Everything under `ai-notes/*.mjs` is a Node-based reference implementation
proving the *contract* works end-to-end (real compile, real link, real
run, real multithreading) — it is explicitly not the real browser host. A
real implementation needs, at minimum: a real browser `Worker` instead of
Node's `worker_threads`; handling a `Worker` that gets forcibly
*terminated* (no in-wasm backtrace is possible on termination — the
hosting JS has to reconstruct/report failure itself); and the hosting JS
(not the terminated Worker) being responsible for invoking cleanup
(`RunInterruptHandlers()`/`CleanupOnSignal()`) since the wasm instance
itself can't run any code once terminated.

## Known limitations

- **File I/O across threads: fixed, linked in automatically.** Each
  spawned wasi-thread gets its own independent host WASI instance with
  its own private fd table, so a real pthread program's normal pattern —
  main thread opens one fd, shares the plain `int` with worker threads,
  each thread operates on that same fd number — used to fail with
  `EBADF`. Fixed by `compiler-rt/lib/wasi_threaded_io`: a dedicated
  I/O-owning thread holds the real fd table, and every other thread
  (including main) RPCs to it over a single-slot shared-memory mailbox by
  intercepting the raw WASI Preview1 import layer. Built as a normal
  compiler-rt component and linked automatically into every `-pthread`
  WASI-threads output binary by the driver (opt out with
  `-mno-wasi-threaded-io`); verified against a real rebuild of
  clang.wasm/lld.wasm. See `documents/threaded-file-io-rpc-plan.md` for
  the full design and verification detail. The single-threaded build
  (`build-single-threaded.bat`) has since been confirmed unaffected for
  ordinary compiles; explicit `-mwasi-threaded-io` there now produces a
  clear driver error (instead of the link failure it used to) explaining
  that this clang's own compiler-rt lacks atomics support — see
  `documents/remaining_work.md`. Still open: whether/how to link the
  shim into clang.wasm itself.
- **No subprocess I/O redirection, timeouts, polling, or detached
  processes.** `Unix/Program.inc`'s `Execute()`/`Wait()` fail loudly
  (`report_fatal_error`) rather than silently no-op'ing for these. Nothing
  in a normal `-c`/`-o` compile-and-link needs them; would need wire-format
  and shim extension if something does.
- **`CrashRecoveryContext::Enable()` and socket operations
  (`ListeningSocket`/`raw_socket_stream`) are hard stubs.** Deliberate: the
  driver's `CLANG_SPAWN_CC1=ON` setting means `CrashRecoveryContext::Enable()`
  is never actually called in practice, so this is dead code, not a real
  gap. Sockets were never expected to work in a browser-hosted compiler.
- **`clangd` is untouched and expected to be harder.** Persistent
  background indexing threads are a different shape of problem than a
  one-shot spawn-and-wait like `cc1`; `clang-tools-extra` isn't even
  enabled in the build yet. Not attempted.
- **`build.bat`'s compiler-rt resource-dir path hardcodes the LLVM major
  version** (`lib/clang/24/...`). Will silently need updating on the next
  rebase past a version bump; not yet made version-agnostic the way the
  JS smoke tests' `findResourceDir()` already is.
- **`--stack-first`'s stack-overflow protection only covers the main
  thread.** Spawned pthread stacks come from wasi-libc's own runtime
  allocation, not the linker-placed main-thread stack region — a deep call
  chain on a spawned thread can still silently corrupt memory on overflow,
  the way the original (pre-fix) compiler crash did before it was
  root-caused. See `documents/threaded-file-io-rpc-plan.md`'s constraint
  #3 for detail — relevant once a dedicated I/O-server thread starts
  running real request-dispatch work.
- **Real per-source-line debugging is unexplored.** `documents/
  vscode-wasi-host.md` was written specifically to capture the
  `wasm-wasi-core` API surface relevant to this, but no actual debugger
  implementation work has started.

## Where things stand (as of this writing)

`build.bat` builds a working, real-threading-enabled `clang.wasm`/
`lld.wasm` against `wasm32-unknown-wasip1-threads`. All smoke tests pass:
`--version`, single-file compile, compile+link+run, 4-file parallel
compile, threaded-output-program compile+link+run. The
shared-fd-across-threads gap is fixed and wired into the driver, linked
automatically into every `-pthread` WASI-threads output binary (see
`documents/remaining_work.md` and `documents/threaded-file-io-rpc-plan.md`
for detail and the still-open follow-ups). No PR has been opened upstream
from `upstream-fixes` yet.
