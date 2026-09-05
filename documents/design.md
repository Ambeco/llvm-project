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
  the full design and verification detail. Still open: whether/how to
  link the same shim into clang.wasm itself, and confirming the
  single-threaded build (`build-single-threaded.bat`) is unaffected — see
  `documents/remaining_work.md`.
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
