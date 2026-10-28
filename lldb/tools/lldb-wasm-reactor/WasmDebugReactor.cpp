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
#include "lldb/Symbol/Variable.h"
#include "lldb/Symbol/VariableList.h"
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
#include <vector>

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

/// Appends `pc`'s `"file:line"` (or, lacking line info, a function/symbol
/// name, or lacking even that, the bare address) to `stream`. Shared by
/// `wasm_dbg_resolve_pc` and `wasm_dbg_get_backtrace`. Returns false if
/// `pc` isn't in any loaded module at all (nothing appended in that case).
bool AppendResolvedPc(TargetSP target_sp, uint64_t pc, Stream &stream) {
  // `ResolveLoadAddress` only knows addresses a live process/dynamic loader
  // has actually loaded into the `SectionLoadHistory` -- nothing so far
  // does that for `ProcessWasmMemory` (it was never launched or attached
  // to in the usual sense; see documents/design.md). Since a wasm module
  // has no relocation to speak of, its file (static) addresses and
  // "loaded" addresses coincide anyway, so fall back to the static
  // resolution path any offline/no-process tool uses.
  Address addr;
  if (!target_sp->ResolveLoadAddress(pc, addr) &&
      !target_sp->ResolveFileAddress(pc, addr))
    return false;

  SymbolContext sc;
  addr.CalculateSymbolContext(&sc);

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
  return true;
}

constexpr uint32_t kMaxListedChildren = 256;

/// The frame's variables visible at its pc, in declaration order (parameters
/// first). The position in this list is the first component of the paths
/// `wasm_dbg_get_variables` hands out, so listing and resolving must agree.
/// Compiler-made variables (the `__vla_expr` size slots) are skipped, but
/// `this` is kept.
std::vector<VariableSP> FrameVariables(StackFrame &frame) {
  std::vector<VariableSP> result;
  VariableListSP list_sp = frame.GetInScopeVariableList(
      /*get_file_globals=*/false);
  if (!list_sp)
    return result;
  for (size_t i = 0; i < list_sp->GetSize(); ++i) {
    VariableSP var_sp = list_sp->GetVariableAtIndex(i);
    if (var_sp && (!var_sp->IsArtificial() ||
                   var_sp->GetName() == ConstString("this")))
      result.push_back(var_sp);
  }
  return result;
}

/// The object whose children a debugger shows: the data formatter's synthetic
/// view (`std::vector` as its elements) when one applies, else the object.
ValueObjectSP DisplayValue(ValueObjectSP val_sp) {
  if (ValueObjectSP synthetic_sp = val_sp->GetSyntheticValue())
    return synthetic_sp;
  return val_sp;
}

/// Resolves a path made of `/`-separated indices: the first selects a
/// variable from `FrameVariables`, each further one a child of the previous
/// value (as `DisplayValue` presents it). Indices rather than names or
/// expressions because a synthetic child (a `std::vector` element) has no
/// expression that reaches it.
ValueObjectSP ResolveVariablePath(StackFrame &frame, llvm::StringRef path,
                                  std::string &error) {
  llvm::SmallVector<llvm::StringRef, 8> parts;
  path.split(parts, '/');
  ValueObjectSP val_sp;
  for (size_t i = 0; i < parts.size(); ++i) {
    uint32_t index;
    if (parts[i].getAsInteger(10, index)) {
      error = llvm::formatv("\"{0}\" is not a variable path from "
                            "wasm_dbg_get_variables (index {1} is not a "
                            "number)",
                            path, i)
                  .str();
      return nullptr;
    }
    if (i == 0) {
      std::vector<VariableSP> vars = FrameVariables(frame);
      if (index >= vars.size()) {
        error = llvm::formatv("the frame has {0} variables, none at index {1}",
                              vars.size(), index)
                    .str();
        return nullptr;
      }
      val_sp = frame.GetValueObjectForFrameVariable(vars[index],
                                                    eNoDynamicValues);
    } else {
      val_sp = DisplayValue(val_sp)->GetChildAtIndex(index);
    }
    if (!val_sp) {
      error = llvm::formatv("\"{0}\" has no value at component {1}", path, i)
                  .str();
      return nullptr;
    }
  }
  return val_sp;
}

void AppendField(Stream &stream, const char *text) {
  for (const char *p = text ? text : ""; *p; ++p)
    stream.PutChar((*p == '\t' || *p == '\n' || *p == '\r') ? ' ' : *p);
}

