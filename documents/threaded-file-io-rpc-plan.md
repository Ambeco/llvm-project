# Plan: dedicated file-I/O thread + in-wasm RPC

Status: **not started — design notes only, for a fresh session to pick up.**

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

## Two constraints that shape the design (found via advisor review,
not yet validated empirically -- verify before building on them)

1. **The main thread cannot block on `memory.atomic.wait32`.** This
   traps on a real browser main/UI thread (Node's `worker_threads` main
   thread tolerates it, which is why the *existing* spawn shim's
   `Atomics.wait` usage works today in our Node-only reference
   implementation -- but that would not generalize to VS Code for Web).
   Consequence: **the I/O server must be a separate, dedicated spawned
   thread, never the main thread.** The main thread needs a non-blocking
   way to do its own I/O -- simplest option: let the main thread keep
   calling its own real WASI imports directly (it owns its own fd table;
   clang's actual driver is single-threaded there), and only route
   *other* threads' I/O through the RPC. Don't try to route the main
   thread through the same blocking RPC path "for uniformity" -- that's
   the option that breaks in a real browser host.

2. **Where you intercept determines whether a wasi-libc fork/wrap is
   needed, and the two options aren't equivalent:**
   - Override the `__imported_wasi_snapshot_preview1_fd_*` import symbols
     directly (provide strong definitions, let the linker prefer them
     over wasi-libc's own). Lowest layer; catches everything including
     `FILE*`/stdio paths. But `path_open` returns an fd relative to a
     *preopen directory fd*, so the shim must also proxy preopen
     resolution, not just read/write.
   - Wrap `open`/`read`/`write`/`pwrite`/`close` via `-Wl,--wrap=`.
     Simpler to reason about, but if wasi-libc's stdio (`fopen`/`fread`/
     etc.) calls the lower `__wasi_fd_*` import layer directly rather than
     going through the wrapped POSIX functions, stdio callers would
     silently bypass the wrap entirely. **This is exactly the pattern the
     existing smoketest program uses** (`fopen`/`fread` in `run_case()`
     in `hello_threads_io.c`), so this isn't a hypothetical -- check it
     first.
   - **Action before writing any shim code**: grep wasi-libc's sysroot
     sources/headers (under the wasi-sdk sysroot, or upstream
     `wasi-libc`) for where stdio's buffered I/O bottoms out. If it goes
     straight to `__wasi_fd_write`/`__wasi_fd_read`, the import-symbol
     override is the only option that actually works; `--wrap` is a dead
     end.

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

1. **Write the actual protocol design into this doc** (or a follow-up
   doc) before writing code: mailbox/queue layout in shared linear
   memory, request/response struct shape, how "which thread is the I/O
   thread" gets communicated (e.g. a well-known global set at
   startup), how many concurrent in-flight requests are supported
   (a single mailbox slot + full block, vs. a small ring buffer).
2. **Verify the interception layer** per point 2 above, empirically
   (grep wasi-libc sources), before assuming either approach works.
3. **Verify the atomics primitive works as expected on a plain global**,
   isolated from any libc I/O -- a minimal two-thread test (extend
   `ai-notes/run_wasi_threads_prototype.mjs`'s pattern: one thread
   increments a shared global via atomic add/wait/notify while another
   thread waits on it) confirms `-pthread`-linked non-TLS globals really
   do live in shared memory and that `memory.atomic.wait32`/`notify32`
   behave as expected under our Node-based host, before building a
   request/response protocol on top.
4. **Build the shim** (whichever layer #2 selected), first only for the
   `hello_threads_io.c`-style user-program case (simpler: fixed set of
   preopens, one designated I/O thread spawned explicitly by the test
   harness before any worker needs it).
5. **Confirm the existing smoketest (`run_clang_threaded_io_smoketest.mjs`
   Case A) now passes** with the shim linked in, without editing the test
   program itself (proving the fix is transparent to user code).
6. **Only then** consider whether/how to link the same shim into
   clang.wasm itself, and whether clang.wasm's own threading ever
   actually needs it (per earlier investigation in `ai-notes/wip.md`,
   clang's own compile path didn't appear to exercise real threading for
   typical compiles -- worth re-confirming whether this matters for
   clang.wasm at all before spending effort wiring it in there too).

## Why this is scoped as its own session

Per the user's standing "when to suggest a new session" preference: this
is a from-scratch runtime component (new C source, a different link-time
story for two different binary classes, a host-side change so the I/O
thread gets spawned before any user thread needs one) -- a different mode
of work than the implementation/debugging that filled the session this
was raised in, and substantial enough to deserve its own plan rather than
being folded in opportunistically.
