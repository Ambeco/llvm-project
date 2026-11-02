# Profiling and flag experiments for the wasm tools

Goal: pick the build flags (and PGO profile) that make the shipped tools (clang, lld, clangd, lldb reactor, llvm-ar) fastest. clang+lld compile+link time is the proxy for clangd and lldb, which are hard to measure directly.

Scope: only the multithreaded (`wasm32-wasip1-threads`) binaries are profiled and shipped; the single-threaded builds (`build-single-threaded`, `build-lldb-single-threaded`) are ignored.

## Starting point

`build.bat` builds `MinSizeRel` (`-Os`), `LLVM_ENABLE_RTTI=OFF`, `LLVM_ENABLE_EH=OFF`, `LLVM_ENABLE_LTO=OFF`, threads on, no PGO. wasm-opt -O3 afterwards gives about -20% size and 6-7% faster compiles (`vsclang/documents/perf_baseline.md`).

## Benchmark corpus

Measured with `vsclang/scripts/perf-bench.mjs` (compile + link, release mode, threaded tools, PCH on). Source trees are under `C:\Users\mooin\vsclang-compat`.

| Repo | Role |
|---|---|
| Lua, SQLite | C; SQLite is also the big single-TU case |
| fmt, Catch2, nlohmann/json | C++ with libc++ PCH |
| Eigen | template-heavy C++, slowest compiles |

Train/test split, to avoid scoring PGO on its own training data: train on Lua, fmt, Catch2, nlohmann/json; score on all six, and report the held-out pair (SQLite, Eigen) separately. A flag set only counts as better when the held-out pair improves too.

## Flag candidates

Already on or not applicable (no experiment):
- `-matomics -mbulk-memory`: required by the threads target.
- `-fno-rtti`: already off via `LLVM_ENABLE_RTTI=OFF`.
- `-mgc`, `-mmulti-memory`, `-mmultivalue`: LLVM codegen does not use them for C++, so there is nothing to measure. `-mreference-types`, `-mextended-const`: no expected effect on hot code.
- `-fprefetch-loop-arrays`: wasm has no prefetch instruction, so it is a no-op.
- `-fno-exceptions`: already off (`LLVM_ENABLE_EH=OFF`).

Experiments (each toggled against the current best):
1. Optimization level: `-Os` -> `-O2` (likely the biggest single change).
2. `-flto=thin` (`LLVM_ENABLE_LTO=Thin`).
3. `-mtail-call`.
4. `-msimd128` (raises the engine requirement; worth it only if clearly faster).
5. `-funroll-loops`.
6. `-mnontrapping-fptoint`.
7. Allocator: wasi-libc's dlmalloc takes a lock per call under threads; a faster allocator may beat every flag here. Needs a separate decision since it changes the sysroot.

Always applied after the build: `wasm-opt -O3` with the explicit `--enable-*` list.

## Loop (one iteration)

1. Build the tools with the flag set plus `-fprofile-generate -fprofile-update=atomic`.
2. Run the training corpus with the instrumented tools; `.profraw` is written through a WASI preopen. Merge with `llvm-profdata`.
3. Rebuild the tools with `-fprofile-use` and the same flag set, then wasm-opt.
4. Run `perf-bench.mjs --repeat 3` over the corpus, record medians.

Schedule:
- Pass 0: all experiment flags off.
- Pass 1: turn each experiment on in turn; keep it if the corpus total improves by more than the noise.
- Pass 2: toggle each flag from its pass-1 end state; keep any improvement.

Noise threshold: set from three repeated measurements of the pass-0 binaries (to be filled in). A change counts only when it beats it.

Cheaper screening (recommended before PGO): A/B the flags without PGO (one build plus one measurement, about an hour each) and run the PGO loop only for the survivors.

## Method as run

- Variants are built by `pgo/build-variant.bat` (env `VNAME VTYPE VLTO VFLAGS VEXTRA VJOBS`) into `C:\Users\mooin\pgo\variants\<name>`; about 30 min per clang+lld+llvm-ar build at `-j10` on the 6-core/16 GB dev box.
- Each variant is scored with `C:\Users\mooin\pgo\suite.sh` (outside the repo): `perf-bench.mjs`, `--pch on --repeat 1 --j 1` over a fixed corpus (Lua, SQLite, 8 fmt files, 4 Catch2 files, 3 nlohmann/json files, 3 Eigen files); sum of per-unit compile medians plus link times, about 9 min per run. `--j 1` is the score because per-file speed carries over to `--j 2/4`; finalists get one `--j 4` confirmation run and a peak-memory reading.
- Screening: each flag is built alone against `base` (MinSizeRel, no extra flags), 2 suite runs each; PGO is run later for the survivors only.
- Raw binaries are compared (no wasm-opt); wasm-opt -O3 is applied to the final choice.

Noise floor (3 runs of `base`): total 162.3 / 158.8 / 159.5 s. Runs 2 and 3 agree within 0.5%; the first run after a build is about 2% slow (cold). Treat differences under 1.5% as noise and always compare against the mean of runs 2+.

