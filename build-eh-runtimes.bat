rem Builds the exception-enabled (eh) libc++/libc++abi/libunwind for wasm32-wasip1 using OUR clang.wasm (build/bin),
rem driven through node via wasi-tests/clang_wasm_cli.mjs (wrappers in build-eh-runtimes/tools). Needs build.bat run first.
set TOOLS=C:/Users/mooin/Dropbox/Code/Github/llvm-project/build-eh-runtimes/tools
set SDK=C:/Users/mooin/AppData/Local/wasi-sdk/wasi-sdk-34.0-x86_64-windows
if not exist C:\Users\mooin\Dropbox\Code\Github\llvm-project\build-eh-runtimes\build mkdir C:\Users\mooin\Dropbox\Code\Github\llvm-project\build-eh-runtimes\build
cd C:\Users\mooin\Dropbox\Code\Github\llvm-project\build-eh-runtimes\build
cmake -G "Ninja" ^
  -DCMAKE_C_COMPILER=%TOOLS%/clang.bat ^
  -DCMAKE_CXX_COMPILER=%TOOLS%/clang++.bat ^
  -DCMAKE_AR=%SDK%/bin/llvm-ar.exe ^
  -DCMAKE_RANLIB=%SDK%/bin/llvm-ranlib.exe ^
  -DCMAKE_NM=%SDK%/bin/llvm-nm.exe ^
  -DCMAKE_SYSTEM_NAME=Generic ^
  -DCMAKE_SYSTEM_PROCESSOR=wasm32 ^
  -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-unknown-wasip1 -DLLVM_HOST_TRIPLE=wasm32-unknown-wasip1 ^
  -DCMAKE_C_COMPILER_TARGET=wasm32-wasip1 -DCMAKE_CXX_COMPILER_TARGET=wasm32-wasip1 ^
  -DCMAKE_SYSROOT=%SDK%/share/wasi-sysroot ^
  -DCMAKE_BUILD_TYPE=Release ^
  -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY ^
  -DCMAKE_C_FLAGS="-fwasm-exceptions --target=wasm32-wasip1 --sysroot=%SDK%/share/wasi-sysroot" ^
  -DCMAKE_CXX_FLAGS="-fwasm-exceptions --target=wasm32-wasip1 --sysroot=%SDK%/share/wasi-sysroot" ^
  -DLLVM_ENABLE_RUNTIMES="libunwind;libcxxabi;libcxx" ^
  -DLLVM_ENABLE_PER_TARGET_RUNTIME_DIR=ON ^
  -DLIBCXX_ENABLE_SHARED=OFF -DLIBCXXABI_ENABLE_SHARED=OFF -DLIBUNWIND_ENABLE_SHARED=OFF ^
  -DLIBCXX_ENABLE_EXCEPTIONS=ON -DLIBCXXABI_ENABLE_EXCEPTIONS=ON ^
  -DLIBCXX_ENABLE_THREADS=OFF -DLIBCXXABI_ENABLE_THREADS=OFF -DLIBUNWIND_ENABLE_THREADS=OFF ^
  -DLIBCXX_HAS_MUSL_LIBC=OFF ^
  -DLIBCXXABI_USE_LLVM_UNWINDER=ON -DLIBUNWIND_HIDE_SYMBOLS=ON ^
  -DLIBCXX_ENABLE_FILESYSTEM=ON ^
  -DLIBCXX_ENABLE_EXPERIMENTAL_LIBRARY=OFF ^
  -DLIBCXX_INCLUDE_TESTS=OFF -DLIBCXXABI_INCLUDE_TESTS=OFF -DLIBUNWIND_INCLUDE_TESTS=OFF ^
  -DLIBCXX_INCLUDE_BENCHMARKS=OFF ^
  -DLIBCXX_INSTALL_MODULES=OFF ^
  -DLLVM_INCLUDE_TESTS=OFF ^
  ../../runtimes
cmake --build . -j 6
