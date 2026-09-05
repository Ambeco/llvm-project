# See wasi_threaded_io.c's own header comment and
# documents/threaded-file-io-rpc-plan.md for what this runtime does and
# why. It's a single plain C file, entirely #ifdef-guarded on
# `defined(__wasi__) && defined(__wasm_atomics__)` -- compiles to an
# empty, harmless translation unit on every other target/configuration,
# so no ARCHS/OS filtering is needed here: COMPILER_RT_DEFAULT_TARGET_ONLY
# (set by both build.bat and build-single-threaded.bat) already scopes
# this, like every other runtime component, to whichever single target
# triple is active at configure time.
add_compiler_rt_runtime(clang_rt.wasi_threaded_io
  STATIC
  ARCHS ${COMPILER_RT_DEFAULT_TARGET_ARCH}
  SOURCES wasi_threaded_io.c)
