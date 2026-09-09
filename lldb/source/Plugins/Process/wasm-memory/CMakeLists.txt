add_lldb_library(lldbPluginProcessWasmMemory PLUGIN
  ProcessWasmMemory.cpp
  RegisterContextWasmMemory.cpp
  ThreadWasmMemory.cpp

  LINK_COMPONENTS
    Support
  LINK_LIBS
    lldbCore
    lldbTarget
    lldbUtility
  )
