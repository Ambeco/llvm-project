# Plan: dedicated file-I/O thread + in-wasm RPC

Status: **implemented and verified for the "output program" case** (steps
1-5 of the build order below). Not yet wired into build.bat/CMake or the
clang driver (step 6, and linking this into clang.wasm itself, remain
future work).

## What's built

`compiler-rt/lib/wasi_threaded_io/wasi_threaded_io.c` -- a single C file,
entirely `#if defined(__wasi__) && defined(__wasm_atomics__)`-guarded (compiles
to nothing on every other target, including the plain non-threaded
`wasm32-unknown-wasip1` compiler-rt pass in build.bat, which lacks
`+atomics`). It:

- Spawns one dedicated I/O-server pthread, lazily on first use
  (`pthread_once`), with an explicit generous stack
  (`pthread_attr_setstacksize`) per constraint 3 below.
- Intercepts `open`/`openat`/`read`/`write`/`pread`/`pwrite`/`readv`/
  `writev`/`close` via `-Wl,--wrap=`, and marshals every one of them --
  from every thread, main included -- to the server thread through a
  single-slot shared-memory mailbox guarded by a spinlock plus a
  plain-atomic-load spin for the response (never `memory.atomic.wait32`;
  see constraint 1 below, which was corrected from the original plan).
- Only the server thread ever calls the real `__real_*` entry points, so
  it's the sole owner of the one real fd table -- fixing the shared-fd-
  across-threads gap directly.

**Required link flags** (see the file's own header comment for the
canonical list): for every wrapped name `X`, pass both
`-Wl,--wrap=X` **and** `-Wl,-u,X`. The `-u` half is not optional --
see "Linker gotcha found while validating" below.

**Verified**: compiled `ai-notes/`'s `hello_threads_io.c` (Case A: main
thread opens one fd, hands the plain int to 4 worker threads, each
`pwrite()`s at a distinct offset using that same fd -- previously failed
with EBADF) directly with the wasi-sdk clang plus this shim linked in
(not yet through clang.wasm itself), ran it under the existing
`ai-notes/wasi_thread_hook.mjs` harness, and confirmed via host-side file
inspection that both Case A and Case B now produce fully correct,
interleaved output. This is the smoketest program `run_clang_threaded_io_smoketest.mjs`
already describes; a version of that script driving clang.wasm itself to
produce this same shimmed binary (rather than compiling it by hand as
done here) is the natural next verification step once step 6 (build
system / driver wiring) happens.

## Linker gotcha found while validating (`-Wl,-u,<sym>` is required)

`-Wl,--wrap=pread` alone silently produces a broken build: if nothing
else in the link calls plain `pread()`, nothing forces wasm-ld to pull
`pread.c.obj` out of `libc.a` in the first place, so `__real_pread` ends
up aliased to the wrong function (observed: it silently got attached to
an unrelated import's function slot, with a mismatched signature) --
**no link error**, but the resulting module fails `WebAssembly.compile()`
at load/run time with a cryptic type-mismatch error (e.g. `call[0]
expected type i32, found i64.load of type i64`) pointing at
`do_real_io`, nowhere near the real cause. Confirmed by bisection
(compiled increasingly minimal test programs down to a single
`__real_pread`-only call with no plain `pread()` call anywhere) that
adding `-Wl,-u,pread` (forcing the archive member to be extracted before
`--wrap` renames it) fixes it. Applies to any of the 9 wrapped names that
your particular program doesn't already call directly by its plain
POSIX name -- so always pass `-u` alongside every `--wrap`, don't rely on
the program under test happening to reference the name itself.

## Original design notes (kept for context)

## Background / confirmed problem

`ai-notes/run_clang_threaded_io_smoketest.mjs` confirmed a real gap: our
wasi-threads hosting model gives each spawned thread its own independent
`node:wasi` instance with its own private fd table (see
`ai-notes/wasi_thread_worker.mjs`). A real pthread program's normal
pattern -- main thread opens one fd, shares the plain `int` with worker
threads, each thread `pwrite()`s using that same fd number -- fails with
`EBADF`, since the fd number is meaningless in a worker's own table.
Independent per-thread `open()` calls to the same path work fine (proven
by the smoketest's Case B).

This isn't an LLVM/clang/lld bug. It affects both clang.wasm itself (if
its own multithreaded code path ever shares a fd across threads) and any
`-pthread` program clang.wasm compiles as output (which is free to use
this completely normal POSIX pattern).

Full narrative and confirmation details: see `ai-notes/wip.md`'s
"Confirmed: shared-fd-across-threads gap, and the fix's shape" section.

## Planned fix, in one sentence

One dedicated I/O thread owns the real, canonical fd table (via its own
host WASI instance/preopens); every other thread marshals file-I/O
requests to it over a shared-memory mailbox/queue using wasm atomics,
instead of calling `open`/`read`/`write`/etc. directly.

## Two constraints that shape the design

Constraints 1 and 2 below were found via advisor review before any code
was written; both turned out to need correction once actually building
and validating the shim (see "What's built" above). Kept here, corrected
in place, for the reasoning trail.

1. ~~The main thread cannot block on `memory.atomic.wait32`... let the
   main thread keep calling its own real WASI imports directly...~~
   **Corrected**: this breaks the fd-table-has-one-owner invariant the
   whole design depends on -- if main opens its own fd in its own table
   while other threads route through the server's table, a shared fd
   Case-A-style program fails exactly the way it did before any fix
   (main's fd number means nothing in the server's table). The real,
   narrower constraint is just "don't call `memory.atomic.wait32` on the
   main thread" -- it still traps on a real browser main/UI thread. The
   implemented fix: **every** thread, main included, routes through the
   RPC, and **no** thread (main or worker) uses `memory.atomic.wait32`/
   `notify32` at all -- every waiter (submit-lock acquisition, and
   waiting for the response) is a plain `atomic_load`/`sched_yield()`
   spin. This sacrifices blocking-efficiently-parked threads for one
   waiter strategy that's provably correct on every host, main thread
   included; revisit only if spin-induced CPU burn actually matters in
   practice.

2. **Where you intercept determines whether a wasi-libc fork/wrap is
   needed** -- confirmed empirically (see "Linker gotcha" above for the
   *other* wrap surprise found along the way): checked the prebuilt
   `libc.a`'s per-object-file undefined symbols directly (no wasi-libc
   source available locally -- only headers/libs ship in the wasi-sdk;
   the archive's undefined-symbol table answers the same question just
   as well). Confirmed `__stdio_write`/`__stdio_read` bottom out in
   `writev`/`readv` (not `write`/`read`), so `-Wl,--wrap=` **does** cover
   the stdio (`fopen`/`fread`/`fwrite`) path too, as long as `readv`/
   `writev` are included in the wrapped set (they are) -- the import-
   symbol-override fallback this constraint worried about was not
   needed.

