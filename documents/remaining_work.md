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
