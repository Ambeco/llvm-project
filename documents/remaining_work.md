# Remaining work

See `documents/design.md` for overall context and `ai-notes/wip.md` for
the full narrative/detail behind each item below.

## Done: dedicated file-I/O thread + in-wasm RPC, wired into the driver

See `documents/threaded-file-io-rpc-plan.md` for the full design notes,
constraints, and build order. Summary: confirmed that sharing a plain fd
across wasi-threads workers fails (`EBADF`), since each worker gets its
own independent host WASI instance/fd table. Fix: one dedicated
I/O-owning thread, every other thread RPCs to it over a single-slot
shared-memory mailbox (spinlock + plain-atomic spin, no
`memory.atomic.wait32`), intercepting the raw WASI Preview1 import layer
rather than the POSIX layer. **Implemented, built as a real compiler-rt
component (`clang_rt.wasi_threaded_io`), and wired into
`clang/lib/Driver/ToolChains/WebAssembly.cpp` so every `-pthread`
WASI-threads output binary links it automatically** (opt out with
`-mno-wasi-threaded-io`); verified end-to-end against a real rebuild of
clang.wasm/lld.wasm, including the actual generated `wasm-ld` command
line in both the shim-enabled and shim-disabled directions. The same
change fixed an adjacent gap where `--shared-memory` was auto-added for
`-pthread` WASI-threads targets but `--import-memory` never was.

### Done: verify the single-threaded build is unaffected

Built `build-single-threaded.bat`'s clang.wasm/lld.wasm from scratch and
confirmed a real compile+link+run ("Hello, world!") produces correct
non-threaded output — item 1 of the checklist, fully passed. Item 2 is
mixed: the no-flag default and `-mno-wasi-threaded-io` are both silently
inert as expected (byte-identical `wasm-ld` invocations, shim absent),
but explicit `-mwasi-threaded-io` **fails to link**
(`libclang_rt.wasi_threaded_io.a: No such file or directory`) rather than
being inert — a real, confirmed defect, not just the predicted risk. See
`documents/threaded-file-io-rpc-plan.md`'s "Follow-up: verify the
single-threaded build is unaffected" section for full detail, including
a second bug found and fixed along the way: `compiler-rt/lib/wasi_threaded_io/CMakeLists.txt`
was unconditionally requesting `ARCHS wasm32`, which hard-failed LLVM's
NATIVE cross-compile-host sub-build (used for host-native tblgen tools)
the moment it was freshly configured — fixed by skipping the component
when `LLVM_TARGET_IS_CROSSCOMPILE_HOST`. That bug had also gone
undetected in `build.bat`'s own prior "from-scratch" verification, whose
`build/NATIVE` cache was never actually reconfigured after
`wasi_threaded_io` was added.

### Done: fix `-mwasi-threaded-io`'s link failure on non-atomics targets

Fixed by checking whether the resolved `clang_rt.wasi_threaded_io`
archive actually exists before appending it to the link
(`wasm::Linker::ConstructJob` in `clang/lib/Driver/ToolChains/WebAssembly.cpp`),
rather than gating on target/flag heuristics (confirmed those can't
predict archive validity — see the plan doc). Emits a new, detailed
diagnostic (`err_drv_wasi_threaded_io_unavailable`) explaining why and
suggesting `-mno-wasi-threaded-io` when it's missing, instead of letting
`wasm-ld`'s cryptic "no such file" error surface. Verified against the
real single-threaded binary. See
`documents/threaded-file-io-rpc-plan.md`'s "Correction found while
starting this follow-up" section for full detail.

### Resolved (2026-09-06): linking the shim into clang.wasm/lld.wasm itself is not needed

Closed by reading the actual code, not just re-running the trivial
"Hello World" case: the earlier finding (`ai-notes/wip.md`) that a tiny
one-file compile never triggers `thread-spawn` at all left open whether a
*large* real-world compile/link would exercise real in-module threading
in a way that hits the same shared-fd-across-threads bug the RPC shim
fixes. It wouldn't, structurally, regardless of size:

- `lld/wasm/Writer.cpp`'s two `parallelFor`/`parallelForEach` call sites
  (`writeSections`, `computeHash`) are the only real in-module
  multithreading `lld.wasm` does for a normal link, and both write into
  an in-memory buffer via `memcpy` (`buffer->getBufferStart()`) — never a
  raw file descriptor.
