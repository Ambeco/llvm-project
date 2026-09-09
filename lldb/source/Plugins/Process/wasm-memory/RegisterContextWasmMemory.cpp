//===----------------------------------------------------------------------===//
//
// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
//
//===----------------------------------------------------------------------===//

#include "RegisterContextWasmMemory.h"
#include "ProcessWasmMemory.h"

#include "lldb/Utility/RegisterValue.h"
#include "lldb/lldb-defines.h"

using namespace lldb;
using namespace lldb_private;
using namespace lldb_private::wasm;

RegisterContextWasmMemory::RegisterContextWasmMemory(
    Thread &thread, uint32_t concrete_frame_idx)
    : RegisterContext(thread, concrete_frame_idx), m_pc_reg_info() {
  m_pc_reg_info.name = "pc";
  m_pc_reg_info.byte_size = sizeof(lldb::addr_t);
  m_pc_reg_info.encoding = eEncodingUint;
  m_pc_reg_info.format = eFormatHex;
  for (uint32_t &kind : m_pc_reg_info.kinds)
    kind = LLDB_INVALID_REGNUM;
  m_pc_reg_info.kinds[eRegisterKindGeneric] = LLDB_REGNUM_GENERIC_PC;
  m_pc_reg_info.kinds[eRegisterKindLLDB] = 0;
}

RegisterContextWasmMemory::~RegisterContextWasmMemory() = default;

void RegisterContextWasmMemory::InvalidateAllRegisters() {}

size_t RegisterContextWasmMemory::GetRegisterCount() {
  // Just the one real register (the PC) -- every Wasm virtual register is a
  // sparse, on-demand entry addressed directly by its packed number, never
  // enumerated (see GetRegisterInfoAtIndex).
  return 1;
}

const RegisterInfo *
RegisterContextWasmMemory::GetRegisterInfoAtIndex(size_t reg) {
  if (reg == 0)
    return &m_pc_reg_info;

  uint32_t tag = GetWasmVirtualRegisterTag(reg);
  if (tag == eWasmTagNotAWasmLocation)
    return nullptr;

  auto it = m_register_map.find(reg);
  if (it == m_register_map.end()) {
    auto kind = static_cast<WasmVirtualRegisterKinds>(tag);
    uint32_t index = GetWasmVirtualRegisterIndex(reg);
    auto info = std::make_unique<WasmVirtualRegisterInfo>(kind, index);
    info->byte_size = sizeof(uint64_t);
    info->encoding = eEncodingUint;
    info->format = eFormatHex;
    for (uint32_t &k : info->kinds)
      k = LLDB_INVALID_REGNUM;
    info->kinds[eRegisterKindDWARF] = static_cast<uint32_t>(reg);
    std::tie(it, std::ignore) = m_register_map.emplace(reg, std::move(info));
  }
  return it->second.get();
}

size_t RegisterContextWasmMemory::GetRegisterSetCount() { return 0; }

const RegisterSet *RegisterContextWasmMemory::GetRegisterSet(size_t) {
  return nullptr;
}

uint32_t RegisterContextWasmMemory::ConvertRegisterKindToRegisterNumber(
    lldb::RegisterKind kind, uint32_t num) {
  // Wasm virtual register numbers (see Utility/WasmVirtualRegisters.h) are
  // used directly as DWARF register numbers by SymbolFileWasm -- no
  // separate numbering table, same as the live Process/wasm plugin.
  if (kind == eRegisterKindDWARF)
    return num;
  if (kind == eRegisterKindGeneric && num == LLDB_REGNUM_GENERIC_PC)
    return 0;
  return LLDB_INVALID_REGNUM;
}

bool RegisterContextWasmMemory::ReadRegister(const RegisterInfo *reg_info,
                                             RegisterValue &value) {
  auto &process = static_cast<ProcessWasmMemory &>(*CalculateProcess());

  if (reg_info == &m_pc_reg_info) {
    value.SetUInt(process.GetCurrentPC(), reg_info->byte_size);
    return true;
  }

  auto *wasm_reg_info = static_cast<const WasmVirtualRegisterInfo *>(reg_info);
  if (wasm_reg_info->kind != eWasmTagLocal) {
    // Real -O0 -g codegen only ever emits eWasmTagLocal (DW_AT_frame_base);
    // Global/OperandStack aren't wired up to anything today -- see
    // documents/design.md. Fail loudly rather than fabricate a value.
    return false;
  }

  uint64_t raw_value = 0;
  if (!process.GetWasmLocal(wasm_reg_info->index, raw_value))
    return false;
  value.SetUInt(raw_value, wasm_reg_info->byte_size);
  return true;
}

bool RegisterContextWasmMemory::WriteRegister(const RegisterInfo *,
                                              const RegisterValue &) {
  return false;
}