## Results

| Iteration | Flags | Profile | Train total (s) | Held-out total (s) | Binary size | Notes |
|---|---|---|---|---|---|---|
Screening (no PGO, no wasm-opt), best-of-2 per unit, total over the 6-project corpus at `--j 1`; `base` is best-of-3:

| Variant | Flags | Total (s) | vs base | clang.wasm | Notes |
|---|---|---|---|---|---|
| base | MinSizeRel (-Os) | 157.3 | | 66.3 MB | |
| o3 | Release (-O3) | 142.5 | -9.4% | 89.2 MB | |
| o2 | Release with -O2 | 142.4 | -9.5% | 82.7 MB | same speed as -O3, smaller; its first scoring (+3.5%) was interference |
| tail | -mtail-call | n/a | n/a | 66.4 MB | built clang crashes ("memory access out of bounds") on Eigen and Catch2 Matchers; rejected |
| simd | -msimd128 | 158.7 | +0.9% | 66.2 MB | noise |
| nontrap | -mnontrapping-fptoint | 161.3 | +2.6% | 66.3 MB | binary identical to base, so +2.6% is pure noise |
| unroll | -funroll-loops | 159.7 | +1.5% | 66.3 MB | binary identical to base (no effect under -Os) |
| thin | LLVM_ENABLE_LTO=Thin | 152.5 | -3.0% | 66.5 MB | borderline alone; much better stacked on -O2 |
| o2thin | -O2 + ThinLTO | 128.2 | -18.5% | 94.4 MB | 3 runs: -18.2 / -18.3 / -15.5% vs base run 2; chosen base for PGO |
| pgouse | o2thin + PGO (front-end instrumentation, trained on Lua/fmt/Catch2/json) | 120.4 | -23.5% | 98.2 MB (lld 43 MB) | 3 runs: -22.7 / -24.0 / -23.3%; held-out SQLite+Eigen 63.6 -> 58.8 s (-7.6%), train 64.6 -> 61.6 s (-4.6%), so no overfit |
| final | pgouse + wasm-opt -O3 (explicit --enable list) | 143.1 | -9.0% | clang 85.5 MB, lld 37.7 MB | 3 runs: -8.2 / -8.1 / -9.4%. wasm-opt undoes most of the ThinLTO+PGO gain (it helped 6-7% on the plain -Os build); ship the raw PGO binaries |

Real noise is about +-2.5% with best-of-2 (identical binaries scored +1.5% and +2.6%), mostly from other activity on the machine; do not use the machine during suite runs, and prefer 3 runs for close calls.

## PGO recipe (as run)

1. Profile runtime: compiler-rt `profile` built with wasi-sdk's `wasi-sdk-pthread.cmake` toolchain file plus `--target=wasm32-wasip1-threads` in the C and C++ flags (plain `CMAKE_SYSTEM_NAME=Generic` skips the profile runtime). Copy it into a private copy of wasi-sdk's resource dir as `lib/wasm32-unknown-wasip1-threads/libclang_rt.profile.a` and pass `-resource-dir=<copy>`.
2. Instrumented build: `VFLAGS="-resource-dir=<copy> -fprofile-instr-generate -fprofile-update=atomic"` with -O2 + ThinLTO. Compiles run about 10x slower.
3. Training: `perf-bench.mjs` with `PERF_CLANG_WASM`/`PERF_LLD_WASM`, `PERF_PROFILE_DIR` (mounted at `/prof`) and `VSCWCLANG_WASI_ENV='{"LLVM_PROFILE_FILE":"/prof/p-%N.profraw"}'`. `%N` becomes a random id per run because the emulated getpid is constant. 53 files, about 12 GB raw; delete after merging.
4. Merge with a natively built `llvm-profdata` from this tree (the Visual Studio one is too old): `merge -sparse`, a 20 MB result. wasi-sdk's clang 23 reads it with `-fprofile-instr-use`.
5. Rebuild with `-fprofile-instr-use=<profdata> -Wno-profile-instr-unprofiled -Wno-profile-instr-out-of-date`.

Raw (no wasm-opt) binaries and the merged profile are kept in `C:\Users\mooin\pgo\variants\keep\<name>`.

## clangd and lldb

Built with the same flags (`pgo/build-clangd-variant.bat`, `pgo/build-lldb-variant.bat`, generated from the originals): Release -O2, ThinLTO, `-fprofile-instr-use` with the clang profile (only shared clang code gets profile data; their own sources are unprofiled, which the -Wno-profile-* flags silence). Raw sizes: clangd 50.6 MB, lldb-wasm-reactor 87.3 MB; wasm-opt -O3 gives 44.2 / 76.6 MB but is likely slower, like clang (not measured for these two; their only check is that the node tests pass). The extension ships a single-threaded llvm-ar, so the threaded llvm-ar from these builds is unused.
