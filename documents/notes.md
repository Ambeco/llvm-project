# Misc. notes

Things learned along the way that don't fit cleanly into `design.md`,
`remaining_work.md`, or one of the more specific `documents/*.md` files.
Add to this file as we go, rather than letting these live only in chat
history.

## Build note: link libraries and flags

`build.bat` links against `-lwasi-emulated-signal -lwasi-emulated-getpid
-lwasi-emulated-mman -lwasi-emulated-process-clocks -ldl` -- all real,
first-party libraries wasi-sdk ships (found by reading the `#error` text in
the relevant sysroot headers, or by checking `lib/wasm32-wasip1/` directly
for `-ldl`).

`_GNU_SOURCE` is also set globally in `CMAKE_C_FLAGS`/`CMAKE_CXX_FLAGS`:
wasi-libc's `features.h` auto-enables POSIX-visibility declarations unless
`__STRICT_ANSI__` is defined, which LLVM's `-std=c++17` (not
`-std=gnu++17`) does -- this one flag fixed a large batch of
`sigfillset`/`siginfo_t`/`SA_NODEFER`-style "undeclared identifier" errors
that individually looked like missing-symbol bugs.

`-Wl,--export-table -Wl,--growable-table` are required for
`Unix/Program.inc`'s spawn hook (see `documents/js-host-contract.md`): the
first exports the module's indirect-call table so a JS host can find it at
all, the second removes its fixed maximum size so `Table.prototype.grow()`
doesn't fail once a host tries to add a slot to it.

`wasm-ld` defaults a shared memory's max to its min unless `--max-memory`
is passed explicitly -- clang started with ~7MB of heap and crashed on its
first allocation before this was set to 2GiB (`-Wl,--max-memory=2147483648`
in `build.bat`).

`clang.wasm`'s own default target being the `-threads` triple
(`wasm32-unknown-wasip1-threads`) means `compiler-rt`'s builtins need a
*second*, separate build pass targeting plain `wasm32-wasip1`, since
`COMPILER_RT_DEFAULT_TARGET_ONLY=ON` only builds for whichever triple is
active at configure time -- `build.bat`'s `build-compiler-rt-nt` step
exists solely for this, and copies its output into the main build's
resource dir by hand.

## `node:wasi`'s exported-memory requirement

[`node:wasi`](https://nodejs.org/api/wasi.html)'s `WASI` class
hard-requires `instance.exports.memory` and throws otherwise -- it does
not support a module whose memory is *imported*, which every wasi-threads
module's must be. Worked around with `makeFakeInstance()` (see
`ai-notes/wasi_thread_hook.mjs`): a plain object duck-typing an `Instance`
(node:wasi only ever reads `.exports` off whatever it's given), with
`memory` added and -- for anything that isn't the main/command instance --
`_start` removed so `wasi.initialize()` doesn't refuse it. Not yet verified
whether a real browser WASI host (e.g. VS Code for Web's `wasm-wasi-core`)
shares this limitation -- see `documents/vscode-wasi-host.md`.

## `-Wl,-u,<sym>` is required alongside `-Wl,--wrap=<sym>`

`-Wl,--wrap=pread` alone can silently produce a broken build: if nothing
else in the link calls plain `pread()`, nothing forces wasm-ld to pull
`pread.c.obj` out of `libc.a` in the first place, so `__real_pread` ends up
aliased to the wrong function -- no link error, but the resulting module
fails `WebAssembly.compile()` at load/run time with a cryptic
type-mismatch error nowhere near the real cause. A static archive member is
only pulled into a link if something has an unresolved reference to one of
its symbols at the point the linker reaches that archive on the command
line. Fix: always pass `-Wl,-u,<sym>` alongside every `-Wl,--wrap=<sym>`,
and, for any archive linked in similarly (e.g.
`clang_rt.wasi_threaded_io`), an explicit `-u` on one of its symbols as an
order-independent safety net. Full detail and a second instance of this
same class of bug: `documents/threaded-file-io-rpc-plan.md`.

## `WantsSharedMemory()` is broader than "the -threads triple"

`clang/lib/Driver/ToolChains/WebAssembly.cpp`'s `WantsSharedMemory()`
(and therefore anything gated on it) is true for `-pthread` on *any* WASI
target, not just `wasm32-wasip1-threads` -- including plain
`wasm32-wasip1` with `-pthread` passed explicitly, and `wasm32-wasip2`/
`wasip3` (which link through `wasm-component-ld`, where an imported memory
may not even be valid for a component). Anything added under this
condition should be double-checked against whether it's actually safe for
those other targets too, or scoped more narrowly (e.g. by
`Triple.getEnvironmentName() == "threads"`) -- see the `--import-memory`
fix in `documents/threaded-file-io-rpc-plan.md` for a concrete case where
this mattered.

## Compiler-rt CMake components auto-scope to the configured target

`add_compiler_rt_runtime()` components (e.g.
`compiler-rt/lib/wasi_threaded_io`) don't need their own target-filtering
logic when the project already sets `COMPILER_RT_DEFAULT_TARGET_ONLY=ON`
(both `build.bat` and `build-single-threaded.bat` do) -- that flag already
scopes every runtime component to whichever triple is active at configure
time. A component guarded by its own `#if defined(__wasi__) &&
defined(__wasm_atomics__)` (or similar) compiles to an harmless empty
archive on a target where the guard is false, with no CMake-side
conditional needed.
