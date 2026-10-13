// Proves lldb-wasm-reactor.wasm still maps PCs to source lines and formats locals correctly for code compiled
// with C++ exceptions (`-O0 -g -fwasm-exceptions`): try bodies, catch handlers and landing pads.
//
// Same approach as run_lldb_wasm_reactor_smoketest.mjs (read its header first): the program is never executed; a
// synthetic memory image and shadow stack stand in for a real stop. Two checks:
//   1. Every is_stmt row of the program's DWARF line table must resolve (wasm_dbg_resolve_pc) to its own line, which
//      covers the code the compiler emits for try/catch/throw (including landing pads).
//   2. With a synthetic stop inside the catch handler (frames: guarded() <- main()), locals declared in the handler
//      (`handled`, and `e.code` through the `const Err&` catch parameter) and in the try-enclosing function
//      (`result`) format to the planted values, and a three-deep stop through thrower() backtraces correctly.
//
// Usage:
//   node --experimental-wasm-type-reflection --experimental-wasi-unstable-preview1 \
//     wasi-tests/run_lldb_wasm_reactor_eh_smoketest.mjs [path-to-lldb-wasm-reactor.wasm] [path-to-wasi-sdk-clang++]
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
const wasiSdkClangXX = processArgv[3] ??
  'C:/Users/mooin/AppData/Local/wasi-sdk/wasi-sdk-34.0-x86_64-windows/bin/clang++.exe';
const llvmDwarfdump = path.join(path.dirname(wasiSdkClangXX), 'llvm-dwarfdump.exe');

const workDir = await mkdtemp(path.join(tmpdir(), 'lldb-wasm-reactor-eh-smoketest-'));
// Line numbers matter: the checks below refer to them.
const ehCpp = `struct Err { int code; };

int thrower(int n) {
  if (n > 2)
    throw Err{n};
  return n;
}

int guarded(int n) {
  int result = 0;
  try {
    result = thrower(n);
  } catch (const Err& e) {
    int handled = e.code * 2;
    result = handled;
  }
  return result;
}

int main() {
  return guarded(5);
}
`;
const srcPath = path.join(workDir, 'eh.cpp');
const targetPath = path.join(workDir, 'eh.wasm');
await writeFile(srcPath, ehCpp);
console.error(`Compiling ${srcPath} -> ${targetPath}...`);
await execFileAsync(wasiSdkClangXX, ['--target=wasm32-wasip1', '-O0', '-g', '-fwasm-exceptions',
  '-Wl,--export=__stack_pointer', '-o', targetPath, srcPath, '-lunwind']);

