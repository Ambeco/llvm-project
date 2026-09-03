# WIP: getting `clang` (the driver) to build for wasm32-wasip1

**STATUS: `build.bat` succeeds end to end as of 2026-09-03.**
`build/bin/clang` is a real ~113MB WASM binary (starts with the `\0asm`
magic number) that links clean with zero errors. `clang++`/`clang-cl`/
`clang-cpp` are copies of the same binary, as usual. This was the milestone
this file was tracking — read on for how it was reached, then see the
"Next milestone" section at the bottom for what's actually left.

Read `AGENTS.md` first for the general approach.

## Current state

The build is done; nothing is running. To reproduce or extend it, just run
`build.bat` — it's fully in sync with the working configuration. If you've
pulled new upstream LLVM changes or need to iterate further, it's an
incremental build, so don't `rm -rf build` unless a `CMakeCache.txt` entry
looks stale (see "stale cache gotcha" below) or you're chasing a
compiler-flag change that needs a from-scratch feature-detection pass.

**Verified working**: ran `build/bin/clang --version` under Node's built-in
`node:wasi` (`node --experimental-wasi-unstable-preview1`, see
`ai-notes/run_clang_smoketest.mjs` -- copy it out of the scratchpad temp dir
if it's gone, it's tiny) and got the correct real output:
```
clang version 23.1.0 (...)
Target: wasm32-unknown-wasip1
Thread model: posix
```
This isn't just "the file is a well-formed wasm module" -- the driver's
actual C++ logic ran end-to-end and produced correct output. `--version`
doesn't invoke `cc1`, so this doesn't exercise the `ExecuteAndWait` stub.

**Important:** it still **cannot actually compile a C/C++ file yet** --
`llvm::sys::ExecuteAndWait`/`Wait` (the thing `cc1` invocation routes
through, since the build forces `-DCLANG_SPAWN_CC1=ON`) is a hard
`report_fatal_error` stub pending a JS-side Worker-based executor. Building,
linking, and running cleanly was the goal of *this* phase of work; "can it
compile `int main(){}`" is the next one, and needs the JS-side piece first.
Given `node:wasi` already worked for `--version`, a fast, no-JS-yet way to
probe further would be trying `clang -c foo.c -o foo.o` the same way and
seeing the exact `report_fatal_error` message/backtrace at the point it
gives up -- confirms the stub fires exactly where expected before any real
executor work begins.

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
2. `LLVM_HOST_TRIPLE` must be set explicitly (`GetHostTriple.cmake` can't
   detect a plain non-MSVC-ABI clang.exe on native Windows).
3. Needed `CROSS_TOOLCHAIN_FLAGS_NATIVE` (compiler + `llvm-rc.exe`) — the
   NATIVE sub-build otherwise gets zero compiler flags when truly
   cross-compiling (`CrossCompile.cmake` only forwards the host compiler
   when `NOT CMAKE_CROSSCOMPILING`).
4. `HandleLLVMOptions.cmake` treats `CMAKE_SYSTEM_NAME=Generic` as neither
   Unix nor Windows (`LLVM_ON_UNIX=0`) unless `LLVM_HOST_TRIPLE` matches
   `-wasi` — patched to special-case that, since wasi-libc is POSIX-ish
   enough that the `Unix/*.inc` files are the right implementation to use.
5. A long tail of individual `Unix/*.inc` gaps (see README) — signals,
   process spawning, user database, rlimits, etc.
6. `CLANG_SPAWN_CC1=ON` — real CMake option, makes the driver never call
   `CrashRecoveryContext::Enable()`, so the whole "WASM can't do signal-based
   crash recovery" problem is dead code in practice, not just patched away.
7. `-D_GNU_SOURCE` — wasi-libc's `features.h` auto-enables POSIX-visibility
   defines *unless* `__STRICT_ANSI__` is set, which `-std=c++17` (not
   `-std=gnu++17`) does. Fixed a big batch of "undeclared identifier" errors
   in one shot (`sigfillset`, `siginfo_t`, `SA_NODEFER`, etc.) that looked
   individually like missing-symbol bugs but were actually all this one
   thing.
