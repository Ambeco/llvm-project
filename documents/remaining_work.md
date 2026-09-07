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
   in `documents/design.md`). `lldb.wasm` would need a new `Connection`
   backend that marshals GDB-remote protocol bytes through something a JS
   host provides — conceptually the same shape as the existing
   spawn-hook (a host-installed function-pointer-table slot) or the
   `wasi_threaded_io` RPC design, just carrying debug-protocol bytes
   instead of subprocess argv or file I/O. Not attempted; new
   infrastructure, not a CMake flag.
3. **Reaching V8's stub from inside a VS Code Web extension.** The one
   real open question, and the one that determines whether 1 and 2 are
   even worth doing: V8's wasm-gdb-remote-stub surface is normally only
   reachable via the Chrome DevTools Protocol from an attached devtools
   client, not from arbitrary extension-host code running in the same
   browser tab. Whether a VS Code Web extension can get at it at all
   (some CDP-adjacent API, or none) is unresearched — this is a
   `documents/vscode-wasi-host.md`/js-host-contract question, not an LLVM
   source question, and it's the piece most likely to actually block
   this, independent of how much LLDB porting effort goes in.

Rough shape, not a time estimate: (1) and (2) are real but bounded
engineering, similar in spirit to work already done elsewhere in this
fork; (3) is a feasibility question that should be answered *first*,
since a "no" there means 1 and 2 need a different design (e.g. a
from-scratch stub instead of leaning on V8's) rather than just more time.

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
