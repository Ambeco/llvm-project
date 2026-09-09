//===----------------------------------------------------------------------===//
//
// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
//
//===----------------------------------------------------------------------===//

#ifndef LLDB_SOURCE_PLUGINS_PROCESS_WASM_MEMORY_UNWINDWASMMEMORY_H
#define LLDB_SOURCE_PLUGINS_PROCESS_WASM_MEMORY_UNWINDWASMMEMORY_H

#include "lldb/Target/Unwind.h"

namespace lldb_private {
namespace wasm {

/// Supplies the shadow call stack `ProcessWasmMemory::SetStopState()`
/// recorded, in place of a real unwind: nothing here ever walks wasm's
/// actual call stack (nothing outside the wasm engine itself can -- see
/// documents/design.md's "Debugging design" section). The JS host builds
/// that shadow stack itself (compile-time-instrumentation hooks tracking
/// `__stack_pointer` transitions -- see the design doc's backtrace note)
/// and hands it to `wasm_dbg_set_stop()` as a plain array of
/// `{pc, wasm_locals}` frames; this class is just the `Unwind` interface
/// LLDB's generic `StackFrameList` machinery needs to enumerate them.
/// Modeled directly on `Plugins/Process/wasm`'s own `UnwindWasm`, which
/// does the same thing from a live GDB-remote call-stack query instead.
class UnwindWasmMemory : public Unwind {
public:
  UnwindWasmMemory(Thread &thread) : Unwind(thread) {}

protected:
  void DoClear() override {}

  uint32_t DoGetFrameCount() override;

  bool DoGetFrameInfoAtIndex(uint32_t frame_idx, lldb::addr_t &cfa,
                             lldb::addr_t &pc,
                             bool &behaves_like_zeroth_frame) override;

  lldb::RegisterContextSP
  DoCreateRegisterContextForFrame(StackFrame *frame) override;
};

} // namespace wasm
} // namespace lldb_private

#endif // LLDB_SOURCE_PLUGINS_PROCESS_WASM_MEMORY_UNWINDWASMMEMORY_H