// The linked binary also carries libc++abi/libunwind DWARF, so the dumps are large.
const dumpOpts = { maxBuffer: 512 * 1024 * 1024 };
const { stdout: dwarfDump } = await execFileAsync(llvmDwarfdump, ['--debug-info', targetPath], dumpOpts);
const { stdout: fullLineDump } = await execFileAsync(llvmDwarfdump, ['--debug-line', targetPath], dumpOpts);
// Only eh.cpp's own line table; the library units' rows would otherwise be mixed in.
const lineDump = fullLineDump.split(/^debug_line\[/m).find((t) => /eh\.cpp/.test(t.split('Address')[0])) ?? '';
if (!lineDump) throw new Error('could not find the eh.cpp line table in llvm-dwarfdump --debug-line output');

function findFunctionChunk(fnName) {
  const chunk = dwarfDump.split('DW_TAG_subprogram')
    .find((c) => new RegExp(`DW_AT_name\\s*\\("${fnName}"\\)`).test(c));
  if (!chunk) throw new Error(`could not find DW_TAG_subprogram for "${fnName}" via llvm-dwarfdump output`);
  return chunk;
}
function getLowPc(fnName) {
  const match = findFunctionChunk(fnName).match(/DW_AT_low_pc\s*\(0x([0-9a-f]+)\)/);
  if (!match) throw new Error(`could not find DW_AT_low_pc for "${fnName}"`);
  return parseInt(match[1], 16);
}
function getFrameBaseLocal(fnName) {
  const match = findFunctionChunk(fnName).match(/DW_AT_frame_base\s*\(DW_OP_WASM_location 0x0 0x([0-9a-f]+)/);
  if (!match) throw new Error(`could not find a local-based DW_AT_frame_base for "${fnName}"`);
  return parseInt(match[1], 16);
}
/// `varName`'s DW_OP_fbreg offset within `fnName`; variables nested in lexical blocks (a catch handler's locals)
/// are still inside the function's chunk, so the same split works.
function getFbregOffset(fnName, varName) {
  const chunk = findFunctionChunk(fnName)
    .split(/DW_TAG_(?:formal_parameter|variable)/)
    .find((c) => new RegExp(`DW_AT_name\\s*\\("${varName}"\\)`).test(c));
  const match = chunk && chunk.match(/DW_AT_location\s*\(DW_OP_fbreg (-?\+?\d+)\)/);
  if (!match) throw new Error(`could not find DW_OP_fbreg offset for "${varName}" in "${fnName}"`);
  return parseInt(match[1], 10);
}

/// Line-table rows for eh.cpp as address -> Set(lines), is_stmt rows only (end_sequence rows excluded).
function parseLineRows() {
  const byAddr = new Map();
  for (const m of lineDump.matchAll(/^0x([0-9a-f]+)[ 	]+(\d+)[ 	]+\d+[ 	]+\d+[ 	]+\d+[ 	]+\d+[ 	]+\d+[ 	]*(.*)$/gm)) {
    const flags = m[3];
    if (!/is_stmt/.test(flags) || /end_sequence/.test(flags)) continue;
    const addr = parseInt(m[1], 16);
    if (!byAddr.has(addr)) byAddr.set(addr, new Set());
    byAddr.get(addr).add(Number(m[2]));
  }
  return byAddr;
}

const preopens = { '/work': workDir };
const bytes = await readFile(reactorPath);
console.error(`Loaded ${bytes.length} bytes, compiling wasm module...`);
const wasmModule = await WebAssembly.compile(bytes);
const wasi = new WASI({ version: 'preview1', args: ['lldb-wasm-reactor'], env: {}, preopens });

const syntheticMemoryRegions = []; // { base: number, bytes: Uint8Array }[]
const wasmDbgImports = {
  read_memory(addr, bufPtr, size) {
    addr = Number(addr);
    const region = syntheticMemoryRegions.find((r) => addr >= r.base && addr + size <= r.base + r.bytes.length);
    if (!region)
      throw new Error(`unexpected read_memory(0x${addr.toString(16)}, size=${size}) -- outside every installed synthetic memory region`);
    mem8().set(region.bytes.subarray(addr - region.base, addr - region.base + size), bufPtr);
    return size;
  },
  write_memory() { throw new Error('unexpected write_memory call in this smoketest'); },
};
const importObjectBase = { ...wasi.getImportObject(), wasm_dbg: wasmDbgImports };

console.error('Instantiating...');
const extraImportsModule = new URL('./lldb_wasm_reactor_dbg_imports.mjs', import.meta.url).href;
const isThreaded = WebAssembly.Module.imports(wasmModule).some((i) => i.name === 'thread-spawn');
console.error(isThreaded ? 'Threaded reactor.' : 'Single-threaded reactor.');
let instance, memory;
if (isThreaded) {
  ({ instance, memory } = await instantiateThreaded(
    wasmModule, bytes, importObjectBase, { wasmPath: reactorPath, preopens, extraImportsModule }));
} else {
  instance = await WebAssembly.instantiate(wasmModule, importObjectBase);
  memory = instance.exports.memory;
}
const fakeInstance = isThreaded ? makeFakeInstance(instance, memory, { forThread: true }) : instance;
wasi.initialize(fakeInstance);

const exp = instance.exports;
const mem8 = () => new Uint8Array(memory.buffer);

function allocCString(str) {
  const encoded = new TextEncoder().encode(str + '\0');
  const ptr = exp.wasm_dbg_alloc(encoded.length);
  if (!ptr) throw new Error(`wasm_dbg_alloc(${encoded.length}) failed`);
  mem8().set(encoded, ptr);
  return ptr;
}
function allocUint32Array(values) {
  const ptr = exp.wasm_dbg_alloc(Math.max(1, values.length * 4));
  if (!ptr) throw new Error('wasm_dbg_alloc for uint32 array failed');
  new Uint32Array(memory.buffer, ptr, values.length).set(values);
  return ptr;
}
function allocUint64Array(values) {
  const ptr = exp.wasm_dbg_alloc(Math.max(1, values.length * 8));
  if (!ptr) throw new Error('wasm_dbg_alloc for uint64 array failed');
  new BigUint64Array(memory.buffer, ptr, values.length).set(values);
  return ptr;
}
function readCString(ptr, maxLen) {
  const b = mem8();
  let end = ptr;
  while (end < ptr + maxLen && b[end] !== 0) end++;
  return new TextDecoder().decode(b.subarray(ptr, end));
}
function getLastError() {
  const outPtr = exp.wasm_dbg_alloc(4096);
  if (!outPtr) return '<wasm_dbg_alloc failed while reading last error>';
  try {
    const len = exp.wasm_dbg_get_last_error(outPtr, 4096);
    return len > 0 ? readCString(outPtr, Math.min(len, 4095)) : '<no detail>';
  } finally { exp.wasm_dbg_free(outPtr); }
}
function callWithOutBuf(fn, ...args) {
  const outPtr = exp.wasm_dbg_alloc(4096);
  if (!outPtr) throw new Error('wasm_dbg_alloc for output buffer failed');
  try {
    const len = fn(...args, outPtr, 4096);
    if (len < 0) throw new Error(`call failed, returned ${len}: ${getLastError()}`);
    return readCString(outPtr, Math.min(len, 4095));
  } finally { exp.wasm_dbg_free(outPtr); }
}
function setStop(framePcs, frameBases, fnNames) {
  const pcs = allocUint64Array(framePcs.map(BigInt));
  const idx = allocUint32Array(frameBases.map((_, i) => i));
  const wasmIdx = allocUint32Array(fnNames.map(getFrameBaseLocal));
  const vals = allocUint64Array(frameBases.map(BigInt));
  exp.wasm_dbg_set_stop(pcs, framePcs.length, idx, wasmIdx, vals, frameBases.length);
  for (const p of [pcs, idx, wasmIdx, vals]) exp.wasm_dbg_free(p);
}
function formatValue(frame, expr) {
  const e = allocCString(expr);
  try { return callWithOutBuf(exp.wasm_dbg_format_value, frame, e); } finally { exp.wasm_dbg_free(e); }
}

let ok = true;
function check(name, cond, detail = '') {
  console.error(`${cond ? 'PASS' : 'FAIL'}: ${name}${cond ? '' : ` -- ${detail}`}`);
  ok &&= cond;
}

check('wasm_dbg_init', exp.wasm_dbg_init() === 0);
{
  const p = allocCString('/work/eh.wasm');
  const rc = exp.wasm_dbg_create_target(p);
  exp.wasm_dbg_free(p);
  check('wasm_dbg_create_target', rc === 0, getLastError());
  ok &&= rc === 0;
}

if (ok) {
  // 1. Every is_stmt line-table row resolves to its own line (skipping addresses that several rows share, where
  // either line is a legitimate answer).
  const rows = parseLineRows();
  let checked = 0;
  const bad = [];
  for (const [addr, lines] of rows) {
    if (lines.size !== 1) continue;
    const [line] = lines;
    const resolved = callWithOutBuf(exp.wasm_dbg_resolve_pc, BigInt(addr));
    checked++;
    if (!new RegExp(`eh\\.cpp:${line}\\b`).test(resolved)) bad.push(`0x${addr.toString(16)} want line ${line}, got "${resolved}"`);
  }
  console.error(`checked ${checked} line-table addresses`);
  check('line-table addresses resolve to their own lines', checked >= 12 && bad.length === 0, bad.slice(0, 5).join('; '));
  // Spot-check the lines that exist only because of exception handling.
  const linesSeen = new Set([...rows.values()].flatMap((s) => [...s]));
  for (const [what, line] of [['throw', 5], ['try body call', 12], ['catch handler local', 15], ['catch handler store', 16]])
    check(`line table has a row for the ${what} (line ${line})`, linesSeen.has(line), `lines: ${[...linesSeen].sort((a, b) => a - b)}`);
}

if (ok) {
  try {
    const guardedPc = getLowPc('guarded');
    const throwerPc = getLowPc('thrower');
    const mainPc = getLowPc('main');
    // PC of the first row for line 16 (`result = handled;`, inside the catch handler).
    const rows = parseLineRows();
    const catchPc = [...rows].filter(([, l]) => l.has(16)).map(([a]) => a).sort((a, b) => a - b)[0];
    check('found a PC inside the catch handler', catchPc !== undefined && catchPc > guardedPc);

    const handledOff = getFbregOffset('guarded', 'handled');
    const resultOff = getFbregOffset('guarded', 'result');
    const eOff = getFbregOffset('guarded', 'e');
    const nOff = getFbregOffset('thrower', 'n');
    console.error(`fbreg offsets: handled ${handledOff}, result ${resultOff}, e ${eOff}, thrower.n ${nOff}`);

    const guardedBase = 0x30000, mainBase = 0x40000, throwerBase = 0x50000, errObjAddr = 0x60000;
    const img = () => new Uint8Array(4096);
    const guardedImg = img(), mainImg = img(), throwerImg = img(), errImg = img();
    const dv = (b) => new DataView(b.buffer);
    dv(guardedImg).setInt32(handledOff, 10, true);
    dv(guardedImg).setInt32(resultOff, 0, true);
    dv(guardedImg).setUint32(eOff, errObjAddr, true); // `const Err& e` is a pointer-sized slot
    dv(errImg).setInt32(0, 5, true); // Err::code
    dv(throwerImg).setInt32(nOff, 5, true);
    syntheticMemoryRegions.push(
      { base: guardedBase, bytes: guardedImg }, { base: mainBase, bytes: mainImg },
      { base: throwerBase, bytes: throwerImg }, { base: errObjAddr, bytes: errImg });

    // Stop inside the catch handler: guarded() <- main().
    setStop([catchPc, mainPc + 5], [guardedBase, mainBase], ['guarded', 'main']);
    const bt = callWithOutBuf(exp.wasm_dbg_get_backtrace).split('\n');
    console.error(`backtrace in catch handler:\n${bt.join('\n')}`);
    check('backtrace from the catch handler has 2 frames, innermost in guarded()',
      bt.length === 2 && /guarded|eh\.cpp:16/.test(bt[0]), bt.join(' | '));
    const handled = formatValue(0, 'handled');
    check('catch-handler local `handled` formats to 10', /\b10\b/.test(handled), handled);
    const result = formatValue(0, 'result');
    check('enclosing-function local `result` formats to 0', /\b0\b/.test(result), result);
    const eCode = formatValue(0, 'e.code');
    check('catch parameter `e.code` (through the reference) formats to 5', /\b5\b/.test(eCode), eCode);

    // Stop at the throw in thrower(), three deep: thrower() <- guarded() <- main().
    const throwPc = [...rows].filter(([, l]) => l.has(5)).map(([a]) => a).sort((a, b) => a - b)[0];
    const tryCallPc = [...rows].filter(([, l]) => l.has(12)).map(([a]) => a).sort((a, b) => a - b)[0];
    setStop([throwPc, tryCallPc, mainPc + 5], [throwerBase, guardedBase, mainBase], ['thrower', 'guarded', 'main']);
    const bt3 = callWithOutBuf(exp.wasm_dbg_get_backtrace).split('\n');
    console.error(`backtrace at the throw:\n${bt3.join('\n')}`);
    check('backtrace at the throw has 3 frames (thrower, guarded, main)',
      bt3.length === 3 && /eh\.cpp:5/.test(bt3[0]) && /eh\.cpp:12/.test(bt3[1]), bt3.join(' | '));
    const n = formatValue(0, 'n');
    check('thrower parameter `n` formats to 5', /\b5\b/.test(n), n);
    void throwerPc;
  } catch (e) {
    check('exception-stop section ran without error', false, e.stack ?? e.message);
  }
}

await rm(workDir, { recursive: true, force: true });
console.error(ok ? 'SMOKETEST PASSED' : 'SMOKETEST FAILED');
process.exit(ok ? 0 : 1);
