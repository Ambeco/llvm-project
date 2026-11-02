rem Generated from build-clangd-threads.bat by C:\Users\mooin\pgo\mk2.py: same configuration with env VNAME VTYPE VLTO VFLAGS VEXTRA VJOBS.
if "%VTYPE%"=="" set VTYPE=MinSizeRel
if "%VLTO%"=="" set VLTO=OFF
if "%VJOBS%"=="" set VJOBS=10
set OUT=C:\Users\mooin\pgo\variants\%VNAME%
if not exist %OUT% mkdir %OUT%
cd %OUT%
cmake -G "Ninja" ^
  -DCMAKE_C_COMPILER="C:/Users/mooin/AppData/Local/wasi-sdk/wasi-sdk-34.0-x86_64-windows/bin/clang.exe" ^
  -DCMAKE_CXX_COMPILER="C:/Users/mooin/AppData/Local/wasi-sdk/wasi-sdk-34.0-x86_64-windows/bin/clang++.exe" ^
  -DCMAKE_SYSTEM_NAME=Generic ^
  -DCMAKE_SYSTEM_PROCESSOR=wasm32 ^
  -DLLVM_HOST_TRIPLE=wasm32-unknown-wasip1-threads ^
  -DCMAKE_C_COMPILER_TARGET=wasm32-unknown-wasip1-threads ^
  -DCMAKE_CXX_COMPILER_TARGET=wasm32-unknown-wasip1-threads ^
  -DCMAKE_EXECUTABLE_SUFFIX=.wasm ^
  -DCMAKE_EXECUTABLE_SUFFIX_C=.wasm ^
  -DCMAKE_EXECUTABLE_SUFFIX_CXX=.wasm ^
  -DCMAKE_C_FLAGS="-pthread -D_GNU_SOURCE -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_GETPID -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS %VFLAGS%" ^
  -DCMAKE_CXX_FLAGS="-pthread -D_GNU_SOURCE -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_GETPID -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS %VFLAGS%" ^
  -DCMAKE_EXE_LINKER_FLAGS="-pthread -lwasi-emulated-signal -lwasi-emulated-getpid -lwasi-emulated-mman -lwasi-emulated-process-clocks -ldl -Wl,--strip-all -Wl,--export-table -Wl,--growable-table -Wl,--import-memory -Wl,--shared-memory -Wl,--max-memory=2147483648 -Wl,-z,stack-size=8388608 -Wl,--stack-first" ^
  -DCROSS_TOOLCHAIN_FLAGS_NATIVE=-DCMAKE_C_COMPILER="C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Tools/Llvm/x64/bin/clang.exe";-DCMAKE_CXX_COMPILER="C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Tools/Llvm/x64/bin/clang++.exe";-DCMAKE_RC_COMPILER="C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Tools/Llvm/x64/bin/llvm-rc.exe" ^
  -DCMAKE_BUILD_TYPE=%VTYPE% -DLLVM_ENABLE_LTO=%VLTO% -DLLVM_PARALLEL_LINK_JOBS=2 %VEXTRA% ^
  -DLLVM_ENABLE_PROJECTS="clang;clang-tools-extra;compiler-rt;lld" ^
  -DCOMPILER_RT_DEFAULT_TARGET_ONLY=ON ^
  -DLLVM_ENABLE_PER_TARGET_RUNTIME_DIR=ON ^
  -DLLVM_TARGETS_TO_BUILD="WebAssembly" ^
  -DBUILD_SHARED_LIBS=OFF ^
  -DLLVM_BUILD_LLVM_DYLIB=OFF ^
  -DLLVM_LINK_LLVM_DYLIB=OFF ^
  -DLLVM_TOOL_LLVM_SHLIB_BUILD=OFF ^
  -DLLVM_ENABLE_PIC=OFF ^
  -DLIBCLANG_BUILD_STATIC=ON ^
  -DLLVM_TOOL_LTO_BUILD=OFF ^
  -DLLVM_ENABLE_PLUGINS=OFF ^
  -DLLVM_ENABLE_THREADS=ON ^
  -DLLVM_INCLUDE_TESTS=OFF ^
  -DLLVM_INCLUDE_BENCHMARKS=OFF ^
  -DCLANG_INCLUDE_TESTS=OFF ^
  -DCLANG_ENABLE_STATIC_ANALYZER=ON ^
  -DCLANG_ENABLE_ARCMT=OFF ^
  -DCLANG_SPAWN_CC1=OFF ^
  -DCLANGD_TIDY_CHECKS=OFF ^
  -DCLANGD_ENABLE_REMOTE=OFF ^
  -DCLANGD_BUILD_XPC=OFF ^
  -DCLANGD_BUILD_DEXP=OFF ^
  -DCLANGD_DECISION_FOREST=OFF ^
  -Wno-author ^
  C:/Users/mooin/Dropbox/Code/Github/llvm-project/llvm
cmake --build . --target clangd -j %VJOBS%
echo BUILD-EXIT %errorlevel%
