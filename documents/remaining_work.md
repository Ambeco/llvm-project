# Remaining work

See `documents/design.md` for overall context and `ai-notes/wip.md` for
the full narrative/detail behind each item below.

## Next up: dedicated file-I/O thread + in-wasm RPC

The concrete next piece of work, already scoped as its own session — see
`documents/threaded-file-io-rpc-plan.md` for the full design notes,
constraints, and suggested build order. Summary: confirmed that sharing a
plain fd across wasi-threads workers fails (`EBADF`), since each worker
gets its own independent host WASI instance/fd table. Fix: one dedicated
I/O-owning thread, every other thread RPCs to it over a shared-memory
mailbox using wasm atomics. Not yet started. Key open questions to
resolve before writing code:
- Does wasi-libc's stdio (`fopen`/`fread`/etc.) bottom out directly at the
  `__wasi_fd_*` import layer, bypassing a `-Wl,--wrap=`-based shim? (Needs
  checking — determines whether an import-symbol override is the only
  viable interception point.)
- The I/O server must be a dedicated spawned thread, never the main
  thread (`memory.atomic.wait32` traps on a real browser main/UI thread,
  even though it works fine on Node's `worker_threads` main thread — a
  trap our Node-only reference host wouldn't catch).
- Needs linking into *both* clang.wasm itself and any `-pthread` output
  binary clang.wasm produces.

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

- `build.bat` hardcodes `lib/clang/24/...` (the current LLVM major
  version) for the second, non-threaded compiler-rt build's output path.
  Will break silently on the next version bump; should be made
  version-agnostic like the JS smoke tests' `findResourceDir()`.
- Re-verify the full 18-commit cherry-pick sequence still applies cleanly
  on the *next* rebase onto a fresh `main` snapshot; it applied with zero
  manual conflicts last time, but that's not guaranteed to hold forever.

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
