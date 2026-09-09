//===----------------------------------------------------------------------===//
//
// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
//
//===----------------------------------------------------------------------===//

#ifndef LLDB_SOURCE_PLUGINS_PLATFORM_WASI_PLATFORMWASI_H
#define LLDB_SOURCE_PLUGINS_PLATFORM_WASI_PLATFORMWASI_H

#include "Plugins/Platform/POSIX/PlatformPOSIX.h"

namespace lldb_private {
namespace platform_wasi {

/// The *host* platform for an `lldb`/`liblldb` built to run as
/// `wasm32-unknown-wasiN` itself -- not to be confused with
/// `Plugins/Platform/WebAssembly`'s `PlatformWasm`, which represents a wasm
/// program as a debug *target*, reached over GDB-remote. This class exists
/// only so `Platform::GetHostPlatform()` returns something real: every
/// other Platform plugin's host self-registration
/// (`PlatformLinux`/`PlatformWindows`/etc., see their own `Initialize()`)
/// is gated on `#if defined(__linux__)`/`_WIN32`/etc., none of which is
/// ever defined when compiling *for* WASI, so without this, no platform
/// ever becomes "the host" and `TargetList::CreateTarget()` crashes on a
/// null `PlatformSP` the moment it calls `IsHost()` on it (`Debugger`'s
/// constructor only `assert()`s `Platform::GetHostPlatform()` is
/// non-null, which compiles out in a release/NDEBUG build -- see
/// documents/notes.md for how this was actually found).
///
/// Deliberately minimal: nothing in this project ever launches, attaches
/// to, or otherwise controls a process through this platform (see
/// `ProcessWasmMemory`, constructed directly by name instead) -- it exists
/// purely to make `Target`/`TargetList` machinery (symbol/type/value
/// decoding, this project's actual use case) usable at all.
class PlatformWasi : public PlatformPOSIX {
public:
  PlatformWasi(bool is_host);

  static void Initialize();

  static void Terminate();

  static lldb::PlatformSP CreateInstance(bool force, const ArchSpec *arch);

  static llvm::StringRef GetPluginNameStatic(bool is_host) {
    return is_host ? Platform::GetHostPlatformName() : "remote-wasi";
  }

  static llvm::StringRef GetPluginDescriptionStatic(bool is_host);

  llvm::StringRef GetPluginName() override {
    return GetPluginNameStatic(IsHost());
  }

  llvm::StringRef GetDescription() override {
    return GetPluginDescriptionStatic(IsHost());
  }

  std::vector<ArchSpec>
  GetSupportedArchitectures(const ArchSpec &process_host_arch) override;

  void CalculateTrapHandlerSymbolNames() override;

private:
  std::vector<ArchSpec> m_supported_architectures;
};

} // namespace platform_wasi
} // namespace lldb_private

#endif // LLDB_SOURCE_PLUGINS_PLATFORM_WASI_PLATFORMWASI_H
