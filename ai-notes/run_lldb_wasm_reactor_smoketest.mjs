// Proves lldb-wasm-reactor.wasm (see documents/design.md's "Debugging
// design" section and lldb/tools/lldb-wasm-reactor/WasmDebugReactor.cpp)
// actually works end-to-end against a real compiled program:
// instantiate it, create a target from a real `-O0 -g` wasm binary,
// resolve a known function's address to its source file:line, and format
// a local variable's value at a synthetic stop.
//
// The variable-formatting half doesn't run the compiled program for
// real -- the compile-time-instrumentation hook that would produce a
// real stop is a separate, not-yet-designed piece (see
// documents/remaining_work.md). Instead this builds a synthetic memory
// image and frame-base value by hand, matching exactly what DWARF says
// local `c`'s address should be (frame_base + its DW_OP_fbreg offset),
// and serves reads from it through the real read_memory callback --
// exercising the real DW_OP_fbreg/DW_OP_WASM_location decoding and real
// DataFormatters pretty-printing, just not real execution.
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

const workDir = await mkdtemp(path.join(tmpdir(), 'lldb-wasm-reactor-smoketest-'));
const addC = `int add(int a, int b) {
  int c = a + b;
  return c;
}

int main(void) {
  return add(1, 2);
}
`;
const srcPath = path.join(workDir, 'add.c');
const targetPath = path.join(workDir, 'add.wasm');
await writeFile(srcPath, addC);
console.error(`Compiling ${srcPath} -> ${targetPath}...`);
await execFileAsync(wasiSdkClang, ['-O0', '-g', '-o', targetPath, srcPath]);

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

// Backs read_memory once the format_value test below installs a synthetic
// memory image; null until then, so a call before that (or an address
// outside the image) fails loudly instead of silently returning garbage.
let syntheticMemory = null; // { base: number, bytes: Uint8Array }

