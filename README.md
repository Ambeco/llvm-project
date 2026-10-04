# wasm-wasi (Clang/LLVM fork)

This is a fork of [LLVM/Clang](https://github.com/llvm/llvm-project/blob/main/README.md) that compiles Clang/LLVM itself to run as `clang.wasm`/`lld.wasm`/`lldb.wasm` under WASI+wasm, and makes sure the resulting toolchain can compile and link real C/C++ programs to runnable wasm output.

## 1. Project idea and reason

The end goal is a Visual Studio Code for Web extension (the "Vscw extension") that compiles, links, runs, and (eventually) debugs C/C++ code entirely in the browser, with nothing installed locally. **That extension is a separate project/repo and is not in this one.** This repo is only focused on producing the binaries it consumes: a working `clang.wasm`, `lld.wasm`, and `lldb.wasm`. That means a version of Clang that can itself be compiled *to* wasm, and that can compile ordinary C/C++ *to* runnable wasm; the matching linker; and an LLDB build used as a symbol/value-decoding library for the debugger.

This isn't the first attempt at this — notably [YoWASP](https://yowasp.org/), whose push to get comparable work into mainline mostly stalled on the lack of wasm atomics support in LLVM as of 2024 (see the [RFC thread](https://discourse.llvm.org/t/rfc-building-llvm-for-webassembly/79073) and [llvm/llvm-project#92677](https://github.com/llvm/llvm-project/pull/92677), which this project builds on and compares itself against throughout). Wasm atomics now exist, which is part of why this attempt is viable. Some of this work may eventually be worth merging into mainline, which is why most changes are guarded behind the `__wasm__`/`__wasi__` macros rather than assumed, and why a Clang build with no threading and no multiprocessing is a specific, deliberately-maintained design goal: it instantiates and runs on any plain WASI host with zero custom JavaScript at all.

## 2. How to use the binary

Prebuilt binaries are published on the
[`llvmorg-24.0.0-git-wasi.1` release](https://github.com/Ambeco/llvm-project/releases/tag/llvmorg-24.0.0-git-wasi.1)
(a pre-release snapshot of LLVM 24.0.0git, based on upstream
[`822f549e988f`](https://github.com/llvm/llvm-project/commit/822f549e988f143fc8f035b8407db9dc6f43d13f)).
The tag and `SHA256SUMS` are GPG-signed by `Ambeco (vscwClang)`, fingerprint
`6E8A C2AA 4D9C AA17 B9EF  3434 3D7F AB87 9CCB D6FA`; `ambeco-public.asc` on the release is the public key.

| File | SHA-256 |
|---|---|
| [`clang.wasm`](https://github.com/Ambeco/llvm-project/releases/download/llvmorg-24.0.0-git-wasi.1/clang.wasm) | `d07eba6464f739b89a42b0bb4098af0069aa3331c54d61d1400315ad9ff6c0e8` |
| [`lld.wasm`](https://github.com/Ambeco/llvm-project/releases/download/llvmorg-24.0.0-git-wasi.1/lld.wasm) | `6e7c8b3fc3677ab8f40991a6ae8d5adbe4f41cc495607f22b8dfa42f2dc4121f` |
| [`lldb.wasm`](https://github.com/Ambeco/llvm-project/releases/download/llvmorg-24.0.0-git-wasi.1/lldb.wasm) | `126f797354b4482bb440151612de796608d459d3a5c1efae7b7146a0c503823b` |
| [`lldb-wasm-reactor.wasm`](https://github.com/Ambeco/llvm-project/releases/download/llvmorg-24.0.0-git-wasi.1/lldb-wasm-reactor.wasm) | `779e378d065e5ddaee6dc0145187b2f9cb67dd7ff83d3f3eb0d71e62dadfc274` |

To verify a download: `gpg --import ambeco-public.asc`, then `gpg --verify SHA256SUMS.asc SHA256SUMS`, then `sha256sum -c SHA256SUMS`.

### Running them

These are the threaded build (`wasm32-unknown-wasip1-threads`, `build.bat`). Two things are
required of *any* host just to instantiate them: a shared `env.memory` import and a
`wasi.thread-spawn` implementation (the `wasi-threads` ABI), plus ordinary WASI. Under Node, run
with `--experimental-wasm-type-reflection --experimental-wasi-unstable-preview1`.

- **Without any further JavaScript** (a host that does only the above), anything that does not
  spawn a subprocess works, e.g. `clang --version`. Anything that needs a subprocess — a driver
  compile (which spawns `cc1`) or a link (which spawns `wasm-ld`) — does *not* silently degrade; it
  aborts with a fatal error saying no spawn hook is installed.
- **If the host installs a spawn hook** after instantiation, as specified in
  [`documents/js-host-contract.md`](documents/js-host-contract.md), then full compile and link
  work (`clang` driver invocations, including linking through `wasm-ld`). That document also
  covers the other host responsibilities: running in a Worker, cleanup on termination, and the
  `$COLUMNS` environment variable.
- `build-single-threaded.bat` builds a variant for plain `wasm32-unknown-wasip1`: no shared-memory
  or thread-spawn requirement, so it instantiates on any plain WASI host with zero custom
  JavaScript. It is not part of the published release.
- `lldb-wasm-reactor.wasm` is a reactor-style library (`wasm_dbg_*` exports), not a command; see
  `documents/design.md`'s debugging section. Known issue: the smoke test's frame-1 backtrace
  value formatting still fails.
- `wasi-tests/*.mjs` is a Node.js reference host and the project's smoke tests — the closest thing to a
  runnable example today, e.g. `node --experimental-wasm-type-reflection --experimental-wasi-unstable-preview1 wasi-tests/run_clang_link_smoketest.mjs`.

## 3. Design overview

See `documents/design.md` for the full design: the `upstream-fixes`/`wasm-wasi` branch split and why, the spawn-hook mechanism used for subprocess execution (`cc1`, `wasm-ld`), real in-module multithreading via `wasi-threads`, and the two independent kinds of parallelism this project uses. `documents/notes.md` has assorted build gotchas and dependency surprises found along the way. `documents/vscode-wasi-host.md` documents the target VS Code for Web WASI host API. `documents/threaded-file-io-rpc-plan.md` documents the fix for cross-thread file-descriptor sharing.

### How to build and work on this project

- `build.bat` — the primary build: `clang.wasm`/`lld.wasm` against `wasm32-unknown-wasip1-threads`, with real `LLVM_ENABLE_THREADS=ON` multithreading. Compiled *output* programs still default to plain, non-threaded `wasm32-wasip1` unless the user passes `-pthread` themselves.
- `build-lldb.bat` — builds `lldb.wasm` and `lldb-wasm-reactor.wasm` (`ninja`/`cmake --build` targets `lldb` and `lldb-wasm-reactor`) in `build-lldb/`.
- `build-single-threaded.bat` — an alternate build targeting plain `wasm32-unknown-wasip1`: no threading, no multiprocessing, no custom JavaScript needed to instantiate and run it (beyond what any real compile needs regardless of threading — see `documents/js-host-contract.md`).
- Everything under `wasi-tests/*.mjs` is a Node.js reference host proving the resulting binaries actually work end-to-end (instantiate, compile, link, run, thread) — not the real browser target, but a regression check today.
- `documents/js-host-contract.md` is the canonical spec for what any JavaScript host (Node reference or real browser extension) must provide to run these binaries.

## 4. Remaining work

See `documents/remaining_work.md` for the full list. Briefly:
- The real browser-based JS host (the actual VS Code for Web extension) hasn't been started — everything today is a Node.js reference implementation.
- No PR has been opened upstream from `upstream-fixes` yet.

## 5. Credits

Designed and overseen by [Ambeco](https://github.com/Ambeco), and coded mostly by Claude (or similar).
