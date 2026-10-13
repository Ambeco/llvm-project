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

## Exports needed by the vscwClang extension (requested 2026-10-03)

**Status:** done and verified. `wasi-tests/package_release.mjs <tag>` produced a tree incl. lldb.wasm-family files (see MANIFEST for sizes) and `run_clang_nospawn_smoketest.mjs <release-dir>` printed SMOKETEST PASSED against it. The release now ships `compile-flags.json` (per-slice compile/link flags with `${SYSROOT}`/`${RESOURCE}` placeholders, including the libc++ `-isystem` paths), which the extension must pass because `wasm-wasi-core` hosts without working `readdir` can't auto-discover them; `run_clang_nospawn_smoketest.mjs <release-dir>` consumes that file and printed SMOKETEST PASSED (both slices tested: `--threads` compiles and links a 4-thread `std::thread`/`std::mutex` program with the threads-slice flags and runs it on the wasi-threads host, `counter = 400000`).

The `vsclang` extension (`C:\Users\mooin\Dropbox\Code\Github\vsclang\vsclang`) ships these as Marketplace tooling extensions and runs them on VS Code's `wasm-wasi-core`, which cannot install our spawn hook (it never exposes the `WebAssembly.Instance`). So its V1 needs a no-spawn, single-process, single-thread toolchain. Every item below blocks that project's Milestone 1.

1. **Single-process, single-thread `clang.wasm` and `lld.wasm`** (plain `wasm32-unknown-wasip1`, no `-pthread`, no imported/shared memory, no host JS):
   - Build clang with `-DCLANG_SPAWN_CC1=OFF`, so the driver runs cc1 in-process. Make `CrashRecoveryContext::Enable()` a graceful no-op on WASI (today it is a `report_fatal_error` stub that this path would hit; see `threaded-file-io-rpc-plan.md`, "The flag that looks like an escape hatch"). A crash then kills the instance and the host reports it.
   - Acceptance: with only a stock WASI host, `clang --target=wasm32-wasip1 -c a.cpp -o a.o` works, and `lld.wasm` (as `wasm-ld`) links the `.o` files into a runnable `.wasm`. The extension runs compile and link as separate invocations, so compile+link in one driver call (two jobs) need not work.
   - Publish with names distinct from the threaded pair, e.g. `clang.wasm`/`lld.wasm` (single-thread) and `clang-threads.wasm`/`lld-threads.wasm`, so the V2 host's binaries can't be confused with V1's.
   - Also publish the current `lldb.wasm`/`lldb-wasm-reactor.wasm` as before (needed later, Milestone 5).
2. **A sysroot directory tree** (a packaging script run after the build; plain files, not a wasm module and not self-mounting; the host mounts it read-only):
   ```
   sysroot/
     include/                       wasi-libc, libc++, libc++abi headers
     lib/wasm32-wasip1/             libc.a, libc++.a, libc++abi.a, crt1*.o, ...
     lib/wasm32-wasip1-threads/     optional: only if threaded user programs are offered
   resource/lib/clang/24/           clang resource dir from build/lib/clang/24:
                                    headers, lib/wasm32-wasip1/libclang_rt.builtins.a,
                                    and libclang_rt.wasi_threaded_io (include regardless)
   ```
   - Source: libc/libc++ pieces from wasi-sdk's `share/wasi-sysroot` (421 MB; keep only the wasip1 and wasip1-threads dirs plus `include/`); resource dir from this build. The resource dir must come from the same clang build as the published `clang.wasm`.
   - The extension passes `--sysroot=/sysroot -resource-dir=<mount>/lib/clang/24`; confirm those flags work against the tree (smoke test: reuse `run_clang_link_smoketest.mjs` with the packaged tree as the preopens).
   - Report the tree's total size; the extension needs it for the Marketplace size check.
3. **Versioning**: sysroot and binaries are tagged together (same release tag), with a short `MANIFEST` listing file hashes. The extension takes the exact files; Marketplace signing covers integrity, so the PGP signature is no longer required by it.

