//===----------------------------------------------------------------------===//
//
// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
//
//===----------------------------------------------------------------------===//

#ifndef LLDB_SOURCE_PLUGINS_PROCESS_WASM_MEMORY_REGISTERCONTEXTWASMMEMORY_H
#define LLDB_SOURCE_PLUGINS_PROCESS_WASM_MEMORY_REGISTERCONTEXTWASMMEMORY_H

#include "Utility/WasmVirtualRegisters.h"
#include "lldb/Target/RegisterContext.h"
#include "lldb/lldb-private-types.h"
#include <unordered_map>

namespace lldb_private {
namespace wasm {

class ProcessWasmMemory;

/// A `RegisterInfo` for a Wasm virtual register (see
/// `Utility/WasmVirtualRegisters.h`) -- a DWARF `DW_OP_WASM_location` names
/// one of these, never a real hardware register, since wasm bytecode has
/// none. Lazily created and cached per register number the same way
/// `Plugins/Process/wasm`'s live `RegisterContextWasm` does, since the
/// virtual-register space (a 30-bit index under a 2-bit tag) is far too
/// sparse to enumerate up front.
struct WasmVirtualRegisterInfo : public RegisterInfo {
  WasmVirtualRegisterKinds kind;
  uint32_t index;

  WasmVirtualRegisterInfo(WasmVirtualRegisterKinds kind, uint32_t index)
      : RegisterInfo(), kind(kind), index(index) {}
};

/// The register context for `ProcessWasmMemory`'s single thread/frame.
///
/// There is exactly one real register: the PC, supplied by the JS host at
/// each reported stop (see `ProcessWasmMemory::SetStopState`). Every other
/// register a DWARF expression can name is a synthetic Wasm virtual register
/// (`WasmVirtualRegisterKinds`) -- in practice, today, only ever
/// `eWasmTagLocal`, since that's the only tag real `-O0 -g` codegen actually
/// emits (as `DW_AT_frame_base`; see `documents/design.md`'s "Debugging
/// design" section). Those values, too, come from the JS host at the same
/// stop -- they name genuine wasm-bytecode local state, which cannot be
/// recovered from `WebAssembly.Memory` after the fact the way ordinary
/// `DW_OP_fbreg`-addressed locals/globals can.
class RegisterContextWasmMemory : public RegisterContext {
public:
  RegisterContextWasmMemory(Thread &thread, uint32_t concrete_frame_idx);

  ~RegisterContextWasmMemory() override;

  void InvalidateAllRegisters() override;

  size_t GetRegisterCount() override;

  const RegisterInfo *GetRegisterInfoAtIndex(size_t reg) override;

  size_t GetRegisterSetCount() override;

  const RegisterSet *GetRegisterSet(size_t reg_set) override;

  uint32_t ConvertRegisterKindToRegisterNumber(lldb::RegisterKind kind,
                                               uint32_t num) override;

  bool ReadRegister(const RegisterInfo *reg_info,
                    RegisterValue &value) override;

  bool WriteRegister(const RegisterInfo *reg_info,
                     const RegisterValue &value) override;

private:
  RegisterInfo m_pc_reg_info;
  std::unordered_map<uint32_t, std::unique_ptr<WasmVirtualRegisterInfo>>
      m_register_map;
};

} // namespace wasm
} // namespace lldb_private

#endif // LLDB_SOURCE_PLUGINS_PROCESS_WASM_MEMORY_REGISTERCONTEXTWASMMEMORY_H
