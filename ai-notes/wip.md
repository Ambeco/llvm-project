# WIP: getting `clang` (the driver) to build for wasm32-wasip1

**STATUS as of 2026-09-03: full compile-and-link "Hello World" works
end to end.** `ai-notes/run_clang_link_smoketest.mjs` compiles a
`#include <stdio.h>` "Hello, world!" translation unit, links it with a
real spawned `wasm-ld` into a genuine `hello.wasm`, then actually *runs*
that binary and gets the correct output. This was the milestone this file
was tracking — read on for how it was reached, then see "Next milestone"
for what's actually left (a real browser-based JS host, not this Node
reference implementation).

Read `AGENTS.md` first for the general approach.

## Current state

Git history is split into two branches (see `git log --oneline --graph
upstream-fixes wasm-wasi`), both rebuilt with `Assisted-by:` trailers per
llvm-project's AI-contribution policy (not `Co-Authored-By:` — that's a
deliberate exception to this session's usual default, specific to this
repo). **Be conservative about what actually gets proposed upstream** —
`upstream-fixes` is scoped to changes defensible on their own terms (an
outright bug, or a mechanical extension of a pattern the codebase already
uses for a comparable degraded platform); everything that asserts a
project-specific policy (loud-failure-on-missing-functionality, and now
also `LockFileManager`'s conservative fallback, moved there on reflection)
lives on `wasm-wasi` instead. See README.md's "Changes" section, which
explains this split in more detail and lists every commit in each bucket.
Re-litigate the placement of any individual commit if it looks wrong on a
fresh read — the split was reconsidered and rebuilt once already this
session after a first pass put a policy-choice commit in the wrong branch.

Nothing has been pushed to the `fork` remote (`github.com/Ambeco/llvm-project`)
since the last rewrite, or opened as a PR — hold off until asked. (An
earlier version of these two branches *was* pushed to `fork`; since then
the history was rewritten — `LockFileManager` moved branches, and the
`--wasm` build fixes / lld-linking commits were added — so a plain
`git push` will be rejected as non-fast-forward. A force-push to `fork`
is expected and fine; just don't force-push anything that could touch
`origin` (`llvm/llvm-project`), which nothing here does.)

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

- **Two upstream projects to actually read before building more here** —
  the user found these mid-session and hasn't finished reviewing them yet;
  they may already have solved some or all of what's below. Check for
  updates/pasted notes before assuming any of this needs building from
  scratch:
  - <https://discourse.llvm.org/t/rfc-building-llvm-for-webassembly/79073>
  - <https://yowasp.org/>
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
