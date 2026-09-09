// Proves lldb-wasm-reactor.wasm (see documents/design.md's "Debugging
// design" section and lldb/tools/lldb-wasm-reactor/WasmDebugReactor.cpp)
// actually works end-to-end against a real compiled program:
// instantiate it, create a target from a real `-O0 -g` wasm binary,
// resolve addresses to source file:line, and -- across a two-level call
// chain -- get a real backtrace and format a local variable's value in
// each frame, including the non-innermost one.
//
// None of this runs the compiled program for real -- the compile-time-
// instrumentation hook that would produce a real stop is a separate,
// not-yet-designed piece (see documents/remaining_work.md). Instead this
// builds a synthetic memory image and a shadow call stack by hand,
// matching exactly what DWARF says each frame's locals should resolve to
// (frame_base + each variable's own DW_OP_fbreg offset), and serves reads
// from it through the real read_memory callback -- exercising the real
// DW_OP_fbreg/DW_OP_WASM_location decoding, the real UnwindWasmMemory
// frame-enumeration path (not just ProcessWasmMemory's data directly),
// and real DataFormatters pretty-printing, just not real execution.
//
// The target test program is compiled fresh each run by the host's own
// wasi-sdk clang (not clang.wasm) -- this test exercises lldb-wasm-reactor,
// not this project's own compiler, so there's no reason to route through
// the slower, separately-verified self-hosted path.
//
// Usage:
//   node --experimental-wasm-type-reflection --experimental-wasi-unstable-preview1 \
//     ai-notes/run_lldb_wasm_reactor_smoketest.mjs [path-to-lldb-wasm-reactor.wasm] [path-to-wasi-sdk-clang]
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { WASI } from 'node:wasi';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { argv as processArgv } from 'node:process';
import { instantiateThreaded, makeFakeInstance } from './wasi_thread_hook.mjs';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(import.meta.dirname, '..');
const reactorPath = processArgv[2] ??
  path.join(repoRoot, 'build-lldb', 'bin', 'lldb-wasm-reactor.wasm');
const wasiSdkClang = processArgv[3] ??
  'C:/Users/mooin/AppData/Local/wasi-sdk/wasi-sdk-34.0-x86_64-windows/bin/clang.exe';
const llvmDwarfdump = path.join(path.dirname(wasiSdkClang), 'llvm-dwarfdump.exe');

const workDir = await mkdtemp(path.join(tmpdir(), 'lldb-wasm-reactor-smoketest-'));
// A two-level call chain: caller() calls add(), so a real backtrace and
// caller-frame variable inspection have something to actually exercise.
const addC = `int add(int a, int b) {
  int c = a + b;
  return c;
}

int caller(int x) {
  int y = add(x, 10);
  return y;
}

int main(void) {
  return caller(1);
}
`;
const srcPath = path.join(workDir, 'add.c');
const targetPath = path.join(workDir, 'add.wasm');
await writeFile(srcPath, addC);
console.error(`Compiling ${srcPath} -> ${targetPath}...`);
await execFileAsync(wasiSdkClang, ['-O0', '-g', '-o', targetPath, srcPath]);

const { stdout: dwarfDump } = await execFileAsync(llvmDwarfdump, ['--debug-info', targetPath]);

/// Finds `fnName`'s own `DW_TAG_subprogram` chunk. Split first, rather
/// than a regex spanning the whole dump, since a regex reaching across
/// multiple DW_TAG_subprogram entries can lock onto some *other*,
/// earlier function's own low_pc/attributes instead -- confirmed
/// empirically (see the offset/name-pairing bugs this hit during initial
/// development, kept here as a warning against "simplifying" this back
/// to one regex).
function findFunctionChunk(fnName) {
  const chunk = dwarfDump.split('DW_TAG_subprogram')
    .find((c) => new RegExp(`DW_AT_name\\s*\\("${fnName}"\\)`).test(c));
  if (!chunk) throw new Error(`could not find DW_TAG_subprogram for "${fnName}" via llvm-dwarfdump output`);
  return chunk;
}

/// `fnName`'s DWARF `DW_AT_low_pc` -- the same address
/// `wasm_dbg_resolve_pc` itself will resolve, NOT llvm-nm's symbol-table
/// address (confirmed empirically these disagree for a wasm object:
/// `Plugins/ObjectFile/wasm`/`SymbolFile/DWARF` use DWARF's own
/// addressing, and llvm-nm's symbol table numbering isn't guaranteed to
/// agree with it, unlike on more familiar formats).
function getLowPc(fnName) {
  const match = findFunctionChunk(fnName).match(/DW_AT_low_pc\s*\(0x([0-9a-f]+)\)/);
  if (!match) throw new Error(`could not find DW_AT_low_pc for "${fnName}"`);
  return parseInt(match[1], 16);
}

