//===----------------------------------------------------------------------===//
//
// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
//
//===----------------------------------------------------------------------===//

#ifndef LLDB_SOURCE_PLUGINS_PROCESS_WASM_MEMORY_PROCESSWASMMEMORY_H
#define LLDB_SOURCE_PLUGINS_PROCESS_WASM_MEMORY_PROCESSWASMMEMORY_H

#include "lldb/Target/Process.h"
#include <functional>
#include <map>

namespace lldb_private {
namespace wasm {

/// A `Process` with no live control of its own -- there is no launch, no
/// resume, no step, and no attach in the usual sense. Every one of those
/// stays the loud "not supported" stub `Process` already gives them by
/// default. See `documents/design.md`'s "Debugging design" section for why:
/// control flow (pause/resume/step) is owned entirely by compile-time
/// instrumentation calling back into the JS host directly, never by LLDB.
///
/// What this class supplies instead is exactly the two things LLDB's
/// `ValueObject`/`DataFormatters` machinery needs `Process` for when
/// formatting a value: reading (and, for completeness, writing) target
/// memory, and answering a read of the one Wasm virtual register real
/// `-O0 -g` codegen actually emits (`DW_AT_frame_base`'s synthetic local --
/// see `RegisterContextWasmMemory`). Both are answered by callbacks the
/// embedding wrapper installs, which in the real build read/write the
/// shared `WebAssembly.Memory` directly and report locals the compiled
/// program's own instrumentation hook captured at the current stop -- never
/// by launching, attaching to, or otherwise controlling anything.
class ProcessWasmMemory : public Process {
public:
  /// Reads `size` bytes at `addr` into `buf`. Returns the number of bytes
  /// actually read (short reads are a real, reportable condition, the same
  /// as any other `Process::DoReadMemory` implementation).
  using ReadMemoryCallback =
      std::function<size_t(lldb::addr_t addr, void *buf, size_t size)>;
  using WriteMemoryCallback = std::function<size_t(
      lldb::addr_t addr, const void *buf, size_t size)>;

  ProcessWasmMemory(lldb::TargetSP target_sp, lldb::ListenerSP listener_sp);

  ~ProcessWasmMemory() override;

  static lldb::ProcessSP CreateInstance(lldb::TargetSP target_sp,
                                        lldb::ListenerSP listener_sp,
                                        const FileSpec *crash_file_path,
                                        bool can_connect);

  static void Initialize();

  static void Terminate();

  static llvm::StringRef GetPluginNameStatic() { return "wasm-memory"; }

  static llvm::StringRef GetPluginDescriptionStatic();

  llvm::StringRef GetPluginName() override { return GetPluginNameStatic(); }

  bool CanDebug(lldb::TargetSP target_sp,
               bool plugin_specified_by_name) override;

  bool IsLiveDebugSession() const override { return true; }

  Status DoDestroy() override;

  void RefreshStateAfterStop() override;

  bool DoUpdateThreadList(ThreadList &old_thread_list,
                          ThreadList &new_thread_list) override;

  size_t DoReadMemory(const ProcessAddress &addr, void *buf, size_t size,
                      Status &error) override;

  size_t DoWriteMemory(lldb::addr_t addr, const void *buf, size_t size,
                       Status &error) override;

  /// Installs the memory-access callbacks. Reads/writes issued before this
  /// is called, or after it is called with empty callbacks, fail loudly
  /// rather than silently returning zero bytes.
  void SetMemoryCallbacks(ReadMemoryCallback read_cb,
                          WriteMemoryCallback write_cb);

  /// Marks this process as attached and stopped. Call once, right after
  /// `Target::CreateProcess(listener, "wasm-memory", nullptr, true)`
  /// returns this instance -- there is no real launch/attach handshake to
  /// wait for, so nothing else will ever move this process out of its
  /// initial state otherwise.
  void CompleteAttach();

  /// Records a new stop: the current PC, and the current value of every
  /// Wasm virtual register (see `Utility/WasmVirtualRegisters.h`) the
  /// instrumentation hook that triggered this stop reported -- in practice
  /// today, just `DW_AT_frame_base`'s one synthetic `eWasmTagLocal`
  /// register (see `documents/design.md`). Replaces whatever the previous
  /// stop recorded; there is only ever one live stop at a time, since
  /// nothing else can run while the instrumented program is blocked in its
  /// hook.
  void SetStopState(lldb::addr_t pc,
                    const std::map<uint32_t, uint64_t> &wasm_locals);

  lldb::addr_t GetCurrentPC() const { return m_current_pc; }

  /// Returns the last-reported value of Wasm virtual register `reg_num`
  /// (as packed by `GetWasmRegister`), or `false` if that register wasn't
  /// part of the current stop's report -- e.g. asking for a local the
  /// instrumentation hook didn't happen to capture. Callers must treat that
  /// as a real, reportable failure, not default to zero.
  bool GetWasmLocal(uint32_t index, uint64_t &value) const;

protected:
  JITLoaderList &GetJITLoaders() override;

private:
  ReadMemoryCallback m_read_memory_cb;
  WriteMemoryCallback m_write_memory_cb;
  lldb::addr_t m_current_pc = LLDB_INVALID_ADDRESS;
  std::map<uint32_t, uint64_t> m_wasm_locals;

  ProcessWasmMemory(const ProcessWasmMemory &) = delete;
  const ProcessWasmMemory &operator=(const ProcessWasmMemory &) = delete;
};

} // namespace wasm
} // namespace lldb_private

#endif // LLDB_SOURCE_PLUGINS_PROCESS_WASM_MEMORY_PROCESSWASMMEMORY_H