## The real browser-based JS host (separate project, not started)

Everything under `wasi-tests/*.mjs` is a Node reference implementation
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
  `read_memory`/`write_memory`). `wasi-tests/run_lldb_wasm_reactor_smoketest.mjs`
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

- **Hook granularity: implement the armed-block filter** (decision and
  measurements are in `documents/design.md` / `notes.md`). The e2e test
  stops mid-function using `trace-pc-guard` + `trace-loads,trace-stores` +
  the engine stack trace, but its fine hook captures a stack on *every*
  access (~10 us each). The real host should capture only while stepping or
  when the current block holds an armed line, and return immediately
  otherwise (~8 ns); not built or measured. Also open: the real hook's
  `Atomics.wait` pause cost; checking `captureWasmFrames()`'s stack-trace
  regex against SpiderMonkey and JavaScriptCore (only V8 is verified);
  some lines (1 of 12 in the benchmark) can't be stopped on with this scheme (a
  custom per-row LLVM pass in this fork's tree would, at the cost of
  rebuilding `clang.wasm`; deferred as a separate piece of work).
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
  needed. Verified end-to-end (2026-10-04) by
  `wasi-tests/run_lldb_wasm_reactor_e2e_smoketest.mjs`: a real
  `-O0 -g -fsanitize-coverage=trace-pc-guard -Wl,--export=__stack_pointer`
  program runs, and inside the live hook the real `__stack_pointer` value
  and an SP-comparison shadow stack feed `wasm_dbg_set_stop`; backtrace and
  `format_value` (ints, struct, caller-frame locals, post-return pop) match
  what the program computed. The real consumer (the JS host/extension's
  Debug-build link line, not in this repo) must still pass the flag and
  replicate that hook logic.
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

## C++ exceptions + LTO everywhere: debugging, and a real release

Compile/link/run of exceptions, LTO, and exceptions+LTO is done and verified on both slices (`wasi-tests/run_clang_eh_lto_smoketest.mjs <release-dir> [--threads]` printed SMOKETEST PASSED, against a release dir packaged to `C:	mp\ehbelease`). Still open:

