# Plan: dedicated file-I/O thread + in-wasm RPC

Status: **implemented, wired into the driver, and verified end-to-end
against a real rebuild of clang.wasm/lld.wasm** (all 6 build-order steps
below done), on its **second design** -- see "What's built" immediately
below, and "Superseded design" further down for the first version's
history (kept because the reasoning for abandoning it, and a real bug it
caught, are both still useful). `-pthread` WASI-threads output programs
get this automatically now; `-mno-wasi-threaded-io` opts out. Linking the
same shim into clang.wasm/lld.wasm itself was investigated and resolved
as unnecessary (see step 6).
**The single-threaded-build follow-up below is now done** — found and
fixed a real CMake bug along the way, confirmed correct non-threaded
compile+link+run, and confirmed a real (separate, not-yet-fixed) defect:
explicit `-mwasi-threaded-io` fails to link on that build instead of
being inert.

## Two build configurations: what actually needs custom JavaScript

Everything in this file so far is about *file-I/O correctness once real
multithreading is already running*. That's a narrower question than "does
clang.wasm need custom JS at all" -- worth separating out explicitly,
because it's easy to conflate the two.

**A specific design goal of this fork**: build `clang.wasm`/`lld.wasm`
*without* threading (`build-single-threaded.bat`, target
`wasm32-unknown-wasip1`, no `-pthread`, no `--import-memory`/
`--shared-memory`) and get a module that **instantiates and runs on any
plain WASI host, with zero custom JavaScript** -- no `wasi-threads`
support, no imported memory, nothing beyond what a generic WASI
implementation already provides. `build.bat` (the threaded configuration,
target `wasm32-unknown-wasip1-threads`, `-pthread`,
`-DLLVM_ENABLE_THREADS=ON`, `-Wl,--import-memory -Wl,--shared-memory`)
trades that away deliberately, for the real multithreading `wip.md`'s
"Real threading" section covers.

**Important correction to how this was described earlier in this
session**: "zero custom JavaScript" for the single-threaded build is true
for *instantiating* the module and for any invocation that doesn't spawn
a subprocess (`--version`, argument-diagnostics-only paths, or running
`lld.wasm` directly against already-produced `.o` files -- the linker
itself never spawns anything). It is **not** true for actually compiling
or combined compile+linking anything, on *either* build configuration --
that needs a small, non-threading piece of custom JS regardless of
threading, described next.

### Why any real compile needs custom JS, on both configurations

Both `build.bat` and `build-single-threaded.bat` set
`-DCLANG_SPAWN_CC1=ON`. This makes the driver always invoke `cc1` (the
actual compilation step) as if it were a separate OS process --
`clang/tools/driver/driver.cpp`'s `UseNewCC1Process` defaults to this
CMake setting, and stays true unless overridden per-invocation with
`-fintegrated-cc1` (more on why that override is a dead end below).
Actually running that "subprocess" -- and, in a combined
compile-and-link invocation, invoking the linker as a second "subprocess"
the same way -- goes through `Command::Execute()`/`Wait()` in
`llvm/lib/Support/Unix/Program.inc`. WASI has no process model at all (no
`fork`/`exec`/`posix_spawn`), so this fork implements it as
`CurrentSpawnHook`, a plain function-pointer slot in the module's own
*exported, growable* indirect call table (`-Wl,--export-table
-Wl,--growable-table`, present in **both** build configs' linker flags
for exactly this reason -- it has nothing to do with threading). The
**default hook fails loudly** (`report_fatal_error`), confirmed directly
against the current `Unix/Program.inc` source (not just its commit
message): the default stub calls `report_fatal_error`, and the exported
install point is literally named `__wasi_shim_set_spawn_hook`, matching
what's described below. So: **a JS host must, after instantiating the
module**, do three things -- (d) grow the module's exported indirect-call
table by one slot, (e) write a JS callback wrapped as a typed wasm
function into that slot which actually implements "run a subprocess" (a
Worker running a fresh instantiation of the module, or of `lld.wasm` for
a link step, run synchronously to completion via `Atomics.wait` on a
small control buffer -- much smaller than real threading's whole-module-
shared memory, and needs no `-pthread`/`wasi-threads` support at all),
and (f) call that exported function to install it. **`documents/js-host-contract.md`
is the canonical, exact recipe for d/e/f** (precise
API calls, parameter types, the Node flag needed) -- verified this
session to still match current source and the current
`ai-notes/wasi_spawn_shim.mjs`; refer to that doc rather than this
one if the two ever seem to disagree, and update both if the mechanism
changes. The point being made here is narrower and doesn't need
restating there: **this exact same requirement applies to both build
configurations equally, is unrelated to threading, and its absence fails
loudly rather than silently doing nothing.**