- That buffer comes from `llvm::FileOutputBuffer` (`llvm/lib/Support/FileOutputBuffer.cpp`).
  Neither of its two backing implementations does file I/O from worker
  threads: `OnDiskBuffer` (mmap path) has workers write into a
  `mapped_file_region` and only calls `unmap()`/`Temp.keep()` in
  `commit()`; `InMemoryBuffer` (the WASI-relevant fallback, since mmap
  isn't available) has workers write into an anonymous
  `Memory::allocateMappedMemory` block and only opens the real output fd
  and does the single `raw_fd_ostream` write in `commit()`. Both `commit()`
  calls happen strictly after `parallelForEach`/`parallelFor` return
  (those calls block until all workers join), i.e. only on the original
  calling thread — never concurrently, never from a spawned worker.
- `clang.wasm`'s own compile path (`cc1`) runs as a fully separate spawned
  instance per the existing `CLANG_SPAWN_CC1`/spawn-hook design (its own
  linear memory, its own fd table) — not in-module threading at all — and
  a normal `-c` single-TU compile doesn't invoke `ThreadPoolStrategy`
  regardless of file size (no ThinLTO/parallel-PCH path in this project's
  use case).

So no worker thread inside `clang.wasm`/`lld.wasm`'s own execution ever
touches a file descriptor, at any input size — the exact precondition the
RPC shim exists to fix. Not worth wiring `wasi_threaded_io` into either
binary's own build; closing this as a non-issue rather than leaving it
open.

### Resolved (2026-09-06): LTO / ThinLTO backend threads don't hit the shared-fd bug either

Followed up on the assumption in the item above by reading
`lld/wasm/LTO.cpp`'s `BitcodeCompiler::compile()` and the LLVM LTO
backend it drives. Two cases, both safe:
- **No `--thinlto-cache-dir`** (the common case): each parallel ThinLTO
  backend task (`createInProcessThinBackend`, real worker threads via
  `heavyweight_hardware_concurrency` on this project's threaded build)
  writes into its own per-task in-memory buffer
  (`buf[task].second`/`raw_svector_ostream`) — never a file descriptor at
  all, same as the self-linking case above.
- **With `--thinlto-cache-dir`** (real fd I/O, via `llvm::localCache` in
  `llvm/lib/Support/Caching.cpp`): each task's cache lookup, temp-file
  write, and commit-time rename (`llvm/lib/LTO/LTOBackend.cpp`'s
  `codegen()` → `AddStream()` → `Stream->commit()`) all happen within
  that one task's own call stack, i.e. on the single worker thread
  running that task, start to finish — the fd it opens is never touched
  by any other thread. That's exactly the "independent per-thread
  `open()` calls to the same/different path" pattern
  `documents/threaded-file-io-rpc-plan.md` already proved safe (its
  "Main-thread-opens, workers-read/write is not a special case" section,
  smoketest Case B) — the shared-fd bug only bites when one thread opens
  an fd and a *different* thread later reuses that same fd number, which
  never happens here.

Confirms the original "presumably fine" assumption; downgrading from
assumption to verified. No action needed — `wasi_threaded_io` doesn't
need to cover this path either.

## The real browser-based JS host (separate project, not started)

Everything under `ai-notes/*.mjs` is a Node reference implementation
proving the contract works — real compile, link, run, threading — not the
real target. A real implementation, likely in its own separate repo (not
a branch here), needs:
- A real browser `Worker` instead of Node's `worker_threads`.
- Handling a `Worker` that gets forcibly *terminated* — no in-wasm
  backtrace is possible on termination, so the hosting JS has to
  reconstruct/report failure itself.
- The hosting JS (not the terminated Worker) invoking cleanup
  (`RunInterruptHandlers()`/`CleanupOnSignal()`) when it terminates a
  Worker, since the wasm instance can't run any code once terminated.
- Verifying `wasm-wasi-core` (VS Code for Web's WASI host) doesn't share
  `node:wasi`'s limitation of hard-requiring an *exported* memory — a
  wasi-threads module by construction can only have an *imported* one.
  `documents/vscode-wasi-host.md` documents the confirmed API surface
  (`createProcess` does accept a `WebAssembly.Memory`/`MemoryDescriptor`),
  but this hasn't been exercised end-to-end against the real VS Code for
  Web host yet, only against Node.
- This is where a real debugger implementation would also need to live;
  `documents/vscode-wasi-host.md` was written with that in mind but no
  debugger work has started.

### Scoping note (2026-09-06): what `lldb.wasm` debugging the compiled output would actually take

Read `lldb/source/Plugins/Process/wasm/` and
`lldb/docs/resources/lldbgdbremote.md` directly rather than assuming from
the earlier "no debugging story" framing. Good news first: **LLDB
upstream already has a complete wasm debugging *client*** —
`ObjectFile/wasm` (parses `.wasm` binaries), a DWARF `SymbolFile` variant
that understands wasm's tagged 64-bit address space (instance id +
offset), and `Process/wasm` (a `ProcessGDBRemote` subclass speaking
documented wasm-specific GDB-remote packets — `qWasmCallStack`,
`qWasmLocal`, `qWasmGlobal`, `qWasmStackValue`). The protocol doc states
it's "supported by the WAMR and V8 Wasm runtimes" — **V8 already
implements the server/stub side**, almost certainly the same machinery
behind Chrome's real "C/C++ DevTools Support (DWARF)" extension (which is
known to run an Emscripten-built LLDB talking to V8 this exact way). So
this isn't a from-scratch protocol design problem; it has a working
precedent.

Three genuinely separate pieces of work, very different risk profiles:
1. **Build `lldb.wasm` itself for `wasm32-unknown-wasip1[-threads]`.**
   **Done (2026-09-06), Stage A (offline lldb, no Process/GDB-remote
   plugins):** built a real `bin/lldb.wasm` from `build-lldb.bat` (a new
   build directory, not `build.bat`/`build-single-threaded.bat`'s —
   deliberately separate so a broken NATIVE cross-build here can't poison
   those). Config: `LLDB_ENABLE_PYTHON/LUA/SWIG/LIBEDIT/CURSES/LZMA/
   LIBXML2/TREESITTER/PROTOCOL_SERVERS=OFF`, `LLVM_ENABLE_PROJECTS=
   "clang;lld;lldb"`, everything else inherited from `build.bat`'s
   toolchain block. Confirmed working end-to-end against the Node
   reference host (`ai-notes/run_clang_smoketest.mjs build-lldb/bin/
   lldb.wasm --version` actually prints `lldb version 24.0.0git ...`).
   liblldb now builds STATIC (CMake's own SHARED-not-supported check
   fails outright on `Generic`/wasm32, same fix shape as libclang's
   existing `LIBCLANG_BUILD_STATIC`). WASI has essentially none of the
   POSIX surface LLDB's Host layer assumes — no sockets API at all (not
   even declared: socket/connect/bind/listen/setsockopt/getsockname/
   getpeername/getaddrinfo, `sockaddr_un.sun_path`), no PTYs
   (posix_openpt/ptsname), no real signal delivery (`sigaction`), no
   fork/exec/ptrace/waitpid, no user/group database (grp.h/pwd.h), no
   dladdr/kill/tzset/termios. All guarded out with loud "not supported"
   errors (never silent no-ops) following this fork's existing
   `raw_socket_stream.cpp` WASI precedent; see the git log on `lldb/`
   from 2026-09-06 for the full file list. Two real per-OS gaps needed
   new fallback implementations rather than just guards, since WASI has
   no per-OS `Host.cpp`/`HostInfo*.cpp` of its own and falls through to
   a plain-POSIX case that was previously dead code: `HostInfoPosix::
   GetProgramFileSpec()` (no `/proc/self/exe` equivalent, returns empty)
   and `Host::FindProcessesImpl`/`GetProcessInfo`/`ShellExpandArguments`
   (no process enumeration or shell on this target).
   **Resolved (2026-09-06): the exit-time `std::terminate` crash.** Root
   cause found by instrumenting `Driver.cpp`/`MainLoopPosix::Interrupt`
   with temporary debug prints (removed again after) and confirmed with
   a standalone `pipe()`/`fcntl()`/`write()` repro compiled and run
   through `ai-notes/run_clang_link_smoketest.mjs`'s pipeline: **`pipe()`
   itself fails outright** (`errno=Not supported`) in this Node/
   wasi-threads environment, and a `write()` to the resulting invalid fd
   fails too. `MainLoopPosix`'s interrupt-pipe mechanism (used to wake a
   `MainLoop` blocked in `ppoll` on another thread so it can shut down)
   depends on a working `pipe()`; its own constructor only `assert()`s
   success, which compiles out in this `MinSizeRel` build, so the
   failure was silent until `Driver.cpp`'s shutdown path tried to use it.
   `Driver.cpp` always spawned a background `signal_thread` hosting a
   `MainLoop` whose only purpose was three signal handlers that already
   always fail to register on WASI (`MainLoopPosix::RegisterSignal`, see
   above) — with no working interrupt pipe, `AddPendingCallback` (used to
   ask that thread to terminate) returned false, so `.join()` was never
   called, so the still-joinable `std::thread` destructor called
   `std::terminate()` at exit. Fixed by not creating `signal_loop`/
   `signal_thread` at all on WASI, rather than trying to fix `pipe()`
   itself (out of scope, and `signal_thread` had nothing left to do on
   this target anyway once `RegisterSignal` always fails). Verified:
   `--version`, `--help`, and an unknown-flag error all now exit cleanly
   under `ai-notes/run_clang_smoketest.mjs`. `pipe()` failing at all on
   this environment may be worth its own investigation later if anything
   else in this project ever needs it (nothing does today).
   Binary size is also a real concern:
   `lldb.wasm` is **~96 MiB** (vs. `clang.wasm`'s own already-large
   ~109 MiB), all statically linked; worth revisiting before assuming
   this is shippable to a browser as-is.
   **Not yet attempted:** Stage B (linking `Process/gdb-remote` +
   `Process/wasm` back in) — deliberately deferred until item 2 below
   has an actual transport, since those plugins pull in the WASI-hostile
   `Host/common/Socket.cpp`/`ConnectionFileDescriptor` surface for no
   benefit until then.
