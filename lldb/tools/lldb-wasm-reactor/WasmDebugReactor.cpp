//===----------------------------------------------------------------------===//
//
// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
//
//===----------------------------------------------------------------------===//
//
// A `main`-less WASI reactor module wrapping just enough of LLDB's internal
// API to serve as a JS-callable symbol/type/value-decoding library, per
// documents/design.md's "Debugging design" section. Not a debugger front
// end: there is no command interpreter, no launch/attach/resume, and no
// live process at all -- `Plugins/Process/wasm-memory/ProcessWasmMemory`
// supplies memory reads/writes and the one Wasm virtual register real
// `-O0 -g` codegen needs (`DW_AT_frame_base`) from callbacks the embedding
// JS host installs, never from a controllable inferior.
//
// Single target, single (fake) process/thread/frame: this wrapper exists to
// decode one compiled wasm module's own symbols/values, not to manage a
// debugging session with multiple targets.

#include "Plugins/Process/wasm-memory/ProcessWasmMemory.h"

#include "lldb/API/SBDebugger.h"
#include "lldb/Core/Address.h"
#include "lldb/Core/Debugger.h"
#include "lldb/Symbol/CompileUnit.h"
#include "lldb/Symbol/Function.h"
#include "lldb/Symbol/LineEntry.h"
#include "lldb/Symbol/SymbolContext.h"
#include "lldb/Target/StackFrame.h"
#include "lldb/Target/Target.h"
#include "lldb/Target/TargetList.h"
#include "lldb/Utility/FileSpec.h"
#include "lldb/Utility/Status.h"
#include "lldb/Utility/Stream.h"
#include "lldb/ValueObject/ValueObject.h"

#include "llvm/Support/Error.h"
#include "llvm/Support/FormatVariadic.h"

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>

using namespace lldb;
using namespace lldb_private;
using namespace lldb_private::wasm;

#if defined(__wasm__)
#define WASM_IMPORT(module, name)                                            \
  __attribute__((import_module(module), import_name(name)))
#define WASM_EXPORT(name) __attribute__((export_name(name)))
#else
// Lets this file at least parse on a non-wasm host, e.g. for editor
// tooling; it can never actually link there (no definitions for the
// imports, and `export_name` is meaningless off wasm).
#define WASM_IMPORT(module, name)
#define WASM_EXPORT(name)
#endif

extern "C" {

/// Reads `size` bytes of the target's `WebAssembly.Memory` at `addr` into
/// `buf`. Returns the number of bytes actually read.
size_t wasm_dbg_host_read_memory(uint64_t addr, uint8_t *buf, size_t size)
    WASM_IMPORT("wasm_dbg", "read_memory");

/// Writes `size` bytes of `buf` into the target's `WebAssembly.Memory` at
/// `addr`. Returns the number of bytes actually written.
size_t wasm_dbg_host_write_memory(uint64_t addr, const uint8_t *buf,
                                  size_t size)
    WASM_IMPORT("wasm_dbg", "write_memory");

} // extern "C"

namespace {

/// One target/process for the lifetime of this reactor instance. A second
/// call to wasm_dbg_create_target() replaces it -- there is no need to
/// support more than one compiled module open at a time for this project's
/// use case (one compile, one debug session).
DebuggerSP g_debugger_sp;
TargetSP g_target_sp;

/// Detail behind the most recent `wasm_dbg_*` call's negative return, if
/// any -- see `wasm_dbg_get_last_error()`. Deliberately simple (one slot,
/// not one per call) since nothing here is reentrant or concurrent: only
/// one JS call into this module is ever active at a time.
std::string g_last_error;

void SetLastError(llvm::StringRef message) { g_last_error = message.str(); }
void SetLastError(const Status &error) { g_last_error = error.AsCString(); }
void ClearLastError() { g_last_error.clear(); }

ProcessWasmMemory *GetWasmProcess() {
  if (!g_target_sp)
    return nullptr;
  return static_cast<ProcessWasmMemory *>(g_target_sp->GetProcessSP().get());
}

/// Copies `text` into the caller-supplied `(out_buf, out_buf_size)`,
/// NUL-terminated, truncating rather than overflowing if it doesn't fit.
/// Returns the untruncated length of `text`, the same convention as
/// `snprintf` -- callers can tell truncation happened by comparing the
/// return value against `out_buf_size`.
int32_t CopyToBuffer(llvm::StringRef text, char *out_buf,
                     uint32_t out_buf_size) {
  if (out_buf && out_buf_size > 0) {
    size_t n = std::min<size_t>(text.size(), out_buf_size - 1);
    std::memcpy(out_buf, text.data(), n);
    out_buf[n] = '\0';
  }
  return static_cast<int32_t>(text.size());
}

} // namespace