or every real compile (and every combined compile+link invocation) on
**either** build configuration fails loudly the moment it tries to spawn
`cc1`. This is orthogonal to, and much smaller than, the real-threading
hosting `ai-notes/wasi_thread_hook.mjs` implements -- no shared
module-wide memory, no `wasi.thread-spawn`, no per-thread Workers running
the *same* live instance. The reference implementation is
`ai-notes/wasi_spawn_shim.mjs` (steps d/f) +
`ai-notes/wasi_spawn_worker.mjs` (step e, the actual per-"process"
Worker). `llvm/lib/Support/Unix/Program.inc`'s own commit message
describes the mechanism directly: *"a host that wants real subprocess
support can, after instantiation, grow the module's exported
indirect-call table ... and call ... `__wasi_shim_set_spawn_hook()` to
install it -- all without the module needing to declare any dependency
on that host at link/instantiate time."* That last clause is the load-
bearing one: the module's own `.wasm` file declares no import for this at
all, so it still instantiates with zero custom JS -- it only *traps
loudly* if nothing installs the hook before something tries to use it.

### The flag that looks like an escape hatch, but isn't: `-fintegrated-cc1`

`-fintegrated-cc1` asks the driver to skip the "subprocess" path above
entirely and run `cc1` in the same process -- which sounds like it should
make a compile work with *no* spawn-hook JS at all. It doesn't, on this
fork, for two independent reasons:

1. **It's silently overridden back off for any multi-job invocation.**
   `Driver.cpp`'s `BuildJobs()` forces `J.InProcess = false` for every job
   whenever there's more than one (`C.getJobs().size() > 1`) -- a normal
   `clang -o out foo.c` is two jobs (compile, then link), so
   `-fintegrated-cc1` has no effect on it regardless of build
   configuration. It could only matter for a single-job invocation, e.g.
   a bare `-c` compile with no link step.
2. **Even then, it hits a different fatal stub.** `driver.cpp` calls
   `llvm::CrashRecoveryContext::Enable()` unconditionally whenever
   `UseNewCC1Process` is false (i.e. whenever `-fintegrated-cc1` actually
   takes effect) -- and this fork's `CrashRecoveryContext::Enable()` is
   itself a `report_fatal_error` stub on WASI (see the "WASI: fail loudly
   on signal/subprocess/crash-recovery gaps we can't fill" commit): real
   signal-based crash recovery is structurally impossible on this target
   (a trap terminates the whole instance uncatchably; there's no signal
   handler to install), and this fork deliberately chose to fail loudly
   rather than silently degrade, on the explicit assumption that
   `CLANG_SPAWN_CC1=ON` makes this path dead code in normal use.

Net effect: **there is currently no way to get a real compile out of
either build configuration with fully zero custom JS.** The zero-JS
claim is real and worth keeping as a design goal for *instantiation and
non-compiling invocations*, but a true zero-JS *compile* would require
revisiting the `CrashRecoveryContext::Enable()` design choice (making it
a graceful no-op instead of fatal, accepting reduced crash-recovery
robustness) and building without `CLANG_SPAWN_CC1` -- not attempted, and
not obviously a good trade, since it would mean giving up the
process-boundary crash detection `CLANG_SPAWN_CC1=ON` currently buys.

### Other flags that fail loudly rather than silently doing the wrong thing

Not an exhaustive list, but the ones already hit in this project's
history, all in `Unix/Program.inc`'s spawn mechanism and all
`report_fatal_error`, never a silent no-op or wrong-answer: **I/O
redirection, timeouts, polling, and detached-process support** for a
spawned command aren't implemented. The concrete case already hit:
clang's crash-reproducer regeneration path (triggered automatically on a
`cc1` crash, or explicitly via `-fcrash-diagnostics`-family flags) needs
I/O redirection to capture the reproducer subprocess's output, so a
smoketest deliberately passes `-fno-crash-diagnostics` to avoid
exercising it (see `ai-notes/run_clang_threaded_io_smoketest.mjs` and
`ai-notes/run_clang_tls_repro.mjs`). Extending the spawn-hook wire format
to cover these is possible but deliberately deferred -- nothing in a
normal `-c`/`-o` compile invocation needs them.