2. **A new transport for the GDB-remote connection.** LLDB's GDB-remote
   client normally reaches its target over a TCP socket or pipe
   (`ConnectionFileDescriptor`) — WASI has no BSD sockets at all (already
   a hard stub in this fork, see `llvm/lib/Support/raw_socket_stream.cpp`
   in `documents/design.md`). See item 3 below — this is now moot for the
   "debug the browser's own live V8" design, since there is no live V8
   GDB-remote endpoint to transport bytes *to*. Kept as a record of the
   original plan.
3. **Resolved (2026-09-07), and it's a "no": reaching a live wasm-gdb-remote
   stub from inside a browser tab is not possible via any documented
   browser API — for either Chrome/V8 or Safari/WebKit.** Corrects the
   2026-09-06 note above (in `documents/vscode-wasi-host.md` too), which
   had this backwards: read directly rather than assumed from reputation.
   - **Chrome does *not* use GDB-remote to talk to V8 at all.** Read
     Jonas Devlieghere's account of how the official "C/C++ DevTools
     Support (DWARF)" extension actually works: it uses the **Chrome
     DevTools Protocol (CDP)** for all runtime control (breakpoints,
     stepping, stack/variable inspection) and only uses LLDB-derived code
     as an **offline DWARF-parsing library** — loading the `.wasm`
     module's debug info into a dummy process purely to decode types and
     pretty-print values, never as a live GDB-remote client attached to
     V8. **V8 does not expose a GDB-remote stub to the browser at all.**
     The earlier note's "V8 already implements the server/stub side...
     the same machinery behind Chrome's...extension" claim was simply
     wrong — it conflated the *documented protocol* (which does list V8
     as an implementer, in some embedding) with what Chrome's own
     browser-integrated tooling actually uses, which is CDP, a completely
     different protocol.
   - **LLDB's own upstream browser-debugging path targets Safari/WebKit,
     not Chrome/V8, and it's local-native, not reachable from web
     content either.** This fork's own `822f549e9` base of upstream
     `main` already contains `lldb/source/Plugins/Platform/WebAssembly/
     PlatformWebInspectorWasm.{h,cpp}` — read directly rather than
     searched for, since it's sitting in this checkout. Its
     `LaunchPlatformServer()` hard-codes
     `kServerBinary = "/System/Cryptexes/App/usr/libexec/
     webinspector-wasm-lldb-platform"` (a macOS-only system binary living
     under the OS's cryptex mount, i.e. shipped as part of the OS itself,
     not installable elsewhere) and launches it as a **local subprocess**
     that presumably bridges WebKit's Web Inspector protocol to a GDB-remote
     TCP server on `localhost`, which `PlatformWasm::ConnectRemote` then
     connects to like any other `gdb-server` platform. This is Safari-only,
     requires a real native process launch (`Host::LaunchProcess`) and a
     specific macOS system component — categorically unreachable from
     inside a browser tab or a VS Code for Web extension (which has no
     ability to launch native OS processes at all, by design).
   - **CDP itself is not reachable from web-hosted code either.** CDP is
     exposed only two ways: (a) an external process connecting to a
     browser launched with `--remote-debugging-port`, or (b) a real,
     user-installed **browser extension** (a Chromium extension with a
     `manifest.json`, not a VS Code extension) declaring the `"debugger"`
     permission, which unlocks the `chrome.debugger` API — and even then,
     only a subset of CDP domains. Neither path is available to code
     running inside a VS Code for Web extension host: it is sandboxed JS
     loaded by the vscode.dev web app, with zero `chrome.*` API surface —
     a completely different, far less privileged extensibility model than
     an installed Chromium browser extension. There is no other
     documented bridge from ordinary page/worker JS to the browser's own
     CDP endpoint for its own tab.
   - **Conclusion:** items 1 and 2 above, as originally scoped (build
     `lldb.wasm`'s GDB-remote client + a transport to reach the browser's
     *live* wasm execution state), are blocked by browser security design,
     not by missing engineering effort — there is no live debugging target
     to transport bytes to from inside this project's actual deployment
     context (a VS Code for Web extension). This doesn't have an
     engineering fix; it needs a different design.

