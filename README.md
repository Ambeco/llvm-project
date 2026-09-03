# The LLVM Compiler Infrastructure

[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/llvm/llvm-project/badge)](https://securityscorecards.dev/viewer/?uri=github.com/llvm/llvm-project)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/8273/badge)](https://www.bestpractices.dev/projects/8273)
[![libc++](https://github.com/llvm/llvm-project/actions/workflows/libcxx-build-and-test.yaml/badge.svg?branch=main&event=schedule)](https://github.com/llvm/llvm-project/actions/workflows/libcxx-build-and-test.yaml?query=event%3Aschedule)

## About this fork

This fork of Clang is a testing ground from [mainline
Clang](https://github.com/llvm/llvm-project) for some minor adjustments
enabling Clang to be compiled to wasi+wasm, for eventual use in a Visual
Studio Code for Web extension that compiles and runs (and ideally debugs)
C++ programs without any local install. It's built with `wasi-sdk` against
the `wasm32-wasip1` target; see `build.bat` for the full toolchain
invocation.

### Changes

- `llvm/include/llvm/ADT/bit.h`: recognize `__wasi__` as a platform with a
  usable `<endian.h>` (wasi-libc has one; it just wasn't in the OS list).
- `llvm/cmake/modules/HandleLLVMOptions.cmake`: treat the wasm32-wasi target
  as Unix-like (`LLVM_ON_UNIX=1`) so LLVMSupport's `Unix/*.inc` platform
  implementations get compiled at all, instead of neither the Unix nor the
  Windows ones.
- `llvm/lib/Support/CrashRecoveryContext.cpp`: WASI has no signal delivery
  and no working `setjmp`/`longjmp`, so real crash recovery is impossible in
  a single module instance; `Enable()` now fails loudly instead of silently
  pretending to work. The build relies on `-DCLANG_SPAWN_CC1=ON` (see
  `build.bat`) so `Enable()` is never actually called by the driver.
- `llvm/lib/Support/Unix/Program.inc`: real subprocess spawning
  (`Execute`/`Wait`, i.e. `posix_spawn`) doesn't exist on WASI; both fail
  loudly pending a JS-side Worker-based executor (see "JS Framework" below).
- `llvm/lib/Support/Unix/Signals.inc`: WASI can't install real signal
  handlers, so handler registration (crash backtraces, Ctrl-C, cleanup-on-
  signal) becomes a silent no-op -- nothing depends on it succeeding. The
  underlying cleanup machinery (`RemoveFileOnSignal`, `RunInterruptHandlers`,
  `CleanupOnSignal`) stays fully functional and exported, for a JS host to
  call directly instead of relying on a signal to trigger it.
- `llvm/lib/Support/Unix/Process.inc`: no core dumps to prevent (already
  true), no `TIOCGWINSZ` (terminal width falls back to 0/`$COLUMNS`), no
  signal masking needed around closing a file descriptor (there are no
  signals to mask).
- `llvm/lib/Support/Unix/Path.inc`: no user database (tilde-username
  expansion and the `getpwuid_r` home-directory fallback fail gracefully,
  same as an ordinary lookup failure), no `posix_madvise` (no-op, same as
  other platforms without madvise), no `umask`/real `fchown`, no on-disk
  path for the running executable (`getMainExecutable` returns `""`).
- `llvm/lib/Support/Unix/Watchdog.inc`: no `alarm()`/signals, so the
  watchdog timer is a no-op; real timeout enforcement is expected to happen
  by the JS host terminating the Worker (see below).
- `llvm/lib/Support/Unix/Unix.h`: guard the `<sys/wait.h>` include, which
  doesn't exist on WASI.
- `llvm/lib/Support/LockFileManager.cpp`: no `getsid()` to check whether a
  lock's owning process is still alive; conservatively assume it is.
- `llvm/lib/Support/ProgramStack.cpp`: no `RLIMIT_STACK`; falls back to the
  same fixed 8MiB default already used on non-Unix platforms.
- `llvm/lib/Support/raw_socket_stream.cpp`: no BSD sockets API on WASI;
  socket operations fail loudly rather than silently.
- `clang/tools/driver/cc1_main.cpp`: same `RLIMIT_STACK` gap as
  `ProgramStack.cpp` above, reached via `CLANG_HAVE_RLIMITS` (a
  `check_include_file(sys/resource.h)` check that only confirms the header
  exists, not that its rlimit content is usable on WASI). The file already
  had an empty-stub fallback for platforms without rlimits; WASI now takes
  that path too.
- `llvm/include/llvm/Support/Compiler.h` and
  `clang/include/clang/Support/Compiler.h`: a pre-existing upstream typo,
  unrelated to WASI specifically -- both checked the never-defined
  `__WASM__` instead of the real predefined macro `__wasm__`, silently
  leaving `LLVM_TEMPLATE_ABI`/`CLANG_TEMPLATE_ABI` undefined for any wasm
  target and producing bizarre "explicit instantiation ... does not refer
  to a template" errors.

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
that individually looked like missing-symbol bugs.

### JS Framework

Running the resulting `clang.wasm` requires the hosting JavaScript to
provide functionality no WASI host does by default:

- **Custom host-provided functions**, to unlock functionality currently
  stubbed out as a hard failure:
  - A process-spawning primitive backing `llvm::sys::ExecuteAndWait`/`Wait`
    (`Unix/Program.inc`) -- needed for `cc1` invocation (the build forces
    `-DCLANG_SPAWN_CC1=ON`, so every `cc1` invocation goes through this path)
    and for invoking an external assembler/linker if not fully integrated.
    The natural implementation is spawning a second Worker running its own
    wasm instance for the child "process."
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
