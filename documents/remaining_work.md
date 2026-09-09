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
- This is where a real debugger implementation would also need to live —
  see the debugging item below for its actual design.

### Wasm/browser debugging: design settled, implementation not started

See `documents/design.md` ("Debugging design") for the full architecture
(compile-time instrumentation for control flow, `lldb.wasm` used purely as
a symbol/type/value-decoding library via a new `ProcessWasmMemory` plugin)
and `documents/notes.md` for the research trail that ruled out live
GDB-remote/CDP approaches. Open implementation items:

- **`ProcessWasmMemory`/`PlatformWasi`/`lldb-wasm-reactor`: done, built,
  and verified end to end.** `Plugins/Process/wasm-memory/` (memory-only
  `Process`, answers the one Wasm virtual register `-O0 -g` codegen needs);
  `Plugins/Platform/WASI/` (a real gap this surfaced -- no `Platform`
  plugin was ever the WASI *host* platform; see `documents/notes.md`);
  `tools/lldb-wasm-reactor/WasmDebugReactor.cpp` (the exported
  `wasm_dbg_init`/`create_target`/`set_stop`/`resolve_pc`/`format_value`/
  `alloc`/`free`/`get_last_error` API, plus imported
  `read_memory`/`write_memory`). `ai-notes/run_lldb_wasm_reactor_smoketest.mjs`
  exercises all of it against a real wasi-sdk-compiled program: real
  multithreaded DWARF symbol preloading, target creation,
  `resolve_pc` → `"add.c:1"`, and `format_value("c")` → `"(int) c = 3"` via
  a synthetic (not actually executed) memory image and frame-base value.
  Found and fixed several real bugs along the way (a crash from the
  missing host platform; two real-multithreading-in-a-reactor-module bugs
  in the test harness, not LLDB/wasi-threads itself; `Target` never had
  its module's section load addresses set, so generic frame/variable
  resolution silently failed even though this wrapper's own
  `wasm_dbg_resolve_pc` worked around it locally) -- see
  `documents/notes.md` for the full trail.
  Still open:
  - `wasm_dbg_format_value` only handles `StackFrame::
    GetValueForVariableExpressionPath`'s subset (`x`/`x->y.z`/`arr[3]`) --
    whether a real Clang-JIT expression evaluator (arithmetic, casts,
    calls) is worth wiring in (`ExpressionParser/Clang`) is unmeasured
    against real usage. Decided (2026-09-09): skip -- real execution of
    JIT'd code needs a live inferior this design deliberately doesn't
    have, so it could only ever handle the constant-foldable subset
    anyway; not worth the complexity for what a variables/watch pane
    needs.
  - Only single-variable/DW_OP_fbreg-style locals have been exercised.
    `eWasmTagGlobal`/`eWasmTagOperandStack` (see
    `RegisterContextWasmMemory`) remain unimplemented stubs -- not known
    to be needed yet (see `documents/design.md`'s frame-base note on why
    `-O0` mostly avoids them), but unverified against a real optimized or
    unusual codegen shape. Deprioritized (2026-09-09): low user impact
    even if hit (one variable fails to display, not a crash).

