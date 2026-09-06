# See wasi_threaded_io.c's own header comment and
# documents/threaded-file-io-rpc-plan.md for what this runtime does and
# why. It's a single plain C file, entirely #ifdef-guarded on
# `defined(__wasi__) && defined(__wasm_atomics__)` -- compiles to an
# empty, harmless translation unit on every other target/configuration,
# so no ARCHS/OS filtering is needed against the *target* build:
# COMPILER_RT_DEFAULT_TARGET_ONLY (set by both build.bat and
# build-single-threaded.bat) already scopes this, like every other
# runtime component, to whichever single target triple is active at
# configure time.
#
# But LLVM also configures compiler-rt a *second* time, for the NATIVE
# cross-compile-host toolchain used to build host-native tblgen tools
# (see build-single-threaded/NATIVE): that pass does NOT set
# COMPILER_RT_DEFAULT_TARGET_ONLY, targets the host architecture (not
# wasm32) with a plain native compiler, yet still inherits
# COMPILER_RT_DEFAULT_TARGET_ARCH=wasm32 from LLVM_DEFAULT_TARGET_TRIPLE.
# Passing that straight to ARCHS (as this used to) made
# add_compiler_rt_runtime() hard-fail with "Architecture wasm32 can't be
# targeted" the moment the NATIVE subdir was configured fresh -- caught
# by the build-single-threaded.bat verification pass (see
# documents/threaded-file-io-rpc-plan.md's "Follow-up: verify the
# single-threaded build is unaffected"); build.bat's own from-scratch
# verification missed it only because its build/NATIVE cache predated
# this file's addition and was never reconfigured. Skip entirely on that
# pass -- a host-native tblgen tool has no business linking a wasm-only
# I/O shim anyway.
if(NOT LLVM_TARGET_IS_CROSSCOMPILE_HOST)
  add_compiler_rt_runtime(clang_rt.wasi_threaded_io
    STATIC
    ARCHS ${COMPILER_RT_DEFAULT_TARGET_ARCH}
    SOURCES wasi_threaded_io.c)
endif()
