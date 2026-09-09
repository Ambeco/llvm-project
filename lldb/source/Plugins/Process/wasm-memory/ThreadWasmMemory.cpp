//===----------------------------------------------------------------------===//
//
// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
//
//===----------------------------------------------------------------------===//

#include "ThreadWasmMemory.h"
#include "RegisterContextWasmMemory.h"
#include "UnwindWasmMemory.h"

#include "lldb/Target/StopInfo.h"

using namespace lldb;
using namespace lldb_private;
using namespace lldb_private::wasm;

ThreadWasmMemory::ThreadWasmMemory(Process &process, tid_t tid)
    : Thread(process, tid) {}

ThreadWasmMemory::~ThreadWasmMemory() { DestroyThread(); }

void ThreadWasmMemory::RefreshStateAfterStop() {
  GetRegisterContext()->InvalidateIfNeeded(/*force=*/true);
}

RegisterContextSP ThreadWasmMemory::GetRegisterContext() {
  if (!m_register_context_sp)
    m_register_context_sp =
        std::make_shared<RegisterContextWasmMemory>(*this, 0);
  return m_register_context_sp;
}

RegisterContextSP
ThreadWasmMemory::CreateRegisterContextForFrame(StackFrame *frame) {
  uint32_t concrete_frame_idx = frame ? frame->GetConcreteFrameIndex() : 0;
  if (concrete_frame_idx == 0)
    return GetRegisterContext();
  return GetUnwinder().CreateRegisterContextForFrame(frame);
}

bool ThreadWasmMemory::CalculateStopInfo() {
  SetStopInfo(StopInfo::CreateStopReasonToTrace(*this));
  return true;
}

Unwind &ThreadWasmMemory::GetUnwinder() {
  if (!m_unwinder_up)
    m_unwinder_up = std::make_unique<UnwindWasmMemory>(*this);
  return *m_unwinder_up;
}