/// One `path\tname\ttype\tvalue\thas_children` line. `value` is the data
/// formatter summary, else the plain value, else the reason there is none
/// (e.g. a variable living in a wasm local, which the host cannot read).
void AppendVariableLine(Stream &stream, llvm::StringRef path,
                        ValueObjectSP val_sp) {
  const char *summary = val_sp->GetSummaryAsCString();
  const char *value = summary ? summary : val_sp->GetValueAsCString();
  std::string failure;
  if (!value && val_sp->GetError().Fail()) {
    llvm::StringRef reason = val_sp->GetError().AsCString();
    // A location in a wasm local (a by-value struct parameter, a VLA pointer)
    // is not in linear memory and no host can read it.
    if (reason.contains("DW_OP_WASM_location"))
      failure = "<not available: stored in a WebAssembly local, which the "
                "debugger cannot read>";
    else
      failure = ("<" + reason + ">").str();
    value = failure.c_str();
  }
  bool has_children =
      DisplayValue(val_sp)->GetNumChildrenIgnoringErrors(1) > 0;
  stream.PutCString(path);
  stream.PutChar('\t');
  AppendField(stream, val_sp->GetName().GetCString());
  stream.PutChar('\t');
  AppendField(stream, val_sp->GetDisplayTypeName().GetCString());
  stream.PutChar('\t');
  AppendField(stream, value);
  stream.PutChar('\t');
  stream.PutChar(has_children ? '1' : '0');
  stream.PutChar('\n');
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

/// Records a new stop: the full shadow call stack the JS host itself
/// maintains (see documents/design.md's backtrace note -- nothing here
/// walks wasm's real call stack; nothing outside the wasm engine can).
/// `frame_pcs[0]` is the innermost frame (where the instrumentation hook
/// actually fired), increasing indices walk outward toward `main`.
/// `local_frame_indices[i]`/`local_wasm_indices[i]`/`local_values[i]`
/// (all length `local_count`) give each frame's current value of whatever
/// Wasm virtual registers (see `Utility/WasmVirtualRegisters.h`) its own
/// `DW_AT_frame_base` needs -- in practice today, just one `eWasmTagLocal`
/// entry per frame, since that's the only tag real `-O0 -g` codegen
/// actually emits. These values must be supplied directly: they are real
/// wasm-bytecode-local state for whichever frame was active when the
/// engine most recently ran that frame's own code, not recoverable from
/// `WebAssembly.Memory`. Invalidates every previously-stopped frame's
/// cached state.
void wasm_dbg_set_stop(const uint64_t *frame_pcs, uint32_t frame_count,
                       const uint32_t *local_frame_indices,
                       const uint32_t *local_wasm_indices,
                       const uint64_t *local_values, uint32_t local_count)
    WASM_EXPORT("wasm_dbg_set_stop");
void wasm_dbg_set_stop(const uint64_t *frame_pcs, uint32_t frame_count,
                       const uint32_t *local_frame_indices,
                       const uint32_t *local_wasm_indices,
                       const uint64_t *local_values, uint32_t local_count) {
  ProcessWasmMemory *wasm_process = GetWasmProcess();
  if (!wasm_process)
    return;

  std::vector<ProcessWasmMemory::WasmFrame> frames(frame_count);
  for (uint32_t i = 0; i < frame_count; ++i)
    frames[i].pc = frame_pcs[i];
  for (uint32_t i = 0; i < local_count; ++i) {
    uint32_t frame_idx = local_frame_indices[i];
    if (frame_idx < frame_count)
      frames[frame_idx].wasm_locals[local_wasm_indices[i]] = local_values[i];
  }
  wasm_process->SetStopState(std::move(frames));

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

  StreamString stream;
  if (!AppendResolvedPc(g_target_sp, pc, stream)) {
    SetLastError(llvm::formatv("0x{0:x} is not in any loaded module", pc)
                     .str());
    return -2;
  }
  return CopyToBuffer(stream.GetString(), out_buf, out_buf_size);
}

/// Writes one `"file:line"` (or function/symbol name, or bare address --
/// see `wasm_dbg_resolve_pc`) per line, innermost frame first, for every
/// frame in the shadow call stack the most recent `wasm_dbg_set_stop()`
/// recorded. Walks real `Thread`/`StackFrameList` machinery (not
/// `ProcessWasmMemory`'s frame data directly), the same path a real
/// backtrace command would -- proof the `UnwindWasmMemory` plumbing itself
/// works, not just the data underneath it. Returns the untruncated length
/// of the result, or a negative value if there is no current stop.
int32_t wasm_dbg_get_backtrace(char *out_buf, uint32_t out_buf_size)
    WASM_EXPORT("wasm_dbg_get_backtrace");
int32_t wasm_dbg_get_backtrace(char *out_buf, uint32_t out_buf_size) {
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

  StreamString stream;
  for (uint32_t i = 0; StackFrameSP frame_sp = thread_sp->GetStackFrameAtIndex(i);
      ++i) {
    if (i > 0)
      stream.PutChar('\n');
    stream.Printf("#%u ", i);
    uint64_t pc = frame_sp->GetFrameCodeAddress().GetLoadAddress(
        g_target_sp.get());
    if (!AppendResolvedPc(g_target_sp, pc, stream))
      stream.Printf("0x%llx", static_cast<unsigned long long>(pc));
  }
  return CopyToBuffer(stream.GetString(), out_buf, out_buf_size);
}

/// Evaluates the variable-expression path `expr` (a plain variable name, or
/// a path off one -- `x`, `x->y.z`, `arr[3]` -- via
/// `StackFrame::GetValueForVariableExpressionPath`, not a full expression
/// evaluator: no arithmetic, function calls, or casts) in frame
/// `frame_index` of the current stop's shadow call stack (0 = innermost,
/// matching `wasm_dbg_set_stop()`'s `frame_pcs` ordering -- see
/// `wasm_dbg_get_backtrace`), and writes its pretty-printed value (real
/// `DataFormatters` output -- `std::vector<int>` shows as `{1, 2, 3}`, not
/// a hex dump) into `(out_buf, out_buf_size)`. Returns the untruncated
/// length of the result, or a negative value if `expr` doesn't resolve,
/// `frame_index` doesn't exist, or hasn't been stopped at yet.
int32_t wasm_dbg_format_value(uint32_t frame_index, const char *expr,
                              char *out_buf, uint32_t out_buf_size)
    WASM_EXPORT("wasm_dbg_format_value");
int32_t wasm_dbg_format_value(uint32_t frame_index, const char *expr,
                              char *out_buf, uint32_t out_buf_size) {
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
  StackFrameSP frame_sp = thread_sp->GetStackFrameAtIndex(frame_index);
  if (!frame_sp) {
    SetLastError(
        llvm::formatv("no frame {0} -- has wasm_dbg_set_stop() been called "
                      "yet, and does it include that many frames?",
                      frame_index)
            .str());
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

/// Lists variables for a debugger's Variables pane into `(out_buf,
/// out_buf_size)`, one `path\tname\ttype\tvalue\thas_children` line each
/// (tab and newline in the fields become spaces; `has_children` is `0` or
/// `1`). An empty `path` lists frame `frame_index`'s variables visible at its
/// pc; otherwise `path` is a `path` field from an earlier call and its
/// children (a struct's members, an array's elements, a pointee, or what a
/// data formatter exposes such as a `std::vector`'s elements) are listed,
/// capped at 256 with a final line saying how many were left out.
///
/// Paths are indices into the frame's current state and are only valid for
/// the stop that produced them; they are re-resolved on every call, so a host
/// that has to fetch missed memory pages can call `wasm_dbg_set_stop()` again
/// and repeat the call. A variable that cannot be read still gets a line, its
/// value text being the reason. Returns the untruncated length of the result
/// (`snprintf` convention), or a negative value if the frame or path does
/// not exist.
int32_t wasm_dbg_get_variables(uint32_t frame_index, const char *path,
                               char *out_buf, uint32_t out_buf_size)
    WASM_EXPORT("wasm_dbg_get_variables");
int32_t wasm_dbg_get_variables(uint32_t frame_index, const char *path,
                               char *out_buf, uint32_t out_buf_size) {
  ClearLastError();
  ProcessWasmMemory *wasm_process = GetWasmProcess();
  if (!wasm_process) {
    SetLastError("wasm_dbg_create_target() was not called (or failed)");
    return -1;
  }
  ThreadSP thread_sp = wasm_process->GetThreadList().GetThreadAtIndex(0);
  StackFrameSP frame_sp =
      thread_sp ? thread_sp->GetStackFrameAtIndex(frame_index) : nullptr;
  if (!frame_sp) {
    SetLastError(
        llvm::formatv("no frame {0} -- has wasm_dbg_set_stop() been called "
                      "yet, and does it include that many frames?",
                      frame_index)
            .str());
    return -1;
  }

  StreamString stream;
  llvm::StringRef path_ref(path ? path : "");
  if (path_ref.empty()) {
    std::vector<VariableSP> vars = FrameVariables(*frame_sp);
    for (size_t i = 0; i < vars.size(); ++i) {
      ValueObjectSP val_sp =
          frame_sp->GetValueObjectForFrameVariable(vars[i], eNoDynamicValues);
      if (val_sp)
        AppendVariableLine(stream, std::to_string(i), val_sp);
    }
  } else {
    std::string error;
    ValueObjectSP parent_sp = ResolveVariablePath(*frame_sp, path_ref, error);
    if (!parent_sp) {
      SetLastError(error);
      return -2;
    }
    ValueObjectSP shown_sp = DisplayValue(parent_sp);
    uint32_t count =
        shown_sp->GetNumChildrenIgnoringErrors(kMaxListedChildren + 1);
    for (uint32_t i = 0; i < std::min(count, kMaxListedChildren); ++i) {
      if (ValueObjectSP child_sp = shown_sp->GetChildAtIndex(i))
        AppendVariableLine(stream, path_ref.str() + "/" + std::to_string(i),
                           child_sp);
    }
    if (count > kMaxListedChildren)
      stream.Printf("\t...\t\tonly the first %u children are shown\t0\n",
                    kMaxListedChildren);
  }
  return CopyToBuffer(stream.GetString(), out_buf, out_buf_size);
}

} // extern "C"
