# WIP: getting `clang` (the driver) to build for wasm32-wasip1

**STATUS as of 2026-09-03: `clang.wasm` builds, links, runs, AND compiles
real C source through a real spawned `cc1` subprocess.**
`ai-notes/run_clang_compile_smoketest.mjs` compiles a `#include <stdio.h>`
"Hello, world!" translation unit to a real 675-byte `.o` file, exercising
the actual driver → spawn-cc1 → parse/codegen → object-file-write path end
to end. This was the milestone this file was tracking — read on for how it
was reached, then see "Next milestone" for what's left (linking).

Read `AGENTS.md` first for the general approach.

## Current state

Git history is split into two branches (see `git log --oneline --graph
upstream-fixes wasm-wasi`), both rebuilt with `Assisted-by:` trailers per
llvm-project's AI-contribution policy (not `Co-Authored-By:` — that's a
deliberate exception to this session's usual default, specific to this
repo):
- `upstream-fixes`: small, defensible platform-support fallbacks, clean
  enough to plausibly PR upstream on their own.
- `wasm-wasi` (based on `upstream-fixes`): the opinionated "fail loudly on
  gaps we can't fill" commit, the README/ai-notes documentation commit, and
  now the spawn-shim work below.
Nothing has been pushed to the `fork` remote (`github.com/Ambeco/llvm-project`)
or opened as a PR yet — hold off until asked.

To reproduce or extend the build, just run `build.bat` from the repo root —
it's fully in sync with the working configuration. It's an incremental
build; don't `rm -rf build` unless a `CMakeCache.txt` entry looks stale (see
"stale cache gotcha" below).

**Verified working:**
- `build/bin/clang --version` under `node:wasi`
  (`ai-notes/run_clang_smoketest.mjs`) — driver logic runs end-to-end,
  correct output. Doesn't invoke `cc1`.
- `node --experimental-wasi-unstable-preview1
  ai-notes/run_clang_compile_smoketest.mjs` — real `-c hello.c -o hello.o`
  compile, spawning a real `cc1` child via the new
  `env.__wasi_shim_spawn_sync` import (`ai-notes/wasi_spawn_shim.mjs` +
  `ai-notes/wasi_spawn_worker.mjs`, Node `worker_threads` + `Atomics.wait`).
  **PASSED.**

**Still missing: linking.** `LLVM_ENABLE_PROJECTS` is `clang;compiler-rt`
only — no `lld` in this build, so there's no linker for `clang.wasm` to
invoke yet. See "Next milestone".

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

## Next milestone: linking

`clang.wasm` can compile a `.c` file to a real `.o` file (see STATUS at
top), but `LLVM_ENABLE_PROJECTS` doesn't include `lld`, so there's no
linker binary for it to invoke — `clang -o hello hello.c` (full compile+
link) would fail looking for `wasm-ld`/`ld.lld` on `PATH`. This was
discovered, not yet fixed. To actually produce a linked, runnable wasm
binary:
1. Add `lld` to `LLVM_ENABLE_PROJECTS` in `build.bat` and rebuild (another
   full native+wasm CMake pass — budget disk/time for it; unclear yet
   whether lld needs any of its own wasi-specific patches, same
   investigate-before-assuming approach as everything above).
2. The same `env.__wasi_shim_spawn_sync` plumbing built for `cc1` should, in
   principle, already cover invoking `ld.lld` too (it's just another
   argv/env spawn) — but this is untested and worth verifying explicitly
   once lld exists, rather than assuming it "just works."
3. Extend `ai-notes/run_clang_compile_smoketest.mjs` (or add a sibling
   script) to drop `-c` and actually produce + run a linked `hello.wasm`,
   the true "compile and link Hello World" proof.

## Further out: the real JS-side executor / VS Code for Web extension

The Node scripts in `ai-notes/` are a reference implementation proving the
*contract* works, not the real thing — see README's "JS Framework" section
for what a real browser-based host needs to do differently (Worker instead
of `worker_threads`, catching a *terminated* Worker and rendering its own
call stack, hosting-JS-responsible-for-cleanup-on-terminate). That's a
separate, substantial piece of work, likely in its own repo, not attempted
here yet.
