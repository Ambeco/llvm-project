# WIP: getting `clang` (the driver) to build for wasm32-wasip1

**STATUS as of 2026-09-04: `Unix/Program.inc`'s spawn mechanism is now a
table-indirect function pointer, not a required wasm import -- and moved
to `upstream-fixes` as a result.** `clang.wasm` instantiates with *zero*
custom imports (just the standard WASI ones); a JS host that wants real
subprocess support installs it *after* instantiation by growing the
module's exported indirect-call table, writing a
`WebAssembly.Function`-wrapped callback into the new slot, and calling the
exported `__wasi_shim_set_spawn_hook()`. This is genuinely self-contained
(no host cooperation needed to link or run the module at all), so the
whole mechanism moved from `wasm-wasi` to `upstream-fixes` -- see "Current
state" below. All three smoke tests re-verified passing against this
design (now needs Node's `--experimental-wasm-type-reflection` flag
alongside the existing `--experimental-wasi-unstable-preview1`).

Previous milestone (2026-09-03, still true): full compile-and-link "Hello
World" works end to end, and everything is rebased onto llvm-project's
real, current `main` (LLVM 24.0.0git) instead of the stale `release/23.x`
snapshot this whole effort started from. `ai-notes/run_clang_link_smoketest.mjs`
compiles a `#include <stdio.h>` "Hello, world!" translation unit, links it
with a real spawned `wasm-ld` into a genuine `hello.wasm`, then actually
*runs* that binary and gets the correct output. See "Next milestone" for
what's actually left (a real browser-based JS host, not this Node
reference implementation).

**The `main` rebase went essentially perfectly**: all 18 non-typo commits
across `upstream-fixes`/`wasm-wasi` cherry-picked cleanly (a few
auto-merges, zero manual conflict resolution needed) onto a shallow fetch
of `main` (`git fetch --depth=1 origin main` -- keeps disk usage down,
no need for full history). The only real breakage was self-inflicted: two
smoke test scripts hardcoded `build/lib/clang/23` (the resource dir is
named after `LLVM_VERSION_MAJOR`, which is now 24) -- fixed by picking the
highest-numbered directory instead of hardcoding one, so this doesn't
break again on the *next* rebase either.

Read `AGENTS.md` first for the general approach.

## Current state

Git history is split into **two** branches (there was briefly a third,
`fix-webasm`, created specifically to test a `main`-based rebase before
committing to it everywhere -- once that rebase proved clean, it was
folded back into `upstream-fixes` and deleted; don't go looking for it),
both now based on a shallow fetch of `llvm-project`'s real, current `main`
(`git fetch --depth=1 origin main` -- keeps disk usage down, no full
history needed), both rebuilt with `Assisted-by:` trailers per
llvm-project's AI-contribution policy (not `Co-Authored-By:` — a
deliberate exception to this session's usual default, specific to this
repo):

- **`upstream-fixes`** — 8 commits: `bit.h`, `HandleLLVMOptions.cmake`,
  `Unix.h`, `ProgramStack.cpp`+`cc1_main.cpp`, `Process.inc`, `Path.inc`,
  `LockFileManager.cpp`, `Unix/Program.inc`'s spawn hook. (Was 6 after the
  `main` rebase dropped the `__WASM__`-typo fix entirely -- `main` already
  has the correct `__wasm__` spelling, independently fixed upstream after
  our original `release/23.x` base was cut. Then `LockFileManager.cpp`
  moved in from `wasm-wasi`, then `Program.inc` moved in too once its
  design changed from a required import to an optional table hook -- see
  "Current state" and the STATUS note above.) Scoped to changes defensible
  on their own terms (an outright bug, a mechanical extension of a
  platform-support pattern the codebase already uses elsewhere, or -- for
  `Program.inc` -- a mechanism that's genuinely self-contained and requires
  no host cooperation) -- the actual PR-ready candidate. **Check whether
  any of these commits get superseded the same way on your *next* rebase**
  -- don't assume this list is permanently final; `main` moves fast.
- **`wasm-wasi`** (based on `upstream-fixes`) — everything that actually
  *requires* a JS host to do anything useful: the opinionated policy
  commits (loud-failure-on-missing-functionality for
  `CrashRecoveryContext`/`Signals.inc`/`Watchdog.inc`/`raw_socket_stream.cpp`),
  all README/ai-notes documentation, and the spawn-hook JS reference host
  (`ai-notes/wasi_spawn_shim.mjs` + `wasi_spawn_worker.mjs`) that actually
  installs a real implementation into `upstream-fixes`'s extension point.
  This is what `build.bat` and the smoke tests actually run
  against.

