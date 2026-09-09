//===----------------------------------------------------------------------===//
//
// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
//
//===----------------------------------------------------------------------===//

#include "PlatformWasi.h"

#include "lldb/Core/PluginManager.h"
#include "lldb/Host/HostInfo.h"

using namespace lldb;
using namespace lldb_private;
using namespace lldb_private::platform_wasi;

LLDB_PLUGIN_DEFINE(PlatformWasi)

static uint32_t g_initialize_count = 0;

PlatformSP PlatformWasi::CreateInstance(bool force, const ArchSpec *arch) {
  // Never a match for auto-detection (`force == false`) -- this is not a
  // debug *target* platform (that's `PlatformWasm`, an entirely different
  // plugin), only ever the host one, and the host platform is set directly
  // in Initialize() below, never discovered this way.
  if (force)
    return PlatformSP(new PlatformWasi(false));
  return PlatformSP();
}

llvm::StringRef PlatformWasi::GetPluginDescriptionStatic(bool is_host) {
  if (is_host)
    return "Host platform for an lldb built to run as wasm32-wasi itself "
          "(see documents/design.md's \"Debugging design\" section) -- not "
          "a wasm debug *target* platform; see Plugins/Platform/WebAssembly "
          "for that.";
  return "Remote WASI platform plug-in (unimplemented; nothing in this "
        "project connects to one).";
}

void PlatformWasi::Initialize() {
  Platform::Initialize();

  if (g_initialize_count++ == 0) {
#if defined(__wasi__)
    PlatformSP default_platform_sp(new PlatformWasi(true));
    default_platform_sp->SetSystemArchitecture(HostInfo::GetArchitecture());
    Platform::SetHostPlatform(default_platform_sp);
#endif
    PluginManager::RegisterPlugin(PlatformWasi::GetPluginNameStatic(false),
                                  PlatformWasi::GetPluginDescriptionStatic(false),
                                  PlatformWasi::CreateInstance, nullptr);
  }
}

void PlatformWasi::Terminate() {
  if (g_initialize_count > 0) {
    if (--g_initialize_count == 0)
      PluginManager::UnregisterPlugin(PlatformWasi::CreateInstance);
  }

  PlatformPOSIX::Terminate();
}

PlatformWasi::PlatformWasi(bool is_host) : PlatformPOSIX(is_host) {
  if (is_host) {
    m_supported_architectures.push_back(
        HostInfo::GetArchitecture(HostInfo::eArchKindDefault));
  } else {
    m_supported_architectures =
        CreateArchList({llvm::Triple::wasm32}, llvm::Triple::WASI);
  }
}

std::vector<ArchSpec>
PlatformWasi::GetSupportedArchitectures(const ArchSpec &process_host_arch) {
  if (m_remote_platform_sp)
    return m_remote_platform_sp->GetSupportedArchitectures(process_host_arch);
  return m_supported_architectures;
}

void PlatformWasi::CalculateTrapHandlerSymbolNames() {
  // No known trap-handler symbol on this target -- leaving this empty is
  // the honest answer, not a gap to fill in with a guess borrowed from a
  // real OS.
}
