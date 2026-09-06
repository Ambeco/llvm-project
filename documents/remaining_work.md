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

## Explicitly deferred, not forgotten

- `clangd` support: raised as a likely-harder future problem (persistent
  background indexing threads, not a one-shot spawn-and-wait like `cc1`).
  `clang-tools-extra` isn't even enabled in `LLVM_ENABLE_PROJECTS` yet.
  Not attempted; worth its own investigation pass whenever it's prioritized.
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