/// `varName`'s `DW_OP_fbreg` offset within `fnName` -- the offset from
/// that frame's own frame-base value to the variable's real address.
/// Splits `fnName`'s chunk further, by variable/parameter entry, for the
/// same cross-entry-mismatch reason `findFunctionChunk` splits by
/// function: multiple formal_parameter/variable entries in one function
/// each have their own DW_OP_fbreg offset.
function getFbregOffset(fnName, varName) {
  const chunk = findFunctionChunk(fnName)
    .split(/DW_TAG_(?:formal_parameter|variable)/)
    .find((c) => new RegExp(`DW_AT_name\\s*\\("${varName}"\\)`).test(c));
  const match = chunk && chunk.match(/DW_AT_location\s*\(DW_OP_fbreg \+(\d+)\)/);
  if (!match) throw new Error(`could not find DW_OP_fbreg offset for "${varName}" in "${fnName}"`);
  return parseInt(match[1], 10);
}

// lldb-wasm-reactor.wasm reads the target module's own file bytes (to
// parse ObjectFile/DWARF) through its own WASI filesystem, same as any
// other lldb source-reading path in this project -- not through
// read_memory/write_memory, which are for a live process's *runtime*
// memory only. Preopen the temp dir so `/work/add.wasm` is visible to it.
const preopens = { '/work': workDir };

const bytes = await readFile(reactorPath);
console.error(`Loaded ${bytes.length} bytes, compiling wasm module...`);
const wasmModule = await WebAssembly.compile(bytes);

const wasi = new WASI({ version: 'preview1', args: ['lldb-wasm-reactor'], env: {}, preopens });

// Backs read_memory once the format_value tests below install a synthetic
// memory image; empty until then, so a call before that (or an address
// outside every installed region) fails loudly instead of silently
// returning garbage. Multiple regions, one per synthetic frame, since
// each frame's locals live at a different (arbitrary) base address.
const syntheticMemoryRegions = []; // { base: number, bytes: Uint8Array }[]

const wasmDbgImports = {
  read_memory(addr, bufPtr, size) {
    addr = Number(addr);
    const region = syntheticMemoryRegions.find((r) =>
      addr >= r.base && addr + size <= r.base + r.bytes.length);
    if (!region)
      throw new Error(`unexpected read_memory(0x${addr.toString(16)}, size=${size}) -- outside every installed synthetic memory region`);
    mem8().set(region.bytes.subarray(addr - region.base, addr - region.base + size), bufPtr);
    return size;
  },
  write_memory() { throw new Error('unexpected write_memory call in this smoketest'); },
};
const importObjectBase = { ...wasi.getImportObject(), wasm_dbg: wasmDbgImports };

console.error('Instantiating...');
// Every spawned worker thread re-instantiates its own copy of this module
// (see wasi_thread_worker.mjs) and so needs to satisfy the same `wasm_dbg`
// import surface the main instance does -- see wasi_thread_hook.mjs's
// makeThreadSpawn doc comment and documents/remaining_work.md's
// 2026-09-09 entry for why omitting this hangs `task_group.wait()`
// forever instead of failing loudly.
const extraImportsModule = new URL('./lldb_wasm_reactor_dbg_imports.mjs', import.meta.url).href;
const { instance, memory } = await instantiateThreaded(
  wasmModule, bytes, importObjectBase, { wasmPath: reactorPath, preopens, extraImportsModule });
// This is a reactor module (`-mexec-model=reactor`, see the CMakeLists
// comment): no `_start`, initialize via `_initialize` instead --
// makeFakeInstance's forThread:true strips `_start` for exactly this
// reason (see wasi_thread_hook.mjs's file header), even though this
// isn't a spawned thread.
const fakeInstance = makeFakeInstance(instance, memory, { forThread: true });
wasi.initialize(fakeInstance);
console.error('Initialized.');

const exp = instance.exports;
const mem8 = () => new Uint8Array(memory.buffer);

/// Writes a NUL-terminated copy of `str` into a freshly wasm_dbg_alloc'd
/// buffer; caller must wasm_dbg_free() the returned pointer.
function allocCString(str) {
  const encoded = new TextEncoder().encode(str + '\0');
  const ptr = exp.wasm_dbg_alloc(encoded.length);
  if (!ptr) throw new Error(`wasm_dbg_alloc(${encoded.length}) failed`);
  mem8().set(encoded, ptr);
  return ptr;
}

/// Writes `values` as a native-endian uint32 array into a freshly
/// wasm_dbg_alloc'd buffer; caller must wasm_dbg_free() the returned
/// pointer. An empty array still allocates 1 byte -- wasm_dbg_alloc(0) is
/// not a case worth relying on being well-defined.
function allocUint32Array(values) {
  const ptr = exp.wasm_dbg_alloc(Math.max(1, values.length * 4));
  if (!ptr) throw new Error('wasm_dbg_alloc for uint32 array failed');
  new Uint32Array(memory.buffer, ptr, values.length).set(values);
  return ptr;
}

