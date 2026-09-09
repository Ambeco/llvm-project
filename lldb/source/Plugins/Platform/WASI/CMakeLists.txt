add_lldb_library(lldbPluginPlatformWasi PLUGIN
  PlatformWasi.cpp

  LINK_COMPONENTS
    TargetParser
  LINK_LIBS
    lldbCore
    lldbHost
    lldbTarget
    lldbPluginPlatformPOSIX
  )
