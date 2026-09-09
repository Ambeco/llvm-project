//===----------------------------------------------------------------------===//
//
// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
//
//===----------------------------------------------------------------------===//

#include "UnwindWasmMemory.h"
#include "ProcessWasmMemory.h"
#include "RegisterContextWasmMemory.h"
#include "ThreadWasmMemory.h"

using namespace lldb;
using namespace lldb_private;
using namespace lldb_private::wasm;

/// Base for synthesized frame call frame addresses -- same trick
/// `Plugins/Process/wasm`'s own `UnwindWasm` uses, for the same reason:
/// wasm has no in-memory frame address to read, so `StackID` (which orders
/// frames by CFA, expecting a younger frame to sit below its caller) needs
/// something else distinct and correctly ordered to compare instead.
static constexpr lldb::addr_t kSyntheticCFABase = 0x40000000;

uint32_t UnwindWasmMemory::DoGetFrameCount() {
  auto &process = static_cast<ProcessWasmMemory &>(*GetThread().GetProcess());
  return static_cast<uint32_t>(process.GetFrameCount());
}

bool UnwindWasmMemory::DoGetFrameInfoAtIndex(uint32_t frame_idx,
                                             lldb::addr_t &cfa,
                                             lldb::addr_t &pc,
                                             bool &behaves_like_zeroth_frame) {
  auto &process = static_cast<ProcessWasmMemory &>(*GetThread().GetProcess());
  uint32_t frame_count = DoGetFrameCount();
  if (frame_idx >= frame_count)
    return false;

  pc = process.GetFramePC(frame_idx);
  if (pc == LLDB_INVALID_ADDRESS)
    return false;

  behaves_like_zeroth_frame = (frame_idx == 0);
  const uint32_t depth_from_outermost = frame_count - 1 - frame_idx;
  cfa = kSyntheticCFABase - depth_from_outermost;
  return true;
}

lldb::RegisterContextSP
UnwindWasmMemory::DoCreateRegisterContextForFrame(StackFrame *frame) {
  const uint32_t concrete_frame_idx = frame->GetConcreteFrameIndex();
  auto &process = static_cast<ProcessWasmMemory &>(*GetThread().GetProcess());
  if (concrete_frame_idx >= process.GetFrameCount())
    return lldb::RegisterContextSP();

  return std::make_shared<RegisterContextWasmMemory>(GetThread(),
                                                      concrete_frame_idx);
}