/// Same as `allocUint32Array`, but for a uint64 (BigInt) array.
function allocUint64Array(values) {
  const ptr = exp.wasm_dbg_alloc(Math.max(1, values.length * 8));
  if (!ptr) throw new Error('wasm_dbg_alloc for uint64 array failed');
  new BigUint64Array(memory.buffer, ptr, values.length).set(values);
  return ptr;
}

/// Reads a NUL-terminated string out of guest memory at `ptr`.
function readCString(ptr, maxLen) {
  const bytes = mem8();
  let end = ptr;
  while (end < ptr + maxLen && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(ptr, end));
}

/// Calls `wasm_dbg_resolve_pc`/`wasm_dbg_format_value`/
/// `wasm_dbg_get_backtrace`-shaped functions that write into a
/// caller-supplied `(buf, size)` and return the untruncated length
/// (snprintf convention) -- allocates the output buffer, calls `fn`, and
/// returns the decoded string (or throws if `fn` returned negative).
function callWithOutBuf(fn, ...args) {
  const bufSize = 4096;
  const outPtr = exp.wasm_dbg_alloc(bufSize);
  if (!outPtr) throw new Error('wasm_dbg_alloc for output buffer failed');
  try {
    const len = fn(...args, outPtr, bufSize);
    if (len < 0)
      throw new Error(`call failed, returned ${len}: ${getLastError()}`);
    return readCString(outPtr, Math.min(len, bufSize - 1));
  } finally {
    exp.wasm_dbg_free(outPtr);
  }
}

/// Reads wasm_dbg_get_last_error()'s detail for the most recent failed call.
function getLastError() {
  const bufSize = 4096;
  const outPtr = exp.wasm_dbg_alloc(bufSize);
  if (!outPtr) return '<wasm_dbg_alloc failed while reading last error>';
  try {
    const len = exp.wasm_dbg_get_last_error(outPtr, bufSize);
    return len > 0 ? readCString(outPtr, Math.min(len, bufSize - 1)) : '<no detail>';
  } finally {
    exp.wasm_dbg_free(outPtr);
  }
}

let ok = true;

console.error('wasm_dbg_init()...');
const initRc = exp.wasm_dbg_init();
console.error(`  -> ${initRc}`);
ok &&= initRc === 0;

if (ok) {
  const targetPathPtr = allocCString('/work/add.wasm');
  console.error('wasm_dbg_create_target("/work/add.wasm")...');
  const createRc = exp.wasm_dbg_create_target(targetPathPtr);
  exp.wasm_dbg_free(targetPathPtr);
  console.error(`  -> ${createRc}${createRc !== 0 ? ` (${getLastError()})` : ''}`);
  ok &&= createRc === 0;
}

let addAddr, callerAddr;
if (ok) {
  addAddr = getLowPc('add');
  callerAddr = getLowPc('caller');
  console.error(`add() is at DWARF low_pc 0x${addAddr.toString(16)}, caller() at 0x${callerAddr.toString(16)}`);
}

if (ok) {
  console.error(`wasm_dbg_resolve_pc(0x${addAddr.toString(16)})...`);
  const resolved = callWithOutBuf(exp.wasm_dbg_resolve_pc, BigInt(addAddr));
  console.error(`  -> "${resolved}"`);
  // Expect "add.c:1" (add()'s opening brace line) or at least the function
  // name if line-table resolution didn't land exactly on the entry byte.
  ok &&= resolved.includes('add.c') || resolved.includes('add');
}

