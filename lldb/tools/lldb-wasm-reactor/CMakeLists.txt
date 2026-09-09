# A main-less WASI "reactor" module (see WasmDebugReactor.cpp) -- only
# meaningful for the wasm32-wasi cross-build (build-lldb.bat), not a normal
# host build. `-mexec-model=reactor` tells wasi-libc's startup code not to
# require (or call) `main`; the functions this module actually offers to a
# JS host are exported individually via `__attribute__((export_name(...)))`
# in the source itself; instead of `wasm-ld`'s default of stripping every
# symbol not reachable from `_start`.
add_lldb_tool(lldb-wasm-reactor
  WasmDebugReactor.cpp

  LINK_LIBS
    liblldb
    lldbHost
    lldbUtility
  )

# For "Plugins/Process/wasm-memory/ProcessWasmMemory.h", same as
# lldb-server's own include of its Plugins/Process/* headers.
target_include_directories(lldb-wasm-reactor PRIVATE "${LLDB_SOURCE_DIR}/source")

if (CMAKE_C_COMPILER_TARGET MATCHES "^wasm32-")
  # A driver/link-time-only flag -- passing it to the compile step too
  # (e.g. via target_compile_options) fails with "unsupported option".
  target_link_options(lldb-wasm-reactor PRIVATE -mexec-model=reactor)
endif()