3. **`--stack-first` does not localize stack overflows on spawned
   threads.** (Correction to earlier claims made in this investigation.)
   The `-Wl,-z,stack-size=... -Wl,--stack-first` fix applied in
   `build.bat` places *the main thread's* stack at the bottom of linear
   memory so overflow underflows past address 0 and traps immediately.
   Spawned pthread stacks come from wasi-libc's own runtime allocation,
   not that linker-placed region -- a deep call chain on the new I/O
   server thread (which will be running a request-dispatch loop plus
   whatever real libc I/O paths it calls into) can still silently corrupt
   adjacent memory on overflow, the way the *original* (pre-fix) crash
   did. Worth deliberately giving the I/O server thread a generous stack
   if/when it's spawned with an explicit stack size, and not assuming
   `--stack-first`'s protection extends to it.

## Suggested build order for the next session

1. ~~Write the actual protocol design into this doc before writing
   code~~ **Done** -- see "What's built" above; single mailbox slot,
   spinlock + spin-wait, no ring buffer yet (not needed so far).
2. ~~Verify the interception layer~~ **Done, `--wrap` confirmed
   sufficient** -- see constraint 2 above (checked the prebuilt archive's
   undefined symbols directly, no wasi-libc source needed).
3. **Skipped, deliberately**: verifying `memory.atomic.wait32`/`notify32`
   on a plain shared global turned out to be moot -- the implementation
   doesn't use wait32/notify32 anywhere (see constraint 1's correction
   above), so there was nothing to validate on that path.
4. ~~Build the shim~~ **Done**:
   `compiler-rt/lib/wasi_threaded_io/wasi_threaded_io.c`.
5. ~~Confirm the existing smoketest Case A now passes~~ **Confirmed**,
   but not yet through `run_clang_threaded_io_smoketest.mjs` itself --
   that script drives clang.wasm to *compile* `hello_threads_io.c` first,
   which doesn't yet link this shim in (needs step 6). Verified instead
   by compiling `hello_threads_io.c` directly with the wasi-sdk clang
   plus this shim and the link flags above, then running the result
   through `ai-notes/wasi_thread_hook.mjs`'s harness -- host-side file
   inspection confirms correct, non-corrupted interleaved output for
   Case A. Updating the smoketest script itself to build this way (or
   adding a new one) and wiring it into whatever this repo uses for
   regression checks is worth doing once step 6 lands, so this stops
   being a manually-reproduced result.
6. **Not yet started**: wire the wrap/force-include link flags into
   build.bat/CMake so clang.wasm-compiled `-pthread` output programs get
   this automatically, and separately decide whether/how to link the
   same shim into clang.wasm itself (per earlier investigation in
   `ai-notes/wip.md`, clang's own compile path didn't appear to exercise
   real threading for typical compiles -- worth re-confirming whether
   this matters for clang.wasm at all before spending effort wiring it
   in there too). This step is C++ driver/build-system work and can't
   itself be `#ifdef __wasi__`-guarded the way the shim's own source is;
   keep it as a distinct, separately-reviewable change from the shim.

## Why this is scoped as its own session

Per the user's standing "when to suggest a new session" preference: this
is a from-scratch runtime component (new C source, a different link-time
story for two different binary classes, a host-side change so the I/O
thread gets spawned before any user thread needs one) -- a different mode
of work than the implementation/debugging that filled the session this
was raised in, and substantial enough to deserve its own plan rather than
being folded in opportunistically.