8. `-D_WASI_EMULATED_SIGNAL/-GETPID/-MMAN/-PROCESS_CLOCKS` +
   corresponding `-lwasi-emulated-*` link libs — real, first-party wasi-libc
   emulation libraries, found by reading the `#error` text in the relevant
   sysroot headers. Always check for one of these before hand-patching.
9. Two upstream typo bugs, unrelated to WASI specifically: `Compiler.h` in
   both `llvm/include` and `clang/include` checked `__WASM__` (never
   defined by any real compiler) instead of `__wasm__` — this silently left
   `LLVM_TEMPLATE_ABI`/`CLANG_TEMPLATE_ABI` completely undefined for any
   wasm target, causing bizarre "explicit instantiation ... does not refer
   to a template" errors in `clang/lib/Basic/Attributes.cpp`.
10. `clang/tools/driver/cc1_main.cpp`'s `ensureSufficientStack()` had the
    exact same `RLIMIT_STACK`/`rlim_t`/`RLIM_INFINITY` gap as
    `ProgramStack.cpp`, gated by `CLANG_HAVE_RLIMITS` -- which is set by
    `check_include_file(sys/resource.h ...)`, a check that only confirms the
    header exists, not that its rlimit content is actually usable for wasi
    (same root cause as the earlier `HAVE_SYS_MMAN_H`-style gaps). Fixed by
    also excluding `__wasi__`; the file already had a ready-made empty-stub
    `#else` branch for platforms without rlimits, so no new stub needed.
11. `-ldl` -- `DynamicLibrary.cpp`'s `dlopen`/`dlclose`/`dlerror`/`dlsym`
    calls linked clean once this was added; wasi-libc ships a real `libdl.a`
    for these, found the same way as the `-lwasi-emulated-*` libs (checked
    the sysroot's `lib/wasm32-wasip1/` directly). This was the **last**
    error in the entire build -- fixing it produced a clean, complete
    `bin/clang`.

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

- **`llvm::sys::ExecuteAndWait`/`Wait`** (`Unix/Program.inc`) is a hard
  `report_fatal_error` stub. This means **`clang` will build and link, but
  cannot actually compile anything yet** — every `cc1` invocation goes
  through this path (`-DCLANG_SPAWN_CC1=ON` forces it). Real subprocess
  execution needs a JS-side Worker-based executor; that's a separate,
  substantial piece of work outside this repo (the VS Code extension side),
  not something to attempt in LLVM source. See README's "JS Framework"
  section for what that JS needs to do.
- `CrashRecoveryContext::Enable()`, `ListeningSocket`/`raw_socket_stream`
  socket operations: same treatment, same reason (see README).

## Next milestone

`clang` builds and links cleanly (see STATUS at top). The next real
milestone is building the JS-side Worker executor and actually trying to
compile a trivial `.c` file through it, to prove the
`-DCLANG_SPAWN_CC1=ON` path works end-to-end. That hasn't been attempted
yet -- nothing to report there. Likely first steps for whoever picks this
up:
- A minimal WASI host (in the target VS Code Web extension, or even just a
  standalone Node/`wasmtime` harness for faster iteration) that can run
  `bin/clang` with `wasi_snapshot_preview1` imports satisfied, plus a
  virtual filesystem with a trivial `.c` file in it.
- `llvm::sys::ExecuteAndWait` (`Unix/Program.inc`) will immediately
  `report_fatal_error` the moment it's asked to spawn `cc1` -- that's
  expected and correct until the Worker-based executor exists. A quick,
  *temporary* sanity check that clang's own logic up to that point works
  (arg parsing, `Driver::BuildCompilation`, deciding what jobs to run) could
  be done by checking what happens right before that call, without needing
  a real executor yet.
- Whether `libLLVMSupportBlake3`/checksumming and other perf-sensitive
  pieces behave correctly given `BLAKE3_NO_AVX512` etc. were never actually
  needed once real cross-compilation started (the wasm target naturally has
  none of the x86 SIMD paths) -- worth a quick check that BLAKE3 still
  produces correct hashes on this target, not just that it compiles.

## Nothing has been committed to git yet

All changes are uncommitted working-tree edits (`git status --short` at
repo root to see the list). Ask the user before committing anything.
