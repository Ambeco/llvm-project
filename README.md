# wasm-wasi (Clang/LLVM fork)

This is a fork of [LLVM/Clang](https://github.com/llvm/llvm-project/blob/main/README.md) that compiles Clang/LLVM itself to run as `clang.wasm`/`lld.wasm` under WASI+wasm, and makes sure the resulting toolchain can compile and link real C/C++ programs to runnable wasm output.

## 1. Project idea and reason

The end goal is a Visual Studio Code for Web extension that compiles, links, runs, and (eventually) debugs C/C++ code entirely in the browser, with nothing installed locally. That extension is a separate project/repo, which will simply check in the `clang.wasm`/`lld.wasm` binaries this project produces. This repo exists to build that prerequisite: a version of Clang that can itself be compiled *to* wasm, and that can compile ordinary C/C++ *to* runnable wasm.

This isn't the first attempt at this — notably [YoWASP](https://yowasp.org/), whose push to get comparable work into mainline mostly stalled on the lack of wasm atomics support in LLVM as of 2024 (see the [RFC thread](https://discourse.llvm.org/t/rfc-building-llvm-for-webassembly/79073) and [llvm/llvm-project#92677](https://github.com/llvm/llvm-project/pull/92677), which this project builds on and compares itself against throughout). Wasm atomics now exist, which is part of why this attempt is viable. Some of this work may eventually be worth merging into mainline, which is why most changes are guarded behind the `__wasm__`/`__wasi__` macros rather than assumed, and why a Clang build with no threading and no multiprocessing is a specific, deliberately-maintained design goal: it instantiates and runs on any plain WASI host with zero custom JavaScript at all.

## 2. How to use this project

- `build.bat` — the primary build: `clang.wasm`/`lld.wasm` against `wasm32-unknown-wasip1-threads`, with real `LLVM_ENABLE_THREADS=ON` multithreading. Compiled *output* programs still default to plain, non-threaded `wasm32-wasip1` unless the user passes `-pthread` themselves.
- `build-single-threaded.bat` — an alternate build targeting plain `wasm32-unknown-wasip1`: no threading, no multiprocessing, no custom JavaScript needed to instantiate and run it (beyond what any real compile needs regardless of threading — see `documents/js-host-contract.md`).
- Everything under `ai-notes/*.mjs` is a Node.js reference host proving the resulting `clang.wasm`/`lld.wasm` actually works end-to-end (instantiate, compile, link, run, thread) — not the real browser target, but the closest thing to a runnable example and a regression check today.
- `documents/js-host-contract.md` is the canonical spec for what any JavaScript host (Node reference or real browser extension) must provide to run these binaries.

## 3. Design overview

See `documents/design.md` for the full design: the `upstream-fixes`/`wasm-wasi` branch split and why, the spawn-hook mechanism used for subprocess execution (`cc1`, `wasm-ld`), real in-module multithreading via `wasi-threads`, and the two independent kinds of parallelism this project uses. `documents/notes.md` has assorted build gotchas and dependency surprises found along the way. `documents/vscode-wasi-host.md` documents the target VS Code for Web WASI host API. `documents/threaded-file-io-rpc-plan.md` documents the fix for cross-thread file-descriptor sharing.

## 4. Remaining work

See `documents/remaining_work.md` for the full list. Briefly:
- Fix `-mwasi-threaded-io`'s link failure on non-atomics targets (e.g. `build-single-threaded.bat`'s clang.wasm without `-pthread`) — confirmed defect, not yet fixed.
- Decide whether/how to link the file-I/O threading shim into clang.wasm itself, not just its output programs.
- The real browser-based JS host (the actual VS Code for Web extension) hasn't been started — everything today is a Node.js reference implementation.
- No PR has been opened upstream from `upstream-fixes` yet.

## 5. Credits

Designed and overseen by [Ambeco](https://github.com/Ambeco), and coded mostly by Claude (or similar).