## What's built (current design: raw WASI import interception)

`compiler-rt/lib/wasi_threaded_io/wasi_threaded_io.c` -- a single C file,
entirely `#if defined(__wasi__) && defined(__wasm_atomics__)`-guarded
(compiles to nothing on every other target, including the plain
non-threaded `wasm32-unknown-wasip1` compiler-rt pass in build.bat, which
lacks `+atomics`). It:

- Spawns one dedicated I/O-server pthread, lazily on first use
  (`pthread_once`), with an explicit generous stack
  (`pthread_attr_setstacksize`) per constraint 3 below.
- Intercepts the raw WASI Preview1 imports `fd_close`/`fd_fdstat_get`/
  `fd_fdstat_set_flags`/`fd_seek`/`fd_write`/`fd_read`/`fd_pwrite`/
  `fd_pread`/`path_open` -- **not** the POSIX layer (`open`/`read`/
  `write`/...) an earlier version of this file wrapped; see "Why the raw
  WASI import layer, not the POSIX layer" in the file's own header
  comment for the full reasoning. Every intercepted call, from every
  thread including main, marshals to the server thread through a
  single-slot shared-memory mailbox guarded by a spinlock plus a
  plain-atomic-load spin for the response (never `memory.atomic.wait32`;
  see constraint 1 below).
- Only the server thread ever calls the real `wasi_io_real_*` imports, so
  it's the sole owner of the one real fd table -- fixing the shared-fd-
  across-threads gap directly, symmetrically regardless of which thread
  (main or a worker) happens to be the one that opened the fd. See
  "Main-thread-opens, workers-read/write is not a special case" below --
  a question raised, and answered, while building this design.

**No special link flags required** -- this is the main practical
advantage over the superseded `-Wl,--wrap=`-based design: giving a
function body to the exact symbol name wasi-libc calls its raw imports
through (`__imported_wasi_snapshot_preview1_<name>`) turns that import
into an ordinary defined function at link time, with no `--wrap`/`-u`
flags, no `--allow-multiple-definition`, nothing beyond linking the
object in. The dedicated I/O thread reaches the *real* host import via a
second, differently-named import declaration for the identical
`(module, name)` pair (`wasi_io_real_fd_write` etc., declared with the
`import_module`/`import_name` attributes directly) -- wasm permits
multiple import entries for one `(module, name)`, and the host binds
each independently to the same underlying function. Confirmed
empirically before writing the real shim (a standalone repro: a program
linked normally against the real `libc.a`, with an
`__imported_wasi_snapshot_preview1_fd_write` override plus a
`real_fd_write`-named second import) -- no duplicate-symbol error, and
both the test program's `printf` (stdio) path and its raw `write()` call
were observably intercepted (a `[intercepted]` marker byte written by
the override function preceded both outputs when run under Node's WASI
host).

**Verified** the same way as the superseded design was (see that
section for exact methodology): `ai-notes/hello_threads_io.c`'s Case A
and Case B both produce correct output (58 bytes, matching a no-shim
baseline) via both host-side file inspection and the program's own
in-process `fopen`/`fread` check -- full parity with the previous
design's verified result, but with zero required link flags. Additionally
verified the reverse of Case A specifically (see next section): a new
`main_opens.c` test where the *main* thread opens the file and four
*worker* threads `pwrite()` to it -- correct 59-byte interleaved output,
no special-casing needed anywhere in the implementation for "who opened
it."

