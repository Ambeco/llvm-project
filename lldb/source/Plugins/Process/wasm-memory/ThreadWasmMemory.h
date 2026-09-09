//===----------------------------------------------------------------------===//
//
// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
//
//===----------------------------------------------------------------------===//

#ifndef LLDB_SOURCE_PLUGINS_PROCESS_WASM_MEMORY_THREADWASMMEMORY_H
#define LLDB_SOURCE_PLUGINS_PROCESS_WASM_MEMORY_THREADWASMMEMORY_H

#include "lldb/Target/Thread.h"

namespace lldb_private {
namespace wasm {

/// The one thread `ProcessWasmMemory` ever reports. There is only ever one
/// stopped frame -- the innermost one, at whatever PC the instrumentation
/// hook fired at -- since nothing here unwinds the wasm engine's real call
/// stack (see `documents/design.md`'s frame-base note on why that would
/// need the instrumentation to capture a shadow call stack itself, a
/// separate, not-yet-implemented piece).
class ThreadWasmMemory : public Thread {
public:
  ThreadWasmMemory(Process &process, lldb::tid_t tid);

  ~ThreadWasmMemory() override;

  void RefreshStateAfterStop() override;

  lldb::RegisterContextSP GetRegisterContext() override;

  lldb::RegisterContextSP
  CreateRegisterContextForFrame(StackFrame *frame) override;

  bool CalculateStopInfo() override;

private:
  lldb::RegisterContextSP m_register_context_sp;

  ThreadWasmMemory(const ThreadWasmMemory &) = delete;
  const ThreadWasmMemory &operator=(const ThreadWasmMemory &) = delete;
};

} // namespace wasm
} // namespace lldb_private

#endif // LLDB_SOURCE_PLUGINS_PROCESS_WASM_MEMORY_THREADWASMMEMORY_H
