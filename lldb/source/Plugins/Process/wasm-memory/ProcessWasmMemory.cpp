//===----------------------------------------------------------------------===//
//
// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
//
//===----------------------------------------------------------------------===//

#include "ProcessWasmMemory.h"
#include "ThreadWasmMemory.h"

#include "lldb/Core/Module.h"
#include "lldb/Core/ModuleList.h"
#include "lldb/Core/PluginManager.h"
#include "lldb/Target/JITLoaderList.h"
#include "lldb/Target/Target.h"

#include <cinttypes>

using namespace lldb;
using namespace lldb_private;
using namespace lldb_private::wasm;

LLDB_PLUGIN_DEFINE(ProcessWasmMemory)

ProcessSP ProcessWasmMemory::CreateInstance(TargetSP target_sp,
                                            ListenerSP listener_sp,
                                            const FileSpec *crash_file_path,
                                            bool can_connect) {
  // Only ever reached by explicitly naming this plugin
  // (`Target::CreateProcess(listener, "wasm-memory", nullptr, true)`) --
  // never by auto-detection (see CanDebug). There is no file to load and
  // nothing to actually connect to; `can_connect`/`crash_file_path` just
  // select which of `Process::FindPlugin`'s two call shapes reached here,
  // and both are fine since this class never uses either argument. The
  // wrapper installs SetMemoryCallbacks()/SetStopState() itself afterward.
  return std::make_shared<ProcessWasmMemory>(target_sp, listener_sp);
}

bool ProcessWasmMemory::CanDebug(TargetSP target_sp,
                                 bool plugin_specified_by_name) {
  // Never selected automatically -- only ever constructed directly by the
  // embedding wrapper, which already knows it wants this plugin.
  return plugin_specified_by_name;
}

ProcessWasmMemory::ProcessWasmMemory(TargetSP target_sp,
                                     ListenerSP listener_sp)
    : Process(target_sp, listener_sp) {}

ProcessWasmMemory::~ProcessWasmMemory() { Finalize(true /* destructing */); }

void ProcessWasmMemory::Initialize() {
  PluginManager::RegisterPlugin(GetPluginNameStatic(),
                                GetPluginDescriptionStatic(),
                                ProcessWasmMemory::CreateInstance);
}

void ProcessWasmMemory::Terminate() {
  PluginManager::UnregisterPlugin(ProcessWasmMemory::CreateInstance);
}

llvm::StringRef ProcessWasmMemory::GetPluginDescriptionStatic() {
  return "Read-only process plugin backed by a JS-supplied memory callback, "
        "for decoding symbols/values out of a compiled wasm module -- not a "
        "live, controllable debug target. See documents/design.md.";
}

Status ProcessWasmMemory::DoDestroy() { return Status(); }

void ProcessWasmMemory::RefreshStateAfterStop() {
  // Nothing to refresh: SetStopState() already recorded everything this
  // stop knows, and there is exactly one thread/frame to keep in sync.
}

bool ProcessWasmMemory::DoUpdateThreadList(ThreadList &old_thread_list,
                                           ThreadList &new_thread_list) {
  ThreadSP thread_sp = old_thread_list.FindThreadByID(1, false);
  if (!thread_sp)
    thread_sp = std::make_shared<ThreadWasmMemory>(*this, /*tid=*/1);
  new_thread_list.AddThread(thread_sp);
  return true;
}

void ProcessWasmMemory::SetMemoryCallbacks(ReadMemoryCallback read_cb,
                                           WriteMemoryCallback write_cb) {
  m_read_memory_cb = std::move(read_cb);
  m_write_memory_cb = std::move(write_cb);
}

void ProcessWasmMemory::CompleteAttach() {
  SetID(1);

  // Nothing here ever goes through the normal Process::Attach/Launch path
  // a real DynamicLoader plugin's DidAttach()/DidLaunch() would fire from
  // (see documents/design.md) -- so without this, nothing ever populates
  // Target::SetSectionLoadAddress, and generic LLDB machinery that expects
  // it (StackFrame construction resolving its own function/block, not just
  // this wrapper's own explicit ResolveFileAddress fallback in
  // wasm_dbg_resolve_pc) silently fails to find anything. A wasm module
  // has no relocation to speak of, so -- exactly like
  // Plugins/DynamicLoader/Static's own LoadAllImagesAtFileAddresses() --
  // loading every section at its own file address (slide 0) is always
  // correct, not just a placeholder.
  ModuleList loaded_modules;
  for (const ModuleSP &module_sp : GetTarget().GetImages().Modules()) {
    bool changed = false;
    if (module_sp)
      module_sp->SetLoadAddress(GetTarget(), 0, /*value_is_offset=*/true,
                                changed);
    if (changed)
      loaded_modules.AppendIfNeeded(module_sp);
  }
  GetTarget().ModulesDidLoad(loaded_modules);

  SetPrivateState(lldb::eStateStopped);
  UpdateThreadListIfNeeded();
}

size_t ProcessWasmMemory::DoReadMemory(const ProcessAddress &addr, void *buf,
                                       size_t size, Status &error) {
  if (!m_read_memory_cb) {
    error = Status::FromErrorString(
        "ProcessWasmMemory: no read-memory callback installed");
    return 0;
  }
  size_t n = m_read_memory_cb(addr.GetValue(), buf, size);
  if (n < size)
    error = Status::FromErrorStringWithFormat(
        "ProcessWasmMemory: short read at 0x%" PRIx64 " (%zu of %zu bytes)",
        addr.GetValue(), n, size);
  return n;
}

size_t ProcessWasmMemory::DoWriteMemory(lldb::addr_t addr, const void *buf,
                                        size_t size, Status &error) {
  if (!m_write_memory_cb) {
    error = Status::FromErrorString(
        "ProcessWasmMemory: no write-memory callback installed");
    return 0;
  }
  size_t n = m_write_memory_cb(addr, buf, size);
  if (n < size)
    error = Status::FromErrorStringWithFormat(
        "ProcessWasmMemory: short write at 0x%" PRIx64 " (%zu of %zu bytes)",
        addr, n, size);
  return n;
}

void ProcessWasmMemory::SetStopState(
    lldb::addr_t pc, const std::map<uint32_t, uint64_t> &wasm_locals) {
  m_current_pc = pc;
  m_wasm_locals = wasm_locals;
}

bool ProcessWasmMemory::GetWasmLocal(uint32_t index, uint64_t &value) const {
  auto it = m_wasm_locals.find(index);
  if (it == m_wasm_locals.end())
    return false;
  value = it->second;
  return true;
}

JITLoaderList &ProcessWasmMemory::GetJITLoaders() {
  if (!m_jit_loaders_up)
    m_jit_loaders_up = std::make_unique<JITLoaderList>();
  return *m_jit_loaders_up;
}