## What real wasm debugging in this project would actually require

Given the above, a debugger here cannot lean on the browser's own wasm
execution being introspectable from the outside — nothing running as a VS
Code for Web extension can reach that. The self-contained alternative,
consistent with this project's whole approach (no native tooling, no
privileged browser APIs, everything runs as ordinary page/worker JS): treat
debugging as a **compile-time instrumentation** problem instead of a
**runtime-introspection** problem.

### Why this is the *only* approach that fits, not just *a* workaround (2026-09-07)

Worth stating precisely, because it isn't obvious in advance whether "no
CDP access" rules out real VS Code-integrated debugging (breakpoints in the
editor gutter, the Debug sidebar) or only rules out *one way* of getting it.
It only rules out one way. The **Debug Adapter Protocol (DAP)** — the thing
VS Code's own debugging UI actually talks to — is deliberately
backend-agnostic: it standardizes only the conversation between VS Code and
"the debug adapter," never how the adapter actually controls whatever it's
debugging. A debug adapter can run as a `DebugAdapterInlineImplementation` —
a plain JS/TypeScript object living inside the extension host itself, no
separate process at all, which is the only shape a web extension can use
anyway (no `child_process`). This is exactly how every other non-JavaScript
debugger already working in VS Code for Web operates: they're not reaching
into the browser's own execution engine at all, they're driving an
interpreter *their own extension code already hosts* (e.g. Pyodide's CPython
loop via its own trace hooks) and translating that interpreter's native
stop/step/inspect hooks into DAP messages. Zero CDP, zero browser privilege,
because control of execution never has to leave JS in the first place.

`clang.wasm`/`lld.wasm` compiling to *native* wasm and handing it to the
browser's own execution engine (V8's real JIT) to run directly forecloses
that pattern — once V8 owns execution, this project's own JS host code no
longer controls it step-by-step, which is exactly the gap the sections above
found no browser API to bridge. The fix isn't a special trick for wasm; it's
applying the *same* pattern every other VS Code Web debugger already relies
on: keep control in JS by making the compiled program call back into it
constantly, rather than letting the browser's engine run it uninterrupted.