// --- Two-level shadow call stack: real DW_OP_fbreg + memory-read +
// DataFormatters decoding, real UnwindWasmMemory frame enumeration, and a
// real backtrace -- against a synthetic (not actually executed) memory
// image and per-frame frame-base values. Frame 0 (innermost) is add(),
// stopped a few bytes past its entry (past its prologue, comfortably
// inside the range DWARF says the function -- and so its locals' lexical
// scope -- covers); frame 1 is caller(), "stopped" at the point it called
// add() from.
//
// KNOWN FAILING as of 2026-09-09 (see documents/remaining_work.md): this
// is expected to fail resolving anything in frame 1 (caller(), the third
// DWARF-covered function in the module) -- a real, separate bug in
// address/symbol resolution for the third-and-later function in a
// multi-function wasm module, confirmed unrelated to the
// ProcessWasmMemory/UnwindWasmMemory work this test otherwise exercises
// (even a bare wasm_dbg_resolve_pc() call on one of caller()'s own
// addresses, bypassing StackFrame/Unwind entirely, resolves to the wrong
// function). Wrapped in try/catch so that known, already-understood
// failure is reported cleanly rather than crashing the whole script.
try {
  const cOffset = getFbregOffset('add', 'c');
  const xOffset = getFbregOffset('caller', 'x');
  console.error(`local "c" in add() is at DW_OP_fbreg +${cOffset}; parameter "x" in caller() is at +${xOffset}`);

  // Arbitrary, distinct base addresses -- a real frame-base value is just
  // some address in linear memory, so any values work as long as
  // read_memory serves consistent bytes relative to them.
  const addFrameBase = 0x10000;
  const callerFrameBase = 0x20000;
  // Big enough to cover a full MemoryCache cache-line read (LLDB reads in
  // fixed-size chunks around the requested address, not just the exact
  // bytes asked for -- confirmed empirically, a real 512-byte L2 cache
  // line request for a single 4-byte int).
  const imageSize = 4096;

  // Synthetic values -- unrelated to what a real run of caller(1) would
  // actually compute (see the file header: nothing here executes the
  // program for real), just known values to check the formatted output
  // against.
  const addImage = new Uint8Array(imageSize);
  new DataView(addImage.buffer).setInt32(cOffset, 3, /*littleEndian=*/true); // add()'s own local c
  const callerImage = new Uint8Array(imageSize);
  new DataView(callerImage.buffer).setInt32(xOffset, 1, /*littleEndian=*/true); // caller()'s own parameter x
  syntheticMemoryRegions.push({ base: addFrameBase, bytes: addImage });
  syntheticMemoryRegions.push({ base: callerFrameBase, bytes: callerImage });

  // eWasmTagLocal (see Utility/WasmVirtualRegisters.h) local index 2 is
  // whichever synthetic wasm local this compile happened to assign
  // DW_AT_frame_base to -- confirmed to be local 2 for both functions in
  // this exact source (see documents/design.md's frame-base note); a real
  // embedder reads this off each frame's own DW_OP_WASM_location itself
  // rather than hardcoding it.
  const framePcs = [addAddr + 5, callerAddr + 5];
  const localFrameIndices = [0, 1]; // both frames' frame-base local
  const localWasmIndices = [2, 2];
  const localValues = [BigInt(addFrameBase), BigInt(callerFrameBase)];

  const framePcsPtr = allocUint64Array(framePcs.map(BigInt));
  const localFrameIndicesPtr = allocUint32Array(localFrameIndices);
  const localWasmIndicesPtr = allocUint32Array(localWasmIndices);
  const localValuesPtr = allocUint64Array(localValues);
  console.error(`wasm_dbg_set_stop(frames=[0x${framePcs[0].toString(16)}, 0x${framePcs[1].toString(16)}])...`);
  exp.wasm_dbg_set_stop(framePcsPtr, framePcs.length, localFrameIndicesPtr,
    localWasmIndicesPtr, localValuesPtr, localValues.length);
  exp.wasm_dbg_free(framePcsPtr);
  exp.wasm_dbg_free(localFrameIndicesPtr);
  exp.wasm_dbg_free(localWasmIndicesPtr);
  exp.wasm_dbg_free(localValuesPtr);

  console.error('wasm_dbg_get_backtrace()...');
  const backtrace = callWithOutBuf(exp.wasm_dbg_get_backtrace);
  console.error(`  -> \n${backtrace}`);
  const btLines = backtrace.split('\n');
  ok &&= btLines.length === 2 &&
    (btLines[0].includes('add.c') || btLines[0].includes('add')) &&
    (btLines[1].includes('add.c') || btLines[1].includes('caller'));

  console.error('wasm_dbg_format_value(frame=0, "c")...'); // innermost: add()'s own local
  const exprC = allocCString('c');
  const formattedC = callWithOutBuf(exp.wasm_dbg_format_value, 0, exprC);
  exp.wasm_dbg_free(exprC);
  console.error(`  -> "${formattedC}"`);
  // Real ValueObject::Dump() output includes the name/type, not just the
  // bare value (e.g. "(int) c = 3") -- check for the value landing
  // somewhere in it rather than assuming the exact format.
  ok &&= /\b3\b/.test(formattedC);

  console.error('wasm_dbg_format_value(frame=1, "x")...'); // caller()'s own parameter -- the actual point of testing a non-innermost frame
  const exprX = allocCString('x');
  const formattedX = callWithOutBuf(exp.wasm_dbg_format_value, 1, exprX);
  exp.wasm_dbg_free(exprX);
  console.error(`  -> "${formattedX}"`);
  ok &&= /\b1\b/.test(formattedX);
} catch (e) {
  console.error(`Backtrace/frame-1 section failed (expected -- see the KNOWN FAILING note above): ${e.message}`);
  ok = false;
}

await rm(workDir, { recursive: true, force: true });
console.error(ok ? 'SMOKETEST PASSED' : 'SMOKETEST FAILED');
process.exit(ok ? 0 : 1);