extern "C" {

/// Allocates `size` bytes in this module's own linear memory and returns
/// the address, for the JS host to write a string (a module path, an
/// expression) into before passing it to a `wasm_dbg_*` function below --
/// there is no other way to get bytes into this module's address space
/// from outside it. Free with `wasm_dbg_free()`. A null return means
/// allocation failed (out of memory); never silently returns a bad
/// pointer.
void *wasm_dbg_alloc(size_t size) WASM_EXPORT("wasm_dbg_alloc");
void *wasm_dbg_alloc(size_t size) { return std::malloc(size); }

/// Frees a pointer previously returned by `wasm_dbg_alloc()`.
void wasm_dbg_free(void *ptr) WASM_EXPORT("wasm_dbg_free");
void wasm_dbg_free(void *ptr) { std::free(ptr); }

/// Returns detail behind the most recent `wasm_dbg_*` call's negative
/// return value, written into `(out_buf, out_buf_size)` the same
/// `snprintf`-length-convention way every other string-returning function
/// here does. Empty (returns 0) if the most recent call succeeded, or if
/// it failed at a point with no further detail to give (rare -- most
/// failure paths set a real message, even a generic one, rather than
/// leaving the previous call's message stale).
int32_t wasm_dbg_get_last_error(char *out_buf, uint32_t out_buf_size)
    WASM_EXPORT("wasm_dbg_get_last_error");
int32_t wasm_dbg_get_last_error(char *out_buf, uint32_t out_buf_size) {
  return CopyToBuffer(g_last_error, out_buf, out_buf_size);
}

/// One-time setup. Must be called before any other `wasm_dbg_*` function.
/// Safe to call more than once (later calls are a no-op).
int32_t wasm_dbg_init(void) WASM_EXPORT("wasm_dbg_init");
int32_t wasm_dbg_init(void) {
  ClearLastError();
  if (g_debugger_sp)
    return 0;
  SBDebugger::Initialize();
  g_debugger_sp = Debugger::CreateInstance();
  if (!g_debugger_sp) {
    SetLastError("Debugger::CreateInstance() returned null");
    return -1;
  }
  return 0;
}

/// Creates a target from the compiled wasm module at `module_path` (a path
/// in whatever virtual filesystem this build's `FileSystem` sees -- the
/// same one `ObjectFile`/`SymbolFile` parsing already needs to read the
/// module's own bytes) and attaches `ProcessWasmMemory` to it. Replaces any
/// previously-created target. Returns 0 on success, a negative value on
/// failure -- see `wasm_dbg_get_last_error()` for detail.
int32_t wasm_dbg_create_target(const char *module_path)
    WASM_EXPORT("wasm_dbg_create_target");
int32_t wasm_dbg_create_target(const char *module_path) {
  ClearLastError();
  if (!g_debugger_sp) {
    SetLastError("wasm_dbg_init() was not called (or failed)");
    return -1;
  }

  TargetSP target_sp;
  Status error = g_debugger_sp->GetTargetList().CreateTarget(
      *g_debugger_sp, module_path, /*triple_str=*/llvm::StringRef(),
      eLoadDependentsNo, /*platform_options=*/nullptr, target_sp);
  if (error.Fail() || !target_sp) {
    if (error.Fail())
      SetLastError(error);
    else
      SetLastError("TargetList::CreateTarget returned no target");
    return -2;
  }

  ListenerSP listener_sp = g_debugger_sp->GetListener();
  ProcessSP process_sp = target_sp->CreateProcess(
      listener_sp, ProcessWasmMemory::GetPluginNameStatic(),
      /*crash_file=*/nullptr, /*can_connect=*/true);
  if (!process_sp) {
    SetLastError("Target::CreateProcess(\"wasm-memory\") returned null -- "
                "is the plugin registered?");
    return -3;
  }

  auto *wasm_process = static_cast<ProcessWasmMemory *>(process_sp.get());
  wasm_process->SetMemoryCallbacks(
      [](lldb::addr_t addr, void *buf, size_t size) -> size_t {
        return wasm_dbg_host_read_memory(addr, static_cast<uint8_t *>(buf),
                                         size);
      },
      [](lldb::addr_t addr, const void *buf, size_t size) -> size_t {
        return wasm_dbg_host_write_memory(
            addr, static_cast<const uint8_t *>(buf), size);
      });
  wasm_process->CompleteAttach();

  g_target_sp = target_sp;
  return 0;
}

/// Records a new stop at `pc`, with the current value of `count` Wasm
/// virtual registers -- in practice today, just `DW_AT_frame_base`'s one
/// synthetic local (see documents/design.md) -- supplied in the parallel
/// `local_indices`/`local_values` arrays. The instrumentation hook that
/// triggered this stop must supply these values directly: they are real
/// wasm-bytecode-local state, not recoverable from `WebAssembly.Memory`.
/// Invalidates the previously-stopped frame's cached state.
void wasm_dbg_set_stop(uint64_t pc, const uint32_t *local_indices,
                       const uint64_t *local_values, uint32_t count)
    WASM_EXPORT("wasm_dbg_set_stop");
void wasm_dbg_set_stop(uint64_t pc, const uint32_t *local_indices,
                       const uint64_t *local_values, uint32_t count) {
  ProcessWasmMemory *wasm_process = GetWasmProcess();
  if (!wasm_process)
    return;

  std::map<uint32_t, uint64_t> wasm_locals;
  for (uint32_t i = 0; i < count; ++i)
    wasm_locals[local_indices[i]] = local_values[i];
  wasm_process->SetStopState(pc, wasm_locals);

  if (ThreadSP thread_sp = wasm_process->GetThreadList().GetThreadAtIndex(0))
    thread_sp->ClearStackFrames();
}

/// Resolves `pc` to `"file:line"` (or, lacking line info, a function/symbol
/// name, or lacking even that, the bare address), written into
/// `(out_buf, out_buf_size)`. Returns the untruncated length of the result
/// (`snprintf` convention), or a negative value if `pc` isn't in any loaded
/// module at all.
int32_t wasm_dbg_resolve_pc(uint64_t pc, char *out_buf, uint32_t out_buf_size)
    WASM_EXPORT("wasm_dbg_resolve_pc");
int32_t wasm_dbg_resolve_pc(uint64_t pc, char *out_buf,
                            uint32_t out_buf_size) {
  ClearLastError();
  if (!g_target_sp) {
    SetLastError("wasm_dbg_create_target() was not called (or failed)");
    return -1;
  }

  // `ResolveLoadAddress` only knows addresses a live process/dynamic loader
  // has actually loaded into the `SectionLoadHistory` -- nothing so far
  // does that for `ProcessWasmMemory` (it was never launched or attached
  // to in the usual sense; see documents/design.md). Since a wasm module
  // has no relocation to speak of, its file (static) addresses and
  // "loaded" addresses coincide anyway, so fall back to the static
  // resolution path any offline/no-process tool uses.
  Address addr;
  if (!g_target_sp->ResolveLoadAddress(pc, addr) &&
      !g_target_sp->ResolveFileAddress(pc, addr)) {
    SetLastError(llvm::formatv("0x{0:x} is not in any loaded module", pc)
                     .str());
    return -2;
  }

  SymbolContext sc;
  addr.CalculateSymbolContext(&sc);

  StreamString stream;
  if (sc.line_entry.IsValid()) {
    stream.Printf("%s:%u", sc.line_entry.GetFile().GetPath().c_str(),
                 sc.line_entry.line);
  } else if (sc.function) {
    stream.PutCString(sc.function->GetName().AsCString("<unknown function>"));
  } else if (sc.symbol) {
    stream.PutCString(sc.symbol->GetName().AsCString("<unknown symbol>"));
  } else {
    stream.Printf("0x%llx", static_cast<unsigned long long>(pc));
  }
  return CopyToBuffer(stream.GetString(), out_buf, out_buf_size);
}

/// Evaluates the variable-expression path `expr` (a plain variable name, or
/// a path off one -- `x`, `x->y.z`, `arr[3]` -- via
/// `StackFrame::GetValueForVariableExpressionPath`, not a full expression
/// evaluator: no arithmetic, function calls, or casts) at the current stop,
/// and writes its pretty-printed value (real `DataFormatters` output --
/// `std::vector<int>` shows as `{1, 2, 3}`, not a hex dump) into
/// `(out_buf, out_buf_size)`. Returns the untruncated length of the result,
/// or a negative value if `expr` doesn't resolve or hasn't been stopped at
/// yet.
int32_t wasm_dbg_format_value(const char *expr, char *out_buf,
                              uint32_t out_buf_size)
    WASM_EXPORT("wasm_dbg_format_value");
int32_t wasm_dbg_format_value(const char *expr, char *out_buf,
                              uint32_t out_buf_size) {
  ClearLastError();
  ProcessWasmMemory *wasm_process = GetWasmProcess();
  if (!wasm_process) {
    SetLastError("wasm_dbg_create_target() was not called (or failed)");
    return -1;
  }
  ThreadSP thread_sp = wasm_process->GetThreadList().GetThreadAtIndex(0);
  if (!thread_sp) {
    SetLastError("no thread (this should be unreachable -- "
                "ProcessWasmMemory always reports exactly one)");
    return -1;
  }
  StackFrameSP frame_sp = thread_sp->GetStackFrameAtIndex(0);
  if (!frame_sp) {
    SetLastError("no frame -- has wasm_dbg_set_stop() been called yet?");
    return -1;
  }

  VariableSP var_sp;
  Status error;
  ValueObjectSP val_sp = frame_sp->GetValueForVariableExpressionPath(
      expr, eNoDynamicValues,
      StackFrame::eExpressionPathOptionCheckPtrVsMember, var_sp, error);
  if (!val_sp) {
    if (error.Fail())
      SetLastError(error);
    else
      SetLastError(llvm::formatv("\"{0}\" did not resolve to a value", expr)
                       .str());
    return -2;
  }

  StreamString stream;
  if (llvm::Error err = val_sp->Dump(stream)) {
    SetLastError(llvm::toString(std::move(err)));
    return -3;
  }
  return CopyToBuffer(stream.GetString(), out_buf, out_buf_size);
}

} // extern "C"