**A full wasm interpreter is the wrong way to do that, though** — not
because a real spec-compliant interpreter is infeasible (wasm3 does one in a
few thousand lines; roughly 450-500 core opcodes isn't actually the hard
part), but because of everything *around* correctly interpreting it —
precise overflow/NaN semantics, bounds-checked memory, tables/reference
types, the exception-handling proposal, atomics (which this project's own
threaded build needs) — plus a real, measurable speed loss against V8's own
JIT, which matters here specifically since `clang.wasm`/`lld.wasm`'s own
execution speed is part of this project's usability. Silly and infeasible
for what it'd buy.

### Confirmed (2026-09-07): the actual mechanism is two existing, free Clang codegen flags — verified against `wasm32-unknown-wasi`, not just assumed

The lighter-weight alternative — compile the target program with hooks
built directly into the generated code, so it keeps running at native wasm
speed but calls back into host JS at controlled points — turns out not to
need any new compiler engineering at all. Tested directly (native host
clang, `-target wasm32-unknown-wasi -S -emit-llvm`, no changes to this
fork), both already-existing flags emit exactly the expected calls, with
correctly-sized wasm32 pointer arguments, no compiler-rt runtime link
required for either (the callback bodies are meant to be user-supplied):

```
call void @__sanitizer_cov_trace_pc_guard(ptr inttoptr (... @__sancov_gen_ ...))
call void @__cyg_profile_func_enter(ptr @add, ptr %6)
call void @__cyg_profile_func_exit(ptr @add, ptr %11)
```

- **`-finstrument-functions`** — a call to `__cyg_profile_func_enter(fn,
  call_site)` / `__cyg_profile_func_exit(...)` at every function's entry and
  exit. Free call-stack tracking, no design work needed.
- **`-fsanitize-coverage=trace-pc-guard`** — a call to
  `__sanitizer_cov_trace_pc_guard(&guard)` on every control-flow
  edge/basic block. In an unoptimized (`-O0`) build — the natural choice for
  a "Debug" build anyway — that lands a hook at roughly every statement,
  which is the granularity real line-by-line stepping needs. Both are pure
  LLVM IR-level passes, target-independent, with no shadow-memory or OS
  dependency blocking wasm32 the way full ASan is blocked (see the deferred
  sanitizers note elsewhere in this file) — confirmed empirically rather
  than inferred from that distinction.

This changes the shape of the remaining work from "design an instrumentation
scheme from scratch" to "wire together pieces that already exist":
1. **Hooks** — the two flags above, or a small custom LLVM pass emitting one
   hook per DWARF line-table row instead of per-edge if `trace-pc-guard`'s
   granularity turns out too coarse or too fine for clean line-stepping.
   Genuinely the one open design choice left.
2. **Pause/resume** — a hook calls a host-imported function; JS blocks that
   worker via `Atomics.wait` on a shared flag until told to step/continue —
   this project's existing thread-coordination pattern already, nothing new.
3. **Reading state** — locals/globals live in the shared `WebAssembly.Memory`,
   directly readable from JS as a plain typed array, no serialization
   boundary at all. `lldb.wasm`'s DWARF `ObjectFile`/`SymbolFile` (Stage A,
   already built and running — see above) does the "which address holds
   variable `x` at this line" resolution.
4. **DAP wiring** — a plain `DebugAdapterInlineImplementation`, per the
   backend-agnostic point above.

Scoping note: this should be opt-in (a distinct "Debug" build, separate from
a plain "Run" build) the same way native toolchains already separate
`-O0 -g` debug builds from optimized release ones — `trace-pc-guard` adds
real per-edge overhead not worth paying on an ordinary run. And this should
almost certainly be scoped to *the user's compiled program only*, not
`clang.wasm`/`lld.wasm` themselves — instrumenting our own already-large
compiler binaries would add real size/perf cost for no product benefit.

Still a real, unscoped design task, not a small follow-up — open questions:
exact hook granularity (above), how much overhead instrumentation adds in
practice, and how far short of real LLDB-quality debugging (watchpoints,
multi-thread awareness, expression evaluation touching live memory) a
JS-callback-based scheme can practically get. But it is now a *de-risked*
design task — the load-bearing compiler mechanism is confirmed real and
free, not speculative — worth its own dedicated session when the project is
ready to pick this up, not a natural continuation of the Stage A
build-porting work already done.

### What this means for `lldb.wasm` itself: still needed, but as a symbol/value *library*, not a live debugger

This design replaces LLDB's `Process`/GDB-remote layer entirely — the part
that assumes a live, controllable inferior reachable over some wire protocol
— which is exactly Stage B (never built, and now moot regardless: nothing
reachable from a browser can speak to a live debug target that way, per the
V8/CDP research above). So `Process/gdb-remote`, `Process/wasm`'s GDB-remote
client: not needed for this design, at all.

What's still genuinely hard and worth keeping LLDB for is DWARF *decoding*,
not process *control* — two jobs that are still substantial to reimplement
from scratch:
- **Symbol resolution**: "hook fired at wasm PC X" → "`foo.c` line 42" and
  "local `x` lives at address A, as DWARF type T." This is `ObjectFile/wasm`
  + the DWARF `SymbolFile` — Stage A, already built and running today.