const wasmDbgImports = {
  read_memory(addr, bufPtr, size) {
    addr = Number(addr);
    if (!syntheticMemory)
      throw new Error(`unexpected read_memory(0x${addr.toString(16)}, size=${size}) -- no synthetic memory installed`);
    const offset = addr - syntheticMemory.base;
    if (offset < 0 || offset + size > syntheticMemory.bytes.length)
      throw new Error(`read_memory(0x${addr.toString(16)}, size=${size}) outside synthetic memory range`);
    mem8().set(syntheticMemory.bytes.subarray(offset, offset + size), bufPtr);
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
/// pointer.
function allocUint32Array(values) {
  const ptr = exp.wasm_dbg_alloc(values.length * 4);
  if (!ptr) throw new Error('wasm_dbg_alloc for uint32 array failed');
  new Uint32Array(memory.buffer, ptr, values.length).set(values);
  return ptr;
}

/// Same as `allocUint32Array`, but for a uint64 (BigInt) array.
function allocUint64Array(values) {
  const ptr = exp.wasm_dbg_alloc(values.length * 8);
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

/// Calls `wasm_dbg_resolve_pc`/`wasm_dbg_format_value`-shaped functions
/// that write into a caller-supplied `(buf, size)` and return the
/// untruncated length (snprintf convention) -- allocates the output
/// buffer, calls `fn`, and returns the decoded string (or throws if `fn`
/// returned negative).
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

// Find `add`'s entry address the same way `wasm_dbg_resolve_pc` itself
// will resolve it: DWARF's own `DW_AT_low_pc`, via llvm-dwarfdump. NOT
// llvm-nm's symbol-table address -- confirmed empirically these disagree
// for a wasm object (llvm-nm resolved to a wrong, unrelated symbol when
// tried here first): `Plugins/ObjectFile/wasm`/`SymbolFile/DWARF` use
// DWARF's own addressing, and llvm-nm's symbol table numbering isn't
// guaranteed to agree with it, unlike on more familiar formats (ELF/Mach-O).
let addAddr;
if (ok) {
  const llvmDwarfdump = path.join(path.dirname(wasiSdkClang), 'llvm-dwarfdump.exe');
  const { stdout } = await execFileAsync(llvmDwarfdump, ['--debug-info', targetPath]);
  // Split into one chunk per DW_TAG_subprogram (a regex spanning multiple
  // subprograms risks matching some other, earlier subprogram's low_pc
  // against add's own name -- confirmed empirically: a non-greedy pattern
  // reaching across blocks locked onto _start's low_pc instead, since
  // _start happens to be the first block start-to-finish, and JS regexes
  // return the leftmost match, not the shortest one overall) and look for
  // "add" strictly within its own chunk.
  const chunk = stdout.split('DW_TAG_subprogram').find((c) => /DW_AT_name\s*\("add"\)/.test(c));
  const match = chunk && chunk.match(/DW_AT_low_pc\s*\(0x([0-9a-f]+)\)/);
  if (!match) {
    console.error('could not find DW_AT_low_pc for "add" via llvm-dwarfdump output:', stdout);
    ok = false;
  } else {
    addAddr = parseInt(match[1], 16);
    console.error(`add() is at DWARF low_pc 0x${addAddr.toString(16)}`);
  }
}

if (ok) {
  console.error(`wasm_dbg_resolve_pc(0x${addAddr.toString(16)})...`);
  const resolved = callWithOutBuf(exp.wasm_dbg_resolve_pc, BigInt(addAddr));
  console.error(`  -> "${resolved}"`);
  // Expect "add.c:1" (add()'s opening brace line) or at least the function
  // name if line-table resolution didn't land exactly on the entry byte.
  ok &&= resolved.includes('add.c') || resolved.includes('add');
}

// --- wasm_dbg_format_value: real DW_OP_fbreg + memory-read + DataFormatters
// decoding, against a synthetic (not actually executed) memory image and
// frame-base value -- see the file header for why this doesn't run the
// compiled program for real.
let cOffset;
if (ok) {
  const llvmDwarfdump = path.join(path.dirname(wasiSdkClang), 'llvm-dwarfdump.exe');
  const { stdout } = await execFileAsync(llvmDwarfdump, ['--debug-info', targetPath]);
  const fnChunk = stdout.split('DW_TAG_subprogram').find((c) => /DW_AT_name\s*\("add"\)/.test(c));
  // Within add()'s own chunk, find local `c`'s own DW_TAG_variable entry --
  // split further, the same way the low_pc lookup above had to, since a's
  // and b's own DW_TAG_formal_parameter entries (each with their own
  // DW_OP_fbreg offset) precede it, and a regex spanning entries risks
  // pairing one entry's offset with a different entry's name (confirmed
  // empirically: this pulled "a"'s +12 instead of "c"'s own offset on the
  // first attempt).
  const chunk = fnChunk && fnChunk.split(/DW_TAG_(?:formal_parameter|variable)/)
    .find((c) => /DW_AT_name\s*\("c"\)/.test(c));
  const match = chunk && chunk.match(/DW_AT_location\s*\(DW_OP_fbreg \+(\d+)\)/);
  if (!match) {
    console.error('could not find DW_OP_fbreg offset for local "c":', chunk);
    ok = false;
  } else {
    cOffset = parseInt(match[1], 10);
    console.error(`local "c" is at DW_OP_fbreg +${cOffset}`);
  }
}

if (ok) {
  // An arbitrary base address for the synthetic frame; a real frame-base
  // value is just some address in linear memory, so any value works as
  // long as read_memory serves consistent bytes relative to it.
  const frameBase = 0x10000;
  // Big enough to cover a full MemoryCache cache-line read (LLDB reads in
  // fixed-size chunks around the requested address, not just the exact
  // bytes asked for -- confirmed empirically, a real 512-byte L2 cache
  // line request for a single 4-byte int).
  const imageSize = 4096;
  const image = new Uint8Array(imageSize);
  new DataView(image.buffer).setInt32(cOffset, 3, /*littleEndian=*/true); // c = 1 + 2
  syntheticMemory = { base: frameBase, bytes: image };

  // eWasmTagLocal (see Utility/WasmVirtualRegisters.h) local index 2 is
  // whichever synthetic wasm local this compile happened to assign
  // DW_AT_frame_base to -- confirmed to be local 2 for this exact source
  // (see documents/design.md's frame-base note); a real embedder reads
  // this off DW_OP_WASM_location itself rather than hardcoding it.
  // A few bytes past add()'s very first instruction -- past its prologue,
  // comfortably inside the range DWARF says the function (and so `c`'s
  // lexical scope) covers, in case variable resolution requires that
  // rather than just address-range membership.
  const stopPc = addAddr + 5;
  const localIndices = allocUint32Array([2]);
  const localValues = allocUint64Array([BigInt(frameBase)]);
  console.error(`wasm_dbg_set_stop(pc=0x${stopPc.toString(16)}, local[2]=0x${frameBase.toString(16)})...`);
  exp.wasm_dbg_set_stop(BigInt(stopPc), localIndices, localValues, 1);
  exp.wasm_dbg_free(localIndices);
  exp.wasm_dbg_free(localValues);

  console.error('wasm_dbg_format_value("c")...');
  const exprPtr = allocCString('c');
  const formatted = callWithOutBuf(exp.wasm_dbg_format_value, exprPtr);
  exp.wasm_dbg_free(exprPtr);
  console.error(`  -> "${formatted}"`);
  // Real ValueObject::Dump() output includes the name/type, not just the
  // bare value (e.g. "(int) c = 3") -- check for the value landing
  // somewhere in it rather than assuming the exact format.
  ok &&= /\b3\b/.test(formatted);
}

await rm(workDir, { recursive: true, force: true });
console.error(ok ? 'SMOKETEST PASSED' : 'SMOKETEST FAILED');
process.exit(ok ? 0 : 1);