- **Backtraces (multi-frame): the LLDB-side plumbing is implemented, but
  blocked from full verification by a newly found, separate, real bug in
  address/symbol resolution for the third-and-later function in a
  multi-function wasm module.** `-finstrument-functions` (the obvious
  choice) turned out to be a dead end on wasm32: Clang doesn't emit
  `__cyg_profile_func_enter/exit` itself, an LLVM pass
  (`EntryExitInstrumenter`) does, unconditionally using the
  `llvm.returnaddress` intrinsic for the call-site argument, and the
  WebAssembly backend has no lowering for it (`error: Non-Emscripten
  WebAssembly hasn't implemented __builtin_return_address`) -- fixing that
  would mean real WebAssembly-backend engineering (a synthetic shadow-stack
  scheme), the opposite of minimizing deltas from mainline. Instead,
  confirmed a zero-new-flags alternative works structurally: the JS host
  builds its own shadow call stack purely by watching `__stack_pointer`
  (already exported, from the frame-base work) change between
  already-planned statement-boundary hook firings -- see
  `documents/design.md`'s backtrace note for the full mechanism.
  - **Implemented**: `Plugins/Process/wasm-memory/UnwindWasmMemory` (new,
    modeled directly on `Plugins/Process/wasm`'s own `UnwindWasm`, just
    backed by `ProcessWasmMemory`'s own recorded shadow stack instead of a
    live GDB-remote call-stack query); `ProcessWasmMemory::SetStopState`
    and `RegisterContextWasmMemory` extended from one frame to a full
    `std::vector<WasmFrame>`; `ThreadWasmMemory::GetUnwinder()` wired up;
    `wasm_dbg_set_stop`'s signature extended to a flat multi-frame array
    (`frame_pcs`/`local_frame_indices`/`local_wasm_indices`/
    `local_values`); a new `wasm_dbg_get_backtrace()` export added.
  - **Verified working**: frame 0 (innermost) resolves and formats
    correctly through the *entire* new path -- confirmed
    `UnwindWasmMemory::DoGetFrameInfoAtIndex`/`DoCreateRegisterContextForFrame`
    are called with the right per-frame data via temporary instrumentation
    (removed after).
  - **Blocked**: frame 1 (the second `wasm_dbg_set_stop`-supplied frame,
    `caller()` -- the *third* DWARF-covered function in the test module,
    after `_start` and `add()`) fails to resolve *at all*, at every
    address tried across its whole range, including its own exact
    `DW_AT_low_pc` -- confirmed via a bare `wasm_dbg_resolve_pc()` call on
    one of its addresses, completely bypassing `StackFrame`/`UnwindWasmMemory`,
    that this is not caused by anything in the multi-frame work above:
    it resolves to the *first* function's own symbol/line ("_start")
    instead of failing cleanly or matching `caller()`. `add()` (the
    *second* DWARF-covered function) resolves correctly. Ruled out: wasm's
    tagged 64-bit address encoding (`Plugins/ObjectFile/wasm/WasmAddress.h`)
    -- confirmed via `grep` that `ObjectFileWasm.cpp` never uses it for
    code addresses, only for live Memory/Global addressing elsewhere; a
    constant translation between `DW_AT_low_pc` and the function's real
    file offset -- confirmed via `llvm-objdump -d` that a *single* fixed
    offset (the code section's own header length) converts every
    function's DWARF `low_pc` to its real address correctly, including
    `caller()`'s, so the raw numbers this test used were never the actual
    bug. The evidence instead points at `SymbolFileDWARF`'s (or
    `ObjectFile/wasm`'s) own address-range index only correctly
    registering the first two DWARF-covered functions in a module, with
    the third and beyond silently falling through to a nearest/default
    match -- a real, pre-existing Stage-A gap, never exercised before
    since no previous smoketest used more than two user functions. Worth
    its own dedicated investigation into `SymbolFileDWARF`/
    `ObjectFile/wasm`'s function-range indexing; not yet started.

- **Hook granularity** (the one open design choice in the instrumentation
  scheme itself): `-fsanitize-coverage=trace-pc-guard`/`inline-8bit-counters`
  vs. a custom LLVM pass emitting one hook per DWARF line-table row —
  whichever turns out to give clean line-stepping without excessive
  overhead. Not yet measured.
- **The "Debug" build needs `-Wl,--export=__stack_pointer` on its link
  line.** Resolved a real gap here without any compiler change: see
  `documents/design.md`'s frame-base note. Verified directly (`wasi-sdk`
  compile+link+`llvm-objdump`) that `__stack_pointer` isn't exported by
  default but a plain linker flag makes it a normal, always-current
  `WebAssembly.Global` — exactly the value `DW_AT_frame_base`'s synthetic
  local holds for the whole function body at `-O0`. `wasm_dbg_set_stop`'s
  `local_indices`/`local_values` parameters exist for this: the JS host
  reads `instance.exports.__stack_pointer.value` itself and passes it in
  as the one `eWasmTagLocal` entry, no compiler/instrumentation change
  needed. Not yet threaded through an actual "Debug" build's link flags
  (`build.bat`/a future dedicated Debug-build script) or exercised
  end-to-end.
- **Instrumentation overhead**: not yet measured in practice.
- Binary size (`lldb.wasm` is ~96 MiB today) is a known, deliberately
  deferred concern — see "Alternatives considered" in `documents/design.md`
  for the curated-`LINK_LIBS` approach if this is ever revisited.

### Running the compiled program in a separate browser tab

Real OS-level sandboxing win (Chrome site isolation via
`vscode.env.openExternal`, no new engineering) and a way to get Chrome's
own built-in DWARF DevTools support as an immediate fallback debugging
path — independent of the `lldb.wasm`-as-library work above. Two open
questions before this is buildable:
1. **Cross-context communication**: `openExternal` returns no `Window`
   handle, so the extension can't `postMessage` into the new tab directly.
   Not yet investigated: a self-sufficient runner tab that re-compiles
   itself rather than receiving compiled bytes from the extension, vs.
   some other relay, vs. one-shot URL-encoded hand-off for small payloads.
2. **`SharedArrayBuffer`/cross-origin isolation for the runner page**:
   needs real `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy`
   response headers from wherever the runner page is hosted (a
   `coi-serviceworker`-style shim is a documented workaround where the
   host can't set headers directly, e.g. GitHub Pages) — not yet arranged.

This is a `documents/js-host-contract.md`/host-design question (where does
the runner page live, how is it served), not an LLVM source question, and
doesn't depend on any `lldb.wasm` work to be worth starting.

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