- **Value formatting / expression evaluation**: turning a raw address + a
  DWARF type into a real pretty-printed value (`std::vector<int>` with 3
  elements: `{1, 2, 3}`, not just a hex dump), and evaluating a typed
  expression in a Debug Console (`x->y.z`). That's `TypeSystemClang`/
  `ValueObject`, and LLDB's full Clang-based JIT expression parser if
  expression evaluation is wanted. This is genuinely LLDB's core value
  proposition, separate from controlling a live process — not something
  worth reimplementing from scratch.

So the shape is: a custom JS debug adapter drives pause/resume/memory-reads
itself against the instrumentation scheme, and calls into some *slice* of
`lldb.wasm` purely as a symbol/type/value-decoding library — not through
`Process`/`Target`'s live-process orchestration, and not through the
`lldb`/`lldb-dap` CLI tools as built (their whole command-interpreter/REPL
layer is dead weight for a library consumer that's never taking human
command-line input).

**Concrete, unmeasured follow-up this surfaces:** if `Process`, `Target`'s
live-process machinery, and most of the command-interpreter/REPL layer
really aren't needed, the ~96 MiB Stage-A `lldb.wasm` build might be
shippable as something much smaller — linking only `lldbSymbol`/`lldbCore`/
the DWARF `SymbolFile`/`ObjectFile/wasm` (plus `ExpressionParser` if
expression evaluation is wanted) instead of the full driver. Not attempted
or measured; a real, concrete question for whoever picks up the debugging
design, alongside the hook-granularity question above.

### Researched (2026-09-07): running the inferior in a separate browser tab — real sandboxing win, and a genuine debugging shortcut, but doesn't change the CDP-reachability "no" above

Prompted by asking "what if the wasm ran outside the extension's own tab
entirely, in some separate, debuggable Chromium process?" Two questions
tangled together here — sandboxing and debuggability — and they turn out to
have different, both good, answers:

- **Sandboxing: yes, and it's an existing, supported mechanism, not new
  engineering.** A VS Code (for Web) extension can open a real, separate
  top-level browsing context via `vscode.env.openExternal(uri)` — in
  vscode.dev this always opens the URL in a genuinely new browser tab (the
  extension host itself runs in a Web Worker and has no `window.open()` of
  its own; `openExternal` is the supported bridge for this). A tab served
  from a different origin than vscode.dev lands in its own OS-level
  renderer process under Chrome's standard site-isolation architecture —
  a real security boundary for running arbitrary compiled/user code,
  achieved "for free" via an existing VS Code API rather than anything
  this project would have to build. (VS Code's own Webview iframes use the
  same separate-origin trick for the same reason, just as an iframe rather
  than a top-level tab — see `documents/vscode-wasi-host.md`.)
- **Debuggability: still no *programmatic* CDP access for the extension
  itself** — process/origin separation doesn't unlock `chrome.debugger` or
  any other CDP path; the "no" in the section above is unaffected by which
  tab or process the wasm actually executes in, since it was never about
  physical process placement, only about which browser privilege tier the
  code asking for access runs in — but there's a real, concrete practical
  win anyway: **Chrome DevTools has shipped built-in, no-extension-needed
  WebAssembly/DWARF C/C++ source debugging since Chrome 114 (May 2023)** —
  breakpoints, stepping, and locals with real source mapping, using the
  same `-g` DWARF output `clang.wasm` already produces for free today. If
  the compiled program runs in its own real tab (rather than inline in the
  extension host or a hard-to-target nested iframe), a user can just open
  Chrome's own DevTools on that tab (`F12`, same as any other page) and get
  genuine interactive C/C++ debugging immediately — zero GDB-remote
  transport, zero `lldb.wasm`-to-browser bridge, none of the engineering
  scoped above. The tradeoff: that's Chrome's own DevTools UI, not
  integrated into VS Code's editor gutter/Debug sidebar — getting *that*
  experience would still need the compile-time-instrumentation design
  above (or an entirely separate DAP-over-something bridge), regardless of
  which tab/process the code runs in.
- **Two real open questions before this is buildable, not just
  researched-in-principle:**
  1. **Cross-context communication.** `openExternal` returns only a
     success/failure boolean, not a `Window` handle — the extension can't
     `postMessage` into the new tab directly the way `window.open()`'s
     return value would allow. Options not yet investigated: have the
     runner tab be fully self-sufficient (it re-runs the compile itself
     rather than receiving already-compiled bytes from the extension,
     sidestepping the handoff problem for that step at least); some
     shared-storage relay (`BroadcastChannel`/`SharedWorker` only work
     same-origin, not cross-origin); or accepting one-shot, URL-encoded
     hand-off (query string/fragment) for anything small enough, with no
     live channel back for things like stdin or workspace file access.
  2. **`SharedArrayBuffer`/cross-origin isolation for the runner tab.**
     This project's threaded build needs `SharedArrayBuffer`, which needs
     the *page itself* served with `Cross-Origin-Opener-Policy: same-origin`
     + `Cross-Origin-Embedder-Policy: require-corp` (or the newer
     `Origin-Isolation`/`Document-Isolation-Policy` alternative) — real HTTP
     response headers, not something a page can grant itself purely in JS.
     Achievable on most static hosts (a `coi-serviceworker`-style
     first-load shim is a documented workaround where the host can't set
     headers directly, e.g. GitHub Pages), but wherever the runner page
     ends up hosted, this needs to be arranged deliberately — not
     automatic. Note also that `COOP: same-origin` itself severs
     `window.opener` from any cross-origin page that opened it, which
     forecloses the most obvious accidental postMessage channel back to
     vscode.dev even if one were tempted to rely on it.
