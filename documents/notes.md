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

## Debugging design research trail (2026-09-06 to 2026-09-07)

How the compile-time-instrumentation + `lldb.wasm`-as-library debugging
design (see `documents/design.md`) was arrived at -- kept here since the
dead ends ruled out along the way are worth remembering, even though
`design.md` itself only states the conclusion.

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


## lldb-wasm-reactor implementation trail (2026-09-07 to 2026-09-09)

`ProcessWasmMemory`, `PlatformWasi`, and `lldb-wasm-reactor` (see
`documents/design.md`'s "Debugging design") were built and verified in this
stretch. Kept here as the detailed record of what was found/fixed along the
way; `documents/remaining_work.md` only tracks what's still open.

- **`ProcessWasmMemory`**: done as a first pass —
  `lldb/source/Plugins/Process/wasm-memory/` (`ProcessWasmMemory`,
  `ThreadWasmMemory`, `RegisterContextWasmMemory`), wired into
  `Process/CMakeLists.txt`. `DoReadMemory`/`DoWriteMemory` forward to
  installed `std::function` callbacks; a single `ThreadWasmMemory`/frame
  reports the PC and answers `eWasmTagLocal` Wasm-virtual-register reads
  (see `Utility/WasmVirtualRegisters.h`) from a small map the embedder sets
  via `SetStopState()` at each reported stop — covers real `-O0 -g`
  codegen's only actual use of `DW_OP_WASM_location`
  (`DW_AT_frame_base`; see `documents/design.md`). Everything else
  (`Global`/`OperandStack` tags, all real control — launch/attach/
  resume/step) stays a loud "not supported" stub via `Process`'s own
  defaults. **Done (2026-09-07): builds clean.** An incremental
  `ninja -C build-lldb lldb` picked up the new plugin automatically
  (`add_lldb_library(... PLUGIN ...)` self-registers it into
  `${LLDB_ALL_PLUGINS}`) and linked a working `bin/lldb.wasm` with no
  further changes needed. **Not yet exercised against a real target** —
  nothing has called `ProcessWasmMemory::Initialize()` or attached it to
  an actual `Target` yet; that needs the wrapper API below to have
  something to call it from.
- **Wrapper API and reactor-module build**: done as a first pass —
  `lldb/tools/lldb-wasm-reactor/WasmDebugReactor.cpp`, a new
  `add_lldb_tool_subdirectory` under `lldb/tools/`, built with
  `-mexec-model=reactor` (no `main` required) when the host triple starts
  with `wasm32-`. Four exported functions (`wasm_dbg_init`,
  `wasm_dbg_create_target`, `wasm_dbg_set_stop`, `wasm_dbg_resolve_pc`,
  `wasm_dbg_format_value`), two imported ones (`read_memory`/
  `write_memory`, under module name `wasm_dbg`) for the JS host to supply.
  Uses `SBDebugger::Initialize()` (so `SystemInitializerFull` still runs --
  simpler than a from-scratch minimal initializer, and the user confirmed
  binary size is a deferred concern, not a blocker) plus the internal
  `Debugger`/`TargetList`/`Target` API directly for target/process
  creation, since `SBTarget`'s constructor-from-`TargetSP` is `protected`
  and there is no public SB entry point for "attach this specific,
  already-registered `Process` plugin, no launch." Value formatting goes
  through `StackFrame::GetValueForVariableExpressionPath` (handles
  `x`/`x->y.z`/`arr[3]`, not arbitrary expressions -- no Clang JIT
  expression parser wired in yet) and `ValueObject::Dump` (real
  `DataFormatters` pretty-printing). **Done (2026-09-07): builds clean.**
  `ninja -C build-lldb lldb-wasm-reactor` (after two small fixes found by
  actually building it: `-mexec-model=reactor` is link-only, not a compile
  flag; `Plugins/Process/wasm-memory/...` needs `lldb/source` on the
  include path, same as `lldb-server`'s own `Plugins/Process/*` includes)
  produced a real `bin/lldb-wasm-reactor.wasm` — confirmed with
  `llvm-nm`/`llvm-objdump`: `_initialize` exported (the reactor-model entry
  point, not `_start`), all five `wasm_dbg_*` functions exported, both
  `wasm_dbg_host_read_memory`/`write_memory` present as unresolved imports
  for a JS host to supply, and `lldb_initialize_ProcessWasmMemory` present
  in the plugin-init list.
  **Update (2026-09-07): exercised end-to-end against a real compiled
  program** via a new smoketest, `ai-notes/run_lldb_wasm_reactor_smoketest.mjs`
  (Node, following this project's usual `ai-notes/*.mjs` pattern; the
  target program is compiled fresh each run by the host's own wasi-sdk
  clang, not clang.wasm, since the point is exercising the reactor, not
  this project's own compiler). Found and fixed two real bugs along the
  way, neither previously visible because Stage A's smoke tests never
  exercised `TargetList::CreateTarget` (only `--version`/`--help`):
  - **No `Platform` ever became the WASI host platform**, so
    `Platform::GetHostPlatform()` returned null and
    `TargetList::CreateTargetInternal`'s `platform_sp->IsHost()` crashed on
    a null vtable (`Debugger`'s constructor only `assert()`s this is
    non-null, which compiles out in this `-DNDEBUG` build). Every existing
    per-OS `Platform` plugin's host self-registration is gated on
    `#if defined(__linux__)`/`_WIN32`/etc., none of which is ever defined
    compiling *for* WASI. Fixed with a new, deliberately minimal
    `PlatformWasi` (`lldb/source/Plugins/Platform/WASI/`, modeled on
    `PlatformFreeBSD`'s shape) that self-registers as host under
    `#if defined(__wasi__)` — not to be confused with
    `Plugins/Platform/WebAssembly`'s `PlatformWasm`, which represents a
    wasm program as a debug *target*, an unrelated concept.
  - **Confirmed with the fix above, then found, root-caused, and fixed two
    more issues — both in this project's own `ai-notes/wasi_thread_hook.mjs`
    test harness, not in LLDB, LLVM, wasi-threads, or the reactor-module
    entry point itself (see `documents/design.md`'s multithreading note).**
    `Target::SetExecutableModule` → `ModulesDidLoad` →
    `ModuleList::PreloadSymbols(/*parallelize=*/true)` (the default;
    `target.parallel-module-load` defaults on) constructs an
    `llvm::ThreadPoolTaskGroup(Debugger::GetThreadPool())`, spawning one
    real worker thread via `wasi.thread-spawn`. Diagnosing why
    `task_group.wait()` never returned took an extra step: `postMessage`
    from a spawned `worker_threads.Worker` back to its parent is delivered
    through the parent's own event loop, which never runs again once the
    parent is itself blocked synchronously inside `task_group.wait()`'s
    native call — so the worker's own diagnostic messages were invisible
    regardless of whether it succeeded or failed. Switching to a direct
    synchronous file write (a real syscall on the worker's own OS thread,
    independent of the parent's event loop) revealed both real causes,
    fixed in order:
    1. The spawned worker's own `WebAssembly.instantiate()` threw
       `TypeError: Import #1 "wasm_dbg": module is not an object or
       function`, caught and silently swallowed by
       `wasi_thread_worker.mjs`'s own `catch` block — it only ever
       forwarded the generic WASI/`env.memory`/`thread-spawn` imports into
       a spawned thread's own re-instantiation of the module, never an
       embedder-specific custom import module (`wasm_dbg`, holding
       `read_memory`/`write_memory` — see `lldb/tools/lldb-wasm-reactor`).
       Exactly the user's hypothesis (2026-09-09): "not starting, due to
       missing a JavaScript extension method." **Fixed**:
       `instantiateThreaded`/`makeThreadSpawn` now accept an
       `extraImportsModule` (a file URL) plus cloneable
       `extraImportsConfig`, threaded through `workerData` into the
       spawned worker, which dynamically `import()`s it and calls its
       `buildImports(config, { memory })` to *reconstruct* equivalent
       import functions from scratch — a JS function can't cross the
       `workerData` structured-clone boundary, so the worker can't just
       receive the same closures the main instance uses.
       `ai-notes/lldb_wasm_reactor_dbg_imports.mjs` is the smoketest's own
       (throwing-stub) instance of one. A generalizable extension, also a
       requirement on any *real* multithreaded host for this reactor, not
       just this test harness — worth a line in
       `documents/js-host-contract.md` once one exists.
    2. With that fixed, instantiation succeeded but `_initialize()`
       (called by `wasi.initialize()`) then trapped with `RuntimeError:
       unreachable`. Root cause: `_initialize` is a *reactor's* one-time,
       main-instance-only setup entry point (runs global ctors via
       `__wasm_call_ctors`); calling it again in a spawned thread's own
       fresh instance, sharing already-initialized linear memory with the
       main instance, hits wasi-libc's own double-init guard. A
       command-style module (`clang.wasm`/`lld.wasm`) has no `_initialize`
       export at all, so calling `wasi.initialize()` for *its* spawned
       threads was always harmless by accident (nothing to call), not by
       design — this had simply never been exercised with a reactor module
       before. **Fixed**: confirmed directly
       (`node -e "console.log(WASI.prototype.initialize.toString())"`)
       that `wasi.initialize()` is just `finalizeBindings()` (the actual
       memory-binding step node:wasi needs) plus that conditional
       `_initialize()` call; `wasi_thread_worker.mjs` now calls
       `wasi.finalizeBindings()` directly instead, skipping `_initialize`
       entirely for spawned threads.
    With both fixed, plus a `Target::ResolveFileAddress` fallback added to
    `wasm_dbg_resolve_pc` (nothing had loaded the module into the
    `SectionLoadHistory` `ResolveLoadAddress` needs, since `ProcessWasmMemory`
    is never actually launched/attached to in the usual sense — a wasm
    module's file and "loaded" addresses coincide anyway, so this is a
    correct, permanent fallback, not a workaround), **the smoketest passes
    end to end**: real multithreaded DWARF symbol preloading completes,
    `wasm_dbg_create_target` returns success, and
    `wasm_dbg_resolve_pc(add()'s address)` correctly returns `"add.c:1"`.
  Still not yet designed, independent of the above: surfacing real
  `Status` error text back through the plain `int32_t` return codes
  (today's codes carry no detail); whether `wasm_dbg_format_value` needs a
  real expression evaluator (arithmetic, casts, calls) badly enough to
  wire in `ExpressionParser/Clang` (not yet exercised by the smoketest,
  which only calls `wasm_dbg_resolve_pc` so far).