- Verify `lldb-wasm-reactor` (`wasm_dbg_resolve_pc`/`wasm_dbg_format_value`; the plugin uses it as a symbol/value library, not a live debugger) on a `-g -fwasm-exceptions` program: PCs inside try/catch bodies and landing pads should resolve to the right source line, and locals inside `catch` handlers should format correctly.
- Run the other smoke tests (`run_clang_nospawn_smoketest.mjs` etc.) against a release packaged with the new defaults; they were not re-run after switching `compile-flags.json` to exceptions.
- The `-fno-exceptions` case is only exercised with libc++ built with exceptions (the supported setup); measure the size cost of the exception-enabled libs on a non-throwing program.
- Check the minimum host support for wasm exception handling (`wasm-wasi-core`, the `vsclang` extension's minimum VS Code/browser).
- Candidate for `upstream-fixes`: the libc++ `__wasi__` locale routing patch, and the two WebAssembly.cpp driver changes (`-lunwind`, LTO exception flags).

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
- **clangd, V1 (single-threaded) follow-ups.** `build-single-threaded.bat` builds
  `clangd.wasm` (`CLANGD_ALLOW_NO_THREADS=ON`), run as
  `clangd -sync -background-index=false`. Tests: `wasi-tests/run_clangd_tests.mjs`
  (file-fed sessions over `clangd_harness.mjs`: diagnostics, completion, hover,
  navigation, rename, formatting, inlay hints, config, sweeps, C, wasm targets),
  `run_clangd_stream_tests.mjs` (real pipes via `clangd_stream_harness.mjs`:
  split frames, pipelining, call/type hierarchy, applyEdit, mid-session
  config/flag/header changes, stdin EOF), `run_clangd_sweep_smoketest.mjs`. The
  host contract is in `documents/js-host-contract.md`. Still to do:
  - Untested: ObjC/ObjC++, modules, multi-root workspaces, `-pch`/`-include`
    flags, very large headers or deep template code, long-running sessions
    (hours; memory growth), and `Index.External` config.
  - Include-path completion returns nothing under `node:wasi` on Windows
    (suspected directory-listing gap); recheck on the real host.
  - Recheck on the real host (VS Code wasm-wasi-core): the stdin short-read
    quirk, `/tmp` preopen, and `-use-dirty-headers` (recommended on).
  - Sweep cost is ~1.5 s per file with `<vector><string><map>`; V1 does not
    care, but measure before V2.
  - Binary size: 57MB at `CLANGD_TIDY_CHECKS=OFF`; see the size item below.
  - Add a `release/` entry for `clangd.wasm` (and its `compile-flags.json`
    consumers) when the binaries are next published.
  - Upstream-able generic fixes made: `set_thread_priority` stub in
    `llvm/lib/Support/Threading.cpp` (declared, never defined without threads);
    `JSONTransport` body-read loop advanced `Pos` twice per partial read;
    `runAsync` (std::async) now deferred without threads, `BroadcastThread` and
    `abortAfterTimeout` inert; `-background-index` without threads is a clear
    error. WASI-specific: `getc_unlocked` body read in `JSONTransport.cpp`.
- **clangd, V1: project-wide index via a "sweep" (plugin side).** Single-threaded
  clangd can't run its background indexer, but `wasi-tests/run_clangd_sweep_smoketest.mjs`
  shows that `didOpen` then `didClose` of a file leaves its symbols in the
  dynamic index (workspace/symbol, cross-file definition and references all
  resolve to the closed file). So the plugin (coordinate with vscwClang)
  indexes a project by opening and closing each file while idle. Open items:
  - Measure on a real project: per-file cost (each file also builds a
    preamble), and whether index memory growth stays inside wasm32's limit.
  - **Unbounded memory growth, no upstream fix exists (researched
    2026-10-10, not yet decided).** Confirmed from source: upstream
    clangd's `FileIndex`/`FileSymbols` has no cap and no eviction
    (`FileIndex.h:109`'s own `// FIXME: Expose an interface to remove files
    that are closed.`), and nothing -- not `didClose`, not
    `didChangeWatchedFiles`'s `Deleted` event, nothing -- ever removes a
    file's symbols from it once swept; see `documents/js-host-contract.md`
    and `documents/notes.md` for the full trail. A small, scoped clangd
    patch (expose `FileIndex::removeFile`-ish, call it from a new
    clangd-custom LSP notification the plugin invokes explicitly when it
    evicts a swept file) is technically viable and low-risk (the
    underlying removal primitive is already reference-counted/snapshot-safe
    against in-flight readers). **Still considering whether to build it, or
    skip straight to V2's threaded build with a real background indexer
    instead** -- leaning toward V2, partly because the goal is to minimize
    non-wasm-core changes to clangd (ideally everything non-wasm, and most
    wasm changes, stays upstreamable) and a temporary V1-only eviction
    patch cuts against that.
  - Plugin must suppress `publishDiagnostics` for swept files, not close a
    file the user has open, pace opens while idle, order files near open ones
    first, and re-sweep each session (nothing persists to disk).
  - Without any index, single-file features (diagnostics, hover, completion,
    in-file navigation) still work; cross-file references/rename, workspace
    symbols, go-to-definition into closed `.cpp` files, and completion with
    auto-`#include` of not-yet-included symbols are limited to open files and
    preambles.
  - Fallbacks if the sweep proves too slow or heavy, not planned: a per-file
    `$/clangd/indexFile` API over `BackgroundIndex::index` (persists shards,
    incremental), or `clangd-indexer` (whole project, loaded via `--index-file`
    after a restart; `DefaultThreadPool` is single-threaded without threads).
- **Artifact size reduction (nice to have, not critical).** Look for easy wins on
  `clang.wasm` (~114MB), `lld.wasm`, `clangd.wasm` (~57MB), `lldb.wasm` and the
  release tree: `wasm-opt -Oz` / `--strip-debug` / name-section stripping,
  `-Wl,--gc-sections` and `--strip-all` on the link, `-Oz` instead of
  `MinSizeRel`'s `-Os`, trimming `LLVM_TARGETS_TO_BUILD` and unused clang
  components (e.g. `CLANG_ENABLE_STATIC_ANALYZER`, ARCMT already off), sharing
  code between the tools if the host ever supports dynamic linking, and
  compressing for distribution (gzip/brotli ratios to report). Measure each
  against the smoke tests before adopting.
- **clangd, V2:** threaded build with real background indexing (`-j N`); this
  makes the sweep and the fallbacks above moot.
  `build-clangd-threads.bat` now builds it (`build-clangd-threads/bin/clangd.wasm`);
  `CLANGD_THREADED=1` runs the harnesses against it. Verified: batch suite 86/86
  with `CLANGD_SYNC=1`.
  - **Fixed (2026-10-10): the ~40%-of-stream-sessions-never-exit hang.** Root
    cause confirmed: clangd's real thread pool parks idle worker threads
    forever in a blocking `Atomics.wait` (compiled from a condition-variable
    wait) once a session ends -- `wasi.start()` on the main thread returns
    fine, but the Node `Worker` backing each pool thread never emits `exit`,
    and (confirmed empirically) `process.exit()`/`process.reallyExit()` does
    NOT forcibly kill still-live `Worker` threads, it waits for them, so the
    child process hung forever. Fixed by tracking every top-level spawned
    `Worker` (`wasi_thread_hook.mjs`'s `instantiateThreaded()` now returns a
    `workers` set) and calling the new `terminateWorkers()` (forceful
    `worker.terminate()`, which does interrupt a blocked `Atomics.wait`) right
    after `wasi.start()` returns and before `process.exit()` in
    `clangd_stdio_runner.mjs`. Stream suite went from hanging to a clean
    12/16 in one run (662s, no hang) -- the remaining 4 failures are the three
    already-known stale-diagnostics-ordering cases below plus one new one.
  - **Fixed (2026-10-10): the three async stream-test failures were exactly
    stale-then-fresh diagnostics ordering.** Confirmed by instrumentation: a
    file/header edit under async mode makes clangd publish two
    `publishDiagnostics` for the same uri in quick succession -- a stale one
    (leftover from in-flight work that raced ahead of the edit) then the real
    one -- and `Client.diags()` was returning the *first* match after a given
    point, i.e. the stale one. Fixed by adding `diagsWhen(c, name, from, pred)`
    to `run_clangd_stream_tests.mjs`, built on the existing `waitNote`
    (event-driven, with its existing timeout as a backstop -- no polling/sleep
    added), and switching the three affected tests to wait for diagnostics
    matching the condition they actually expect rather than just "the next
    one". Stream suite is now 16/16 in ~50s (`CLANGD_THREADED=1`).
  - Batch harness now runs async mode (`CLANGD_THREADED=1`, no `CLANGD_SYNC`)
    by delegating `session()` to the live-pipe client (`asyncSession()` in
    `clangd_stream_harness.mjs`): 86/86 (the `scale` memory check is skipped,
    the child's memory isn't observable). `CLANGD_BG_INDEX=1` drops
    `-background-index=false`; `run_clangd_bgindex_smoketest.mjs` passes
    (closed file's symbol in `workspace/symbol`, go-to-definition into it,
    exit 0). Still open for `-background-index`: measure indexing time and
    memory on a realistic project, where shards persist (`.cache/clangd/index`
    under the project root) and whether the host should expose that dir, and
    whether to run the stream suite with it enabled.
- **clangd, V3:** static analysis / clang-tidy checks (`CLANGD_TIDY_CHECKS=ON`),
  gated on binary-size budget.
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