- **Net assessment:** worth doing regardless of the debugging question,
  for the sandboxing win alone (running arbitrary compiled user code
  outside the extension's own tab is good hygiene on its own merits) — and
  it turns "real interactive C/C++ debugging in the browser" into a
  near-term, low-effort deliverable (point Chrome DevTools at the tab) far
  sooner than the from-scratch instrumentation design above. Both remain
  real, unscoped follow-up work: the tab-launch/isolation piece is a
  `documents/js-host-contract.md`/host-design question (where does the
  runner page live, how is it served, how does it get COOP/COEP), not an
  LLVM source question at all — good candidate for its own session, and
  doesn't depend on any further `lldb.wasm` work to be worth starting.

## Upstream contribution (`upstream-fixes` branch)

- No PR has been opened yet — hold off until asked.
- **Before opening one**, diff against
  [llvm/llvm-project#92677](https://github.com/llvm/llvm-project/pull/92677)
  (open, unmerged, touching almost the same file list) and frame any PR as
  narrower in scope (this project never touches threading/`std::mutex`
  conditionalization, which is what stalled #92677 — see `ai-notes/wip.md`
  for the detailed history).
- Re-check whether any `upstream-fixes` commit gets superseded by upstream
  `main` moving on its own, the same way the original `__WASM__`/`__wasm__`
  typo fix did, on every future rebase.

## Housekeeping / known fragile spots

- Done: `build.bat` no longer hardcodes `lib/clang/24/...` for the
  second, non-threaded compiler-rt build's output path — it now resolves
  the version number from the actual build output (same approach as the
  JS smoke tests' `findResourceDir()`), so it won't silently break on the
  next LLVM major-version bump.
- Done (2026-09-06): re-verified the `upstream-fixes` cherry-pick
  sequence against a fresh shallow-fetch of upstream `main`
  (`5735d1730`, well past the `822f549e9` base used at the last rebase).
  All 8 `upstream-fixes` commits cherry-picked cleanly onto it in a
  scratch branch (no conflicts, no empty/already-upstreamed patches);
  scratch branch discarded afterward, no real branch touched. Only
  `upstream-fixes`'s commits were re-tested here (the ones patching real
  LLVM/clang source, so the only ones actually at conflict risk) — the
  much larger `wasm-wasi`-only commit set has grown well past the
  original 18-commit rebase and is mostly docs/build-script/new-file
  commits that cherry-pick trivially on top; re-verify it too at the
  point an actual rebase is being done, not preemptively.

### Resolved (2026-09-06): module cache / PCH file locking under concurrent instances is a mainline behavior, not our bug

Investigated by reading the full `LockFileManager.cpp` flow plus its only
caller, `compileModuleBehindLockOrRead()` in
`clang/lib/Frontend/CompilerInstance.cpp`. The WASI patch
(`processStillExecuting()` always returns "lock still held") only removes
*early* dead-owner detection (`OwnerDied` is unreachable on this target);
every contended lock instead always falls through to the existing,
finite `ImplicitModulesLockTimeoutSeconds` timeout before giving up and
rebuilding redundantly — a real but minor latency cost on a
crashed/killed Worker, not a correctness one. The force-unlock-and-
rebuild-on-timeout behavior that follows is unmodified upstream Clang
(verified: `git log`/`git blame` show zero commits from this fork
touching that function; it's attributed to upstream commit `822f549e9`,
predating this fork), and its safety rests on `compileModuleImpl()`'s
output always going through a temp-file-then-atomic-rename
(`createOutputFileImpl(..., UseTemporary=true)`), so even two instances
redundantly rebuilding the same module concurrently can't produce a torn
file. Since the risk is upstream's, not this fork's, no action needed
here beyond this record.

## Worth investigating (not yet a confirmed bug)

## Explicitly deferred, not forgotten

- **Sanitizers** (`-fsanitize=address/undefined/thread`, etc.): not
  prioritized (user confirmed 2026-09-06 — was investigating this under a
  mistaken impression it was wanted; static analysis, not sanitizers, is
  the actual interest — see the `clangd`/static-analysis item below).
  Scoping findings kept in case this changes: `wasm32`/`WASI` are missing
  from compiler-rt's own arch/OS support lists
  (`compiler-rt/cmake/Modules/AllSupportedArchDefs.cmake`,
  `compiler-rt/cmake/config-ix.cmake`) for everything except `profile`
  (PGO), which upstream already supports on this target. Trap-only UBSan
  (`-fsanitize-trap=undefined`) needs no runtime and should already work.
  Full UBSan runtime looks like a plausible, bounded port (its source
  doesn't touch shadow memory, just ordinary OS glue). ASan/MSan/HWASan/
  TSan are a much bigger, likely-architecturally-blocked lift (shadow
  memory needs fixed-offset `mmap` reservations wasm32's flat linear
  memory has no equivalent for) — not worth pursuing without a specific
  need.
- **PGO** (`-fprofile-instr-generate`/`-fprofile-use`): profile counter
  writing at exit, and whether counter merging across `-pthread`
  output-program threads hits anything like the shared-fd issue
  `wasi_threaded_io` fixes. Not built or tested at all.
- **wasm dynamic linking of output programs** (`-shared`, the wasm
  "dylink" ABI, or `-fPIC` for wasm): this project builds everything
  static (`BUILD_SHARED_LIBS=OFF`); whether `wasm-ld` here can produce a
  dynamically-linked wasm output at all for *user* code is untested and
  orthogonal to `-ldl` (which only satisfies clang.wasm's own build-time
  symbol references — plugin loading is already off via
  `LLVM_ENABLE_PLUGINS=OFF`).
- **`clangd` / static analysis support** (the user's actual interest, not
  sanitizers — see above): scoped 2026-09-06 by reading
  `clang-tools-extra/clangd`'s actual source, not just guessing from its
  reputation as "harder." The earlier "persistent background indexing
  threads are a different shape of problem" framing turns out to be less
  scary than it sounds:
  - `TUScheduler`/`BackgroundIndex` use plain `std::thread` worker pools
    (`ThreadPool.runAsync(...)`, `index/Background.cpp`) — no different
    in kind from the real wasi-threads support this project already has
    working.
  - Background indexing's on-disk cache
    (`index/BackgroundIndexStorage.cpp`'s `storeShard`/`loadShard`) opens,
    writes, and closes each shard file within one function call on the
    worker thread that owns that task — the same "independent per-thread
    open()" pattern already proven safe elsewhere in this project (see
    the resolved ThinLTO item above), not the shared-fd pattern that
    needed `wasi_threaded_io`.
  - clangd doesn't spawn `cc1` as a subprocess to parse a TU the way the
    driver does — it calls into Clang's own libraries in-process
    (`ParsedAST`/`Sema` directly), so the existing `CLANG_SPAWN_CC1`
    multi-instance spawn-hook machinery mostly isn't even in the
    critical path here.
  - No native OS-level directory-watching dependency
    (`inotify`/`ReadDirectoryChangesW`/etc.) exists in clangd itself —
    workspace file-change notification is the LSP *client*'s job
    (`didChangeWatchedFiles`), which a browser host already does its own
    way. One less WASI gap to worry about.
  - `llvm::sys::SetInterruptFunction` (Ctrl-C handling,
    `tool/ClangdMain.cpp`) degrades the same way this fork already made
    all Unix signal registration degrade: a silent no-op, consistent with
    `documents/design.md`'s existing `Unix/Signals.inc` handling, not a
    new gap.
  - The one real optional-feature gap: `--query-driver` (asking a *real*
    system compiler for its default include paths, `CompileCommands.cpp`)
    spawns a subprocess via `llvm::sys::ExecuteAndWait` — works only if a
    JS host installs the spawn hook, same as any other subprocess spawn
    in this project; harmless to leave unsupported since this project
    only ever has one compiler (itself).
  - **Actual remaining work, roughly in order:** (1) enable
    `clang-tools-extra` in `LLVM_ENABLE_PROJECTS` and see what fails to
    configure/compile for `wasm32-unknown-wasip1[-threads]` — untried,
    likely surfaces its own set of small WASI gaps the way clang/lld did;
    (2) binary size is a real open question — clangd statically linking
    every clang-tidy check (`CLANGD_TIDY_CHECKS=ON` by default) onto an
    already-large `clang.wasm` could be a lot to ship to a browser;
    start with `-DCLANGD_TIDY_CHECKS=OFF` and grow from there if size
    allows; (3) design how the JS host talks to it — clangd's LSP
    transport is JSON-RPC over stdin/stdout, which needs the same kind of
    host-side plumbing `documents/js-host-contract.md` already specifies
    for a normal compile, but as a long-lived bidirectional stream rather
    than a one-shot invocation — worth its own addition to that doc once
    started. Not yet attempted; a real next investigation/build pass, not
    just documentation.
- Subprocess I/O redirection, timeouts, polling, and detached-process
  support in `Unix/Program.inc` — currently fail loudly rather than
  silently no-op'ing. Nothing in a normal compile/link needs these yet;
  extend the wire format + spawn shim only if a real use case appears.
- `CrashRecoveryContext::Enable()` and socket operations remain hard
  stubs — deliberate, not a gap: `CLANG_SPAWN_CC1=ON` means
  `CrashRecoveryContext::Enable()` is dead code in this configuration, and
  sockets were never expected to work in a browser-hosted compiler.
- Real in-module threading's actual performance payoff at realistic
  project sizes hasn't been measured beyond confirming it's a no-op for
  trivial one-file workloads (below `ThreadPoolStrategy`'s worker-count
  threshold). Worth revisiting with a genuinely large compile/link before
  assuming this milestone delivers a measurable speedup in practice, versus
  "compiles and links correctly with threading enabled, mostly unexercised
  so far except by lld's parallel section-writing path."