**fd 0/1/2 (stdin/stdout/stderr) are exempted from the RPC entirely** --
`fd_write`/`fd_read`/`fd_fdstat_get`/`fd_fdstat_set_flags` all call the
real import directly for these three fds, on every thread, without going
through the mailbox. These fds are host-global by convention -- every
thread's own independent WASI host instance already maps them to the
same real stdin/stdout/stderr, which is exactly why console output from
every thread worked correctly all through this investigation, even
before this file's RPC existed for anything else. Routing them through
the RPC anyway would still be correct, but would turn the single mailbox
slot into a global lock on *all* console output -- every thread's
`printf` serializing through one spinlock, including the main thread's,
which is the exact contention pattern constraint 1 (below) exists to
avoid, just reached via a spin instead of a `wait32` trap. Verified with
a stress test (4 threads each looping 200 `printf`s interleaved with
`pwrite`s to a real file): completed in ~150ms with correct output both
with and without the exemption under Node -- no livelock either way on
this host -- but the exemption is kept regardless, since it's strictly
better on contention grounds and there's no evidence it costs anything
(the one case it could get wrong -- a program that itself closes fd
0/1/2 and reuses that number for a real, cross-thread-shared file -- is
rare and already dubious practice). *Not* verified: whether the
un-exempted version would actually livelock on a host that can't yield
the way Node does (a real browser main thread) -- untestable in this
environment, which is exactly why the exemption is kept as a
precaution rather than only as an optimization.