**Be conservative about what actually gets proposed upstream** — see
README.md's "Changes" section for the detailed criterion (mechanical
platform-support extension vs. project-specific policy choice) and the
per-commit bucketing. Re-litigate the placement of any individual commit
if it looks wrong on a fresh read — the split has been reconsidered and
rebuilt twice already this session:
1. A first pass put `LockFileManager` on `wasm-wasi` as a "policy choice."
2. After reading #92677's actual diff (see "Prior art" below) and finding
   it reaches the *identical* fix via the *identical* reasoning, moved
   `LockFileManager` back to `upstream-fixes` -- external validation from
   a real upstream reviewer thread that this is a mechanical fallback, not
   a project-specific stance. **This second move is the current state.**

**One thing checked and deliberately *not* adopted from #92677**: their
`Signals.cpp`-level interception (stubbing `RunInterruptHandlers`/
`RemoveFileOnSignal`/`CleanupOnSignal` to silent no-ops for WASI, bypassing
`Unix/Signals.inc` entirely -- confirmed from the actual diff hunk, not
just the PR's own description). That would make this project's JS-host
cleanup contract (see README's "JS Framework") impossible to implement --
those three functions have to stay real and callable. Don't "simplify" our
`Signals.inc` patch toward their approach later without re-reading this;
it's load-bearing, not a style difference. See README.md's `Signals.inc`
bullet for the same note in context.

**Before opening any actual PR from `upstream-fixes`**, diff/compare
against [llvm/llvm-project#92677](https://github.com/llvm/llvm-project/pull/92677)
(open, unmerged, doing very similar work across almost the same files) —
see "Prior art" below for why it stalled and why our narrower scope
(no threading/`std::mutex` changes at all) sidesteps its actual blocker.

Both branches have been pushed to the `fork` remote
(`github.com/Ambeco/llvm-project`) as of the last update to this file --
force-pushed, since this was a full rebase onto a different base commit
entirely (expect to need `--force` again on any future rebase; fine for
`fork`, never touch `origin`/`llvm/llvm-project` with anything but a
normal PR branch push). No PR has been opened anywhere yet — hold off
until asked.

**Reproducing this rebase, if it needs doing again**: shallow-fetch
`main`, retarget the branch, cherry-pick each `upstream-fixes` commit in
order (skip any that come back empty -- already fixed upstream), then
cherry-pick each `wasm-wasi`-only commit on top in order. All 18 commits
applied cleanly last time with zero manual conflict resolution -- if that
changes, investigate the specific conflicting file the normal way (check
what changed on `main` since our patch was written) rather than assuming
the patch is still correct as-is.

To reproduce or extend the build, just run `build.bat` from the repo root —
it's fully in sync with the working configuration. It's an incremental
build; don't `rm -rf build` unless a `CMakeCache.txt` entry looks stale (see
"stale cache gotcha" below).

**Verified working:**
- `build/bin/clang.wasm --version` under `node:wasi`
  (`ai-notes/run_clang_smoketest.mjs`) — driver logic runs end-to-end,
  correct output. Doesn't invoke `cc1`.
- `ai-notes/run_clang_compile_smoketest.mjs` — real `-c hello.c -o hello.o`
  compile, spawning a real `cc1` child via the
  `env.__wasi_shim_spawn_sync` import (`ai-notes/wasi_spawn_shim.mjs` +
  `ai-notes/wasi_spawn_worker.mjs`, Node `worker_threads` + `Atomics.wait`).
  **PASSED.**
- `ai-notes/run_clang_link_smoketest.mjs` — the same, minus `-c`: compiles,
  spawns a genuinely different wasm binary (`wasm-ld`, not `clang.wasm`)
  for the link step, produces a real linked `hello.wasm`, then runs it and
  checks the output. **PASSED.**

(All three: `node --experimental-wasi-unstable-preview1
ai-notes/<script>.mjs`.)

### Getting lld/linking working (three build.bat additions, in order hit)

1. `LLVM_ENABLE_PROJECTS="clang;compiler-rt;lld"` and build target `lld` —
   built clean, **zero WASI-specific patches needed**. `bin/lld.wasm` (well,
   the multi-personality copies `ld.lld`/`wasm-ld`/etc. — see the `.wasm`
   suffix note below) just worked.
2. `wasm-ld` needs `libclang_rt.builtins.a` for the target, which wasn't
   being built at all (`Builtin supported architectures:` came back empty
   in the cmake configure log). Root cause:
   `COMPILER_RT_DEFAULT_TARGET_ONLY` was `OFF`, so compiler-rt ran its
   generic multi-arch detection, which force-overrides the test-compile
   target to `wasm32-unknown-unknown` (ignoring our actual sysroot/target) —
   that test-compile silently fails, leaving the arch list empty. Fixed by
   setting `COMPILER_RT_DEFAULT_TARGET_ONLY=ON`, which also requires
   `CMAKE_C_COMPILER_TARGET`/`CMAKE_CXX_COMPILER_TARGET` to be set
   explicitly (harmless — matches what wasi-sdk's `clang.cfg` already
   defaults to). Needed an explicit build of the `clang_rt.builtins-wasm32`
   target too — it's not part of the default `clang`/`lld` targets.
3. Even once built, the builtins archive landed at
   `lib/clang/23/lib/generic/libclang_rt.builtins-wasm32.a` — the *old*
   flat/arch-suffixed layout. Clang's driver (for this target) looks for
   the newer per-target-triple layout instead
   (`lib/clang/23/lib/wasm32-unknown-wasip1/libclang_rt.builtins.a`). Fixed
   with `LLVM_ENABLE_PER_TARGET_RUNTIME_DIR=ON`.

### `.wasm` extension note

`CMAKE_EXECUTABLE_SUFFIX=.wasm` alone doesn't stick — LLVM's CMake resets
it per-language from `CMAKE_EXECUTABLE_SUFFIX_C`/`_CXX` (populated by
compiler-ABI detection) after cache load. Set
`CMAKE_EXECUTABLE_SUFFIX_CXX=.wasm` (all our targets are C++) instead.
Multi-personality tool copies (`clang++`/`clang-cl`/`clang-cpp` alongside
`clang.wasm`; `ld.lld`/`wasm-ld`/`lld-link`/`ld64.lld` alongside `lld.wasm`)
are generated via a raw filename string in each project's own CMake code,
not through this suffix machinery, so they come out *without* the
`.wasm` suffix — harmless, just don't be surprised by it.

### Guest-path resolution in the spawn shim (needed for a *different* spawned binary)

The Node reference host (`ai-notes/wasi_spawn_shim.mjs`) originally always
re-instantiated the *parent's own* wasm module for every spawn request.
That happened to be correct for `cc1` (it lives inside `clang.wasm` itself;
`argv[0]` comes through as `""`, since `getMainExecutable()` returns `""`
on WASI), but wrong for `wasm-ld`, a genuinely separate binary. Fixed via
`resolveGuestPath()`: resolve `argv[0]` against the same preopen map the
calling instance uses (longest-prefix match), and load *that* file for the
child if it resolves, falling back to the parent's own module otherwise.
Also needed two new preopens in the link smoke test: `/bin` (so
`Driver::GetProgramPath()`'s `PATH` search can actually find `wasm-ld` —
see `Path.inc`, `getMainExecutable()` can't help here) and `/tmp` +
`TMPDIR` (the driver writes the intermediate `.o` to a temp file before
invoking the linker on it).

## The path here (don't redo this investigation)

In order, the real problems solved (see `README.md`'s "Changes" section for
the source-level detail on each):
1. `CMAKE_TARGET_TRIPLE` in the original `build.bat` was a fake variable
   that did nothing — the BLAKE3 x86-SIMD-detection issue from the previous
   session was a symptom of never actually cross-compiling at all.
2. Switched to wasi-sdk as the cross-compiler (the VS-bundled clang has no
   WebAssembly backend registered at all — checked via `--print-targets`).
3. `CMAKE_C_COMPILER_TARGET` does *not* auto-inject `--target=` into
   compiles (only used for the compiler-ID probe) — irrelevant once we
   switched to wasi-sdk clang, which defaults to `wasm32-unknown-wasip1`
   via its own `clang.cfg`, no `--target` flag needed at all.
4. `LLVM_HOST_TRIPLE` must be set explicitly (`GetHostTriple.cmake` can't
   detect a plain non-MSVC-ABI clang.exe on native Windows).
5. Needed `CROSS_TOOLCHAIN_FLAGS_NATIVE` (compiler + `llvm-rc.exe`) — the
   NATIVE sub-build otherwise gets zero compiler flags when truly
   cross-compiling (`CrossCompile.cmake` only forwards the host compiler
   when `NOT CMAKE_CROSSCOMPILING`).
6. `HandleLLVMOptions.cmake` treats `CMAKE_SYSTEM_NAME=Generic` as neither
   Unix nor Windows (`LLVM_ON_UNIX=0`) unless `LLVM_HOST_TRIPLE` matches
   `-wasi` — patched to special-case that, since wasi-libc is POSIX-ish
   enough that the `Unix/*.inc` files are the right implementation to use.
7. A long tail of individual `Unix/*.inc` gaps (see README) — signals,
   process spawning, user database, rlimits, etc.
8. `CLANG_SPAWN_CC1=ON` — real CMake option. Counterintuitively, this is
   what makes `CrashRecoveryContext::Enable()` **not** get called (it's
   gated on `!CLANG_SPAWN_CC1` in `driver.cpp`) — so the "WASM can't do
   signal-based crash recovery" problem is dead code in practice. The
   tradeoff: it forces every `cc1` invocation through a real spawned
   subprocess (`Unix/Program.inc`) instead of in-process, which is why the
   spawn shim below was needed to actually compile anything.
9. `-D_GNU_SOURCE` — wasi-libc's `features.h` auto-enables POSIX-visibility
   defines *unless* `__STRICT_ANSI__` is set, which `-std=c++17` (not
   `-std=gnu++17`) does. Fixed a big batch of "undeclared identifier" errors
   in one shot (`sigfillset`, `siginfo_t`, `SA_NODEFER`, etc.) that looked
   individually like missing-symbol bugs but were actually all this one
   thing.
10. `-D_WASI_EMULATED_SIGNAL/-GETPID/-MMAN/-PROCESS_CLOCKS` +
    corresponding `-lwasi-emulated-*` link libs — real, first-party
    wasi-libc emulation libraries, found by reading the `#error` text in the
    relevant sysroot headers. Always check for one of these before
    hand-patching.
11. Two upstream typo bugs, unrelated to WASI specifically: `Compiler.h` in
    both `llvm/include` and `clang/include` checked `__WASM__` (never
    defined by any real compiler) instead of `__wasm__` — this silently
    left `LLVM_TEMPLATE_ABI`/`CLANG_TEMPLATE_ABI` completely undefined for
    any wasm target, causing bizarre "explicit instantiation ... does not
    refer to a template" errors in `clang/lib/Basic/Attributes.cpp`.
12. `clang/tools/driver/cc1_main.cpp`'s `ensureSufficientStack()` had the
    exact same `RLIMIT_STACK`/`rlim_t`/`RLIM_INFINITY` gap as
    `ProgramStack.cpp`, gated by `CLANG_HAVE_RLIMITS` -- which is set by
    `check_include_file(sys/resource.h ...)`, a check that only confirms the
    header exists, not that its rlimit content is actually usable for wasi
    (same root cause as the earlier `HAVE_SYS_MMAN_H`-style gaps). Fixed by
    also excluding `__wasi__`; the file already had a ready-made empty-stub
    `#else` branch for platforms without rlimits, so no new stub needed.
13. `-ldl` -- `DynamicLibrary.cpp`'s `dlopen`/`dlclose`/`dlerror`/`dlsym`
    calls linked clean once this was added; wasi-libc ships a real
    `libdl.a` for these, found the same way as the `-lwasi-emulated-*` libs
    (checked the sysroot's `lib/wasm32-wasip1/` directly). This was the
    **last** error in the entire build -- fixing it produced a clean,
    complete `bin/clang`.
14. **Real subprocess spawning for `cc1`**: `Unix/Program.inc`'s wasi
    `Execute()` now serializes argv/env into wasm linear memory and calls
    the JS-provided `env.__wasi_shim_spawn_sync(ptr, len) -> i32` import
    (see `Unix/Program.inc` for the exact wire format); `Wait()` just
    returns what `Execute()` already computed, since the synchronous
    import call means there's no separate "spawned but not yet waited on"
    state. Verified via the Node reference host in `ai-notes/wasi_spawn_shim.mjs`
    + `ai-notes/wasi_spawn_worker.mjs` (`worker_threads` + `Atomics.wait` to
    block synchronously — a real extension does the same shape with a
    browser Worker). One bug caught and fixed along the way: `Wait()`
    initially treated a non-null `ProcStat` pointer as "stats were
    requested" and failed loudly; actually `Command::Execute` always passes
    that pointer as available storage, whether or not stats are wanted —
    fixed to only fail loudly on a genuine `SecondsToWait`/`Polling`
    request.

### Stale-cache gotcha

`HAVE_SYS_MMAN_H` (and possibly other `check_include_file`-style `HAVE_*`
cache entries) got stuck as "not found" from *before* the
`-D_WASI_EMULATED_MMAN` flag was added, and did NOT get re-checked on a
normal incremental `cmake .` reconfigure (they're `INTERNAL` cache entries,
not re-evaluated just because `CMAKE_C_FLAGS` changed). If a similarly
weird "undeclared identifier" error resurfaces for something that should
plainly be available, suspect this before re-investigating from scratch:
delete `build/CMakeCache.txt` + `build/CMakeFiles/` (not the whole `build/`
dir — that's needlessly slow) and do a full fresh `cmake` configure.

## Known, deliberately-deferred work (not bugs to "fix" here)

- `Unix/Program.inc`'s wasi `Execute()`/`Wait()` don't support I/O
  redirection, timeouts, polling, or detached processes — those fail
  loudly (`report_fatal_error`) rather than being silently ignored. Nothing
  in a normal `-c`/`-o` compile invocation needs them; extend the wire
  format + shim if/when something does.
- `CrashRecoveryContext::Enable()`, `ListeningSocket`/`raw_socket_stream`
  socket operations: still hard `report_fatal_error` stubs, same reasoning
  as before (see README) — `CLANG_SPAWN_CC1=ON` means `Enable()` is never
  actually called by the driver, so this is dead code in practice.

## Next milestone: a real browser-based JS host

Compile-and-link "Hello World" works end to end (see STATUS at top) —
linking turned out to need zero source patches, only three `build.bat`
additions (see "Getting lld/linking working" above). What's left is
entirely on the JS side, and moves outside this repo:

- **Prior art, read 2026-09-03** (the user found these; both fetched and
  reviewed this session):
  - <https://discourse.llvm.org/t/rfc-building-llvm-for-webassembly/79073> —
    an RFC from 2024-05-19 proposing the same overall goal (LLVM for
    WASI/WASIp1+p2, not Emscripten).
  - <https://yowasp.org/> — a project that's actually shipping this: builds
    of `clang`/`lld`/etc. to `wasm32-wasip1`, distributed as npm packages,
    with a real JS runtime (`@yowasp/runtime` /
    <https://codeberg.org/YoWASP/runtime-js>) driving them.
  - **Before opening any upstream PR, diff against
    [llvm/llvm-project#92677](https://github.com/llvm/llvm-project/pull/92677)**,
    "Conditionalize use of POSIX features missing on WASI/WebAssembly" —
    still open/unmerged as of this check, and it patches nearly the exact
    same file list `upstream-fixes` does: `CrashRecoveryContext.cpp`,
    `LockFileManager.cpp`, `Path.inc`, `Process.inc`, `Unix.h`,
    `Watchdog.inc`, `raw_socket_stream.cpp` (using `defined(__wasi__)`
    directly, same as us, after reviewers pushed back on a
    CMake-feature-detection-only approach). Opening a competing PR without
    checking this first would waste a maintainer's time. Its sibling
    attempt, [#91051](https://github.com/llvm/llvm-project/pull/91051), was
    closed by its own author in favor of #92677 — worth knowing the RFC
    thread's history so we don't repeat an already-abandoned approach.
    **Why it actually stalled** (read 2026-09-03, useful context for
    `fix-webasm`): not a rejection -- two real blockers. (1) `std::mutex`
    wasn't available at all on the single-threaded `wasm32-wasip1` target
    until `wasi-sdk` added it in ~July 2025; the PR tried to conditionalize
    every use, which the author called infeasible. (2) Reviewer `jyknight`
    wanted a dedicated `lib/Support/WASI/*.inc` directory instead of inline
    `#if defined(__wasi__)` in the existing `Unix/*.inc` files (which is
    what we did, and where the PR ultimately landed anyway after debate)
    -- no consensus reached, plus low maintainer bandwidth to keep pushing
    it through. **This is exactly why `fix-webasm` should stay narrow**:
    we never touch threading/`std::mutex` at all (`LLVM_ENABLE_THREADS=OFF`
    sidesteps it entirely), so we don't hit #92677's actual blocker. Frame
    any PR from `fix-webasm` explicitly as smaller/narrower than #92677,
    link to it for context, and don't try to solve what stalled it.
  - **Real validation of our build.bat flags**: YoWASP's actual production
    `build.sh` (<https://codeberg.org/YoWASP/clang>, `develop` branch) uses
    `-DCOMPILER_RT_DEFAULT_TARGET_ONLY=ON` and
    `-DLLVM_ENABLE_PER_TARGET_RUNTIME_DIR=ON` -- the exact two flags we
    independently reverse-engineered to get `lld`/linking working (see
    "Getting lld/linking working" above) -- plus `-DLLVM_ENABLE_THREADS=OFF`
    and `-DLLVM_ENABLE_PIC=OFF`, matching ours. Good sign these are the
    real answers, not idiosyncratic hacks. They pin `wasi-sdk` 32 (we're on
    34) and pass an unusual `-mcpu=lime1` to their WASI_CFLAGS -- purpose
    unclear, not investigated, probably not relevant to us.
  - **Do NOT rely on `-fintegrated-lld`**: the RFC's step 4 proposes adding
    this driver flag to let clang invoke `cc1`/`lld` in-process instead of
    spawning -- checked, and it does **not exist** anywhere in our current
    tree (grepped `Options.td` and friends, zero hits). It's the RFC
    author's own proposed-but-unimplemented idea, not real upstream
    functionality as of this LLVM version. Our
    `env.__wasi_shim_spawn_sync`-based spawn shim is the working approach;
    don't design future work around `-fintegrated-lld` showing up.
  - **A possibly-simpler alternative architecture, not investigated
    further**: YoWASP's JS runtime API is one `runX(filesIn) -> filesOut`
    call per *tool* (so a separate call for `clang -c` and for `wasm-ld`,
    driven by the host), and the RFC links
    [D109977, "LLVM Driver Multicall tool"](https://reviews.llvm.org/D109977)
    -- suggesting YoWASP may sidestep the whole subprocess-spawn problem by
    having the *host* directly instantiate each tool (`cc1`, `wasm-ld`) as
    its own separate wasm module invocation via a multicall binary, rather
    than clang.wasm's driver spawning children internally the way our shim
    does. Couldn't confirm this from their docs alone (the actual spawn/
    threading logic lives in `runtime-js`'s `lib/` source, not fetched this
    session) -- worth a closer read later, but not urgent: our
    spawn-shim approach already works end-to-end (compile *and* link, see
    STATUS at top), so this would be a simplification, not a blocker.
- The Node scripts in `ai-notes/` are a reference implementation proving
  the *contract* works (see README's "JS Framework" section), not the real
  thing. A real browser-based host needs to do differently: a real Worker
  instead of `worker_threads`, catching a *terminated* Worker and
  rendering its own call stack (no in-wasm backtrace is possible — see
  README), and the hosting JS (not the Worker) being responsible for
  invoking cleanup (`RunInterruptHandlers()`/`CleanupOnSignal()`) when it
  terminates a Worker.
- Likely its own repo (the VS Code for Web extension), not a branch here —
  see the "yes please" branch-structure discussion this session for why
  this repo stays scoped to the toolchain patches.
- `clangd` was raised as a likely-harder future problem (persistent
  background indexing threads, not a one-shot spawn-and-wait like `cc1`) —
  not attempted, not even building yet (`clang-tools-extra` is disabled in
  `LLVM_ENABLE_PROJECTS`). Worth its own investigation pass later, not
  bolted onto this milestone.

The Node scripts in `ai-notes/` are a reference implementation proving the
*contract* works, not the real thing — see README's "JS Framework" section
for what a real browser-based host needs to do differently (Worker instead
of `worker_threads`, catching a *terminated* Worker and rendering its own
call stack, hosting-JS-responsible-for-cleanup-on-terminate). That's a
separate, substantial piece of work, likely in its own repo, not attempted
here yet.