**Operational note, found via the same stress test**: the dedicated I/O
server thread runs forever once spawned (an intentional, persistent
background service thread -- see "What's built" above). A test harness
(or any real host) that waits for all spawned worker threads to exit
naturally before considering the program "done" will hang, even though
the program's actual main-thread computation completed correctly and
promptly -- confirmed directly: the stress test's own output showed all
800 expected `printf`s and a clean `exit 0` in ~150ms inside a log that
a naively-written harness (this session's first version of the stress
test's own runner script) nonetheless waited on indefinitely, because it
was waiting for every worker (including the eternal I/O thread) to
finish rather than acting on the main instance's own `wasi.start()`
return value and then explicitly tearing the process down. Any host
integration needs to actively terminate/kill remaining threads once the
main computation finishes, not wait for the I/O thread to exit on its
own -- it never will.

## Main-thread-opens, workers-read/write is not a special case

Raised as an open question: what happens when the *main* thread opens a
file and other threads read/write it -- doesn't the main thread need
special handling (e.g. proxying I/O for other threads itself, or a
shared-atomic-offset scheme ignoring each thread's private fd table)?

**No special handling needed, and neither workaround is required.** Both
of those would only be necessary under the *original*, since-corrected
version of constraint 1 below (main thread keeps calling its own real
WASI imports directly, only worker threads RPC out) -- under that
design, a file main opens lives in main's own fd table, invisible to the
server thread other workers RPC to, so yes, you'd need one of the two
workarounds the question describes. But that version of constraint 1 was
already corrected before any code was written (see below): **every**
thread, main included, routes through the RPC and only the server thread
ever touches a real fd. Under that design, "main opened it" and "a
worker opened it" are the identical case -- the fd lives in the server's
table either way, and whichever thread later touches that fd number (main
or any worker) reaches the same table through the same RPC. Verified
directly with `main_opens.c` (described above): main opens, four workers
`pwrite()` concurrently, correct interleaved result, no thread-identity
logic involved beyond the existing `on_io_thread()` check (which only
ever answers "am I the dedicated server," never "did I open this fd").

The design's actual constraint is orthogonal to *who opens a file*: it's
about *what "share a fd" means for non-positional `read()`/`write()`*,
and it's not really this design's constraint at all -- it's POSIX's.
Concurrent plain `read()`/`write()` (not `pread`/`pwrite`) on the *same*
fd from multiple threads races on that fd's single shared file-offset
cursor in a real native multi-threaded process too; POSIX never promised
otherwise. A program that needs deterministic per-thread positions on a
shared fd already had to use `pread`/`pwrite` before wasm entered the
picture -- which is exactly why `hello_threads_io.c`'s shared-fd case
uses `pwrite`, not `write`. So the practical answer to "when do I need
to think about this" is: only code that was already relying on
undefined behavior needs to change, and it needed to change regardless
of this design. (The single mailbox happens to serialize concurrent
requests more strictly than a real OS-level shared fd would -- only one
request in flight at a time -- so if anything this design is *less*
racy than native hardware concurrency for the well-defined,
positional-I/O case, not more.)

## Superseded design: POSIX-layer `-Wl,--wrap=` interception

Kept for the reasoning trail on why it was replaced, and because a real
regression it caught (see below) is a useful cautionary example on its
own. The current design (above) supersedes all of this section.

The first working version of the shim intercepted `open`/`openat`/
`read`/`write`/`pread`/`pwrite`/`readv`/`writev`/`close` via
`-Wl,--wrap=`, requiring `-Wl,-u,<sym>` alongside every `--wrap=<sym>`
(see "Linker gotcha" below). It passed `hello_threads_io.c`'s raw-syscall
Case A/B, but a follow-up no-shim-baseline comparison (prompted by
review, not by this session's own testing) showed it silently broke the
program's in-process `fopen()`+`fread()` self-check for *both* cases (0
bytes read instead of 58) -- because `fopen()` calls a wasi-libc-internal
primitive (`__wasilibc_nocwd_openat_nomode`) that bypasses `open`/
`openat` entirely, and `fdopen()` (which `fopen()` calls) runs `fcntl()`/
`isatty()` on the fd it just opened, both of which also weren't wrapped.
Fixed at the time by wrapping those additional, wasi-libc-*internal*
names instead/as well -- but internal names aren't a stable contract
(confirmed by the fact that this gap existed at all), which is exactly
what motivated moving to the raw WASI import layer instead: a small,
spec'd, stable surface with no lower level left to bypass.

## Linker gotcha found while validating the superseded design (`-Wl,-u,<sym>` is required)

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
6. **Done.** `compiler-rt/lib/wasi_threaded_io/CMakeLists.txt` builds the
   shim as a normal compiler-rt component (`clang_rt.wasi_threaded_io-wasm32`,
   registered in `compiler-rt/lib/CMakeLists.txt`); `build.bat`'s old
   hand-rolled compile+`ar` step is gone, replaced by adding that target
   name to the existing `cmake --build` invocation. `clang/lib/Driver/ToolChains/WebAssembly.cpp`
   links the resulting archive into every `-pthread` WASI-threads output
   binary automatically (`WantsThreadedIoShim()`, linked after `-lc` with
   an explicit `-u` safety net -- see that function and the file's own
   comments for why both the placement and the `-u` matter, a second
   instance of the same link-order class of bug as the "Linker gotcha"
   above), gated by a new `-mwasi-threaded-io`/`-mno-wasi-threaded-io`
   driver flag pair (`clang/include/clang/Options/Options.td`), on by
   default. The same change fixed an adjacent, independently-real gap:
   `WantsSharedMemory()` already auto-added `--shared-memory` for
   `-pthread` WASI targets but never `--import-memory`, so a `-pthread`
   output program didn't even get a host-shareable memory without it --
   now added alongside `--shared-memory`, not gated by the opt-out flag (a
   plain correctness fix, independent of file I/O). Scoped specifically to
   the `"-threads"` environment component of the triple (an advisor review
   caught that `WantsSharedMemory()` is also true for plain `-pthread` on
   e.g. `wasm32-wasip1`, or a `wasip2`/`wasip3` `-pthread` link through
   `wasm-component-ld` -- neither of those is this fork's per-thread-Worker
   hosting model, and an imported memory may not even be valid for a
   wasm-component-ld output, so the fix intentionally does not reach
   those). Likewise `WantsThreadedIoShim()` is gated on
   `Triple.isOSWASI()`, so an explicit `-mwasi-threaded-io` on a
   non-WASI target (e.g. `wasm32-emscripten`) is inert rather than
   requesting a nonexistent `compiler-rt` archive.

   **Verified against a real, from-scratch rebuild of `clang.wasm`/`lld.wasm`**
   (not just the shim linked in by hand, as every previous verification
   in this doc was): ran the actual `ai-notes/run_clang_threaded_io_smoketest.mjs`
   (updated to no longer pass `-Wl,--import-memory` by hand, proving the
   driver now supplies it) driving clang.wasm itself to compile
   `hello_threads_io.c` with a plain `--target=wasm32-wasip1-threads
   -pthread` invocation. The actual `wasm-ld` command line clang.wasm
   generated confirms both fixes landed: `--shared-memory --import-memory`
   present, and `-u __imported_wasi_snapshot_preview1_fd_write
   .../libclang_rt.wasi_threaded_io.a` appended after `-lc`, exactly as
   designed. Running the result: Case A (shared fd across threads)
   succeeds with correct 58-byte output, matching every prior
   manually-linked verification. Re-ran with `-mno-wasi-threaded-io`
   added to the same invocation and confirmed the *opposite*: the
   generated `wasm-ld` command line has no `-u`/no shim archive, and the
   resulting binary reproduces the original, pre-shim EBADF failure on
   Case A exactly (Case B, which doesn't share a fd across threads,
   still succeeds either way) -- proving the flag is a real, working
   toggle, not just that the default path happens to work.

   **Resolved (2026-09-06):** linking the same shim into clang.wasm/lld.wasm
   itself is not needed, regardless of input size. Confirmed by reading
   the code, not just re-running the trivial case: `lld/wasm/Writer.cpp`'s
   only two `parallelFor`/`parallelForEach` sites (`writeSections`,
   `computeHash`) write into an in-memory buffer via `memcpy`, never a raw
   fd; `llvm::FileOutputBuffer`'s two backing implementations
   (`OnDiskBuffer`'s mmap region, `InMemoryBuffer`'s anonymous memory
   block -- the WASI-relevant one, since mmap isn't available) both defer
   the actual file descriptor I/O to `commit()`, which only runs after
   `parallelFor`/`parallelForEach` have already joined all workers -- i.e.
   only on the original calling thread, never concurrently. clang.wasm's
   own compile path (`cc1`) runs as a fully separate spawned instance (own
   linear memory, own fd table) rather than in-module threading at all,
   and a normal `-c` compile never invokes `ThreadPoolStrategy`. See
   `documents/remaining_work.md` for the full evidence trail.

## Follow-up: verify the single-threaded build is unaffected

Not yet started. Per the approved plan's original verification section
item 3, still open:

- Build (or use an existing) `build-single-threaded.bat` output
  (`wasm32-unknown-wasip1`, no `-pthread`) and confirm it still produces
  ordinary, correct non-threaded compiled output -- i.e. that nothing in
  this change regressed the plain build.
- Confirm `-mwasi-threaded-io`/`-mno-wasi-threaded-io`, passed to that
  build's clang.wasm, are silently accepted (inert) rather than erroring
  -- consistent with how other target-inapplicable driver flags behave.
  `WantsThreadedIoShim()`'s `Triple.isOSWASI()` guard should already make
  this true in principle (a plain `wasm32-unknown-wasip1` triple is
  still WASI, so the flag is accepted and parsed either way; the question
  is just whether passing it produces any observable difference when
  `-pthread` was never present to begin with -- it shouldn't, since
  `WantsSharedMemory()`, and therefore the default, is false without
  `-pthread` regardless of the flag), but this has not actually been
  exercised against a real `build-single-threaded.bat` binary.

Worth scoping as a short, focused follow-up rather than folding in
opportunistically -- it's a distinct verification pass against a
separate build config, not new design work.

**Correction found while starting this follow-up (before the
single-threaded binary even existed)**: the plan's own expectation above
-- "it shouldn't [make a difference], since `WantsSharedMemory()`...is
false without `-pthread` regardless of the flag" -- is wrong for the
explicit-opt-in direction. Checked directly against the existing,
already-verified threaded `build/bin/clang.wasm` (same driver code both
builds share): `WantsThreadedIoShim()` is `Args.hasFlag(mwasi_threaded_io,
mno_wasi_threaded_io, Default)` (`clang/lib/Driver/ToolChains/WebAssembly.cpp`),
so an **explicit** `-mwasi-threaded-io` always overrides `Default`
regardless of `-pthread` -- confirmed via a `-###` dry-run comparison
(`--target=wasm32-wasip1`, no `-pthread`): the no-flag and
`-mno-wasi-threaded-io` runs produce byte-identical `wasm-ld` command
lines (shim absent), but explicit `-mwasi-threaded-io` alone *does* add
`-u __imported_wasi_snapshot_preview1_fd_write` plus the
`libclang_rt.wasi_threaded_io.a` archive path -- a real, intended
difference (explicit flags always beat a computed default; this is
ordinary `hasFlag` semantics, not a bug in `WebAssembly.cpp`). This is
harmless on the *threaded* build, where `wasi_threaded_io.c`'s
`__wasm_atomics__` guard is satisfied and the archive is real.

**Why this matters for the single-threaded build specifically**: its
compiler-rt pass targets plain `wasm32-unknown-wasip1` (no `+atomics`),
so `wasi_threaded_io.c` compiles to an *empty* archive (by design --
see "What's built" above). An explicit `-mwasi-threaded-io` there would
still add `-u __imported_wasi_snapshot_preview1_fd_write` pointing at
that empty archive -- and `-u` forces the linker to require the symbol
exist, which it won't.

**Confirmed against the real single-threaded binary** (compile+link via
`build-single-threaded/bin/clang.wasm`, no `-pthread`): explicit
`-mwasi-threaded-io` alone does fail -- `wasm-ld: error: cannot open
.../libclang_rt.wasi_threaded_io.a: No such file or directory`, exit
code 1, no `.wasm` produced. `-mno-wasi-threaded-io` and the no-flag
default both succeed with byte-identical `wasm-ld` invocations (shim
absent) and produce a correct, runnable binary either way -- so the
plan's original "silently inert" expectation holds for those two, but
**not** for explicit `-mwasi-threaded-io`, which is a real, confirmed
gap in this checklist item, not just a predicted risk.

The immediate cause is even more basic than the predicted "-u against an
empty archive": `build-single-threaded.bat`'s `cmake --build` line never
lists `clang_rt.wasi_threaded_io-wasm32` as a target at all (unlike
`build.bat`'s line 39, which does) -- see build-order step 6 above -- so
the archive doesn't exist in this build's output *at all*, empty or
otherwise. Adding that target to `build-single-threaded.bat` would only
trade one error for the originally-predicted one (`-u` against a
genuinely-empty archive, since this target lacks `+atomics`) -- it would
not make the flag actually work. **The real fix belongs in
`WantsThreadedIoShim()`** (`clang/lib/Driver/ToolChains/WebAssembly.cpp`):
it currently gates only on `Triple.isOSWASI()`, but needs to also check
for atomics/threads support before honoring an explicit
`-mwasi-threaded-io`, the same way `--import-memory`'s addition above is
scoped to `Triple.getEnvironmentName() == "threads"` rather than the
broader `WantsSharedMemory()`. **Fixed** (follow-up session): `WantsThreadedIoShim()`'s existing check
site in `wasm::Linker::ConstructJob` now checks whether the resolved
`clang_rt.wasi_threaded_io` archive actually exists (via
`ToolChain.getVFS().exists(...)`) before appending it, instead of trusting
`wasm-ld` to fail correctly. When it doesn't exist, emits a new, detailed
diagnostic (`err_drv_wasi_threaded_io_unavailable` in
`DiagnosticDriverKinds.td`) explaining *why* (this clang's own compiler-rt
wasn't built with atomics/shared-memory support) and suggesting
`-mno-wasi-threaded-io` as the fix -- per the user's stated preference for
detailed, "did you mean" -style errors over silent no-ops or cryptic
lower-level failures. Verified against the real single-threaded binary
(incremental rebuild, no full LLVM rebuild needed): explicit
`-mwasi-threaded-io` now produces the clear driver error instead of
`wasm-ld`'s "no such file" failure; the no-flag default and
`-mno-wasi-threaded-io` remain confirmed silently inert; ordinary
compile+link+run is unaffected.

## Why this is scoped as its own session

Per the user's standing "when to suggest a new session" preference: this
is a from-scratch runtime component (new C source, a different link-time
story for two different binary classes, a host-side change so the I/O
thread gets spawned before any user thread needs one) -- a different mode
of work than the implementation/debugging that filled the session this
was raised in, and substantial enough to deserve its own plan rather than
being folded in opportunistically.
