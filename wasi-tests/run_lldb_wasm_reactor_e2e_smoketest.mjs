// End-to-end "Debug build" proof for lldb-wasm-reactor.wasm: a real
// instrumented program runs, and at chosen hook firings the real hook
// arguments feed wasm_dbg_set_stop, whose backtrace and variable values are
// checked against what the program actually computed. Unlike
// run_lldb_wasm_reactor_smoketest.mjs (synthetic frame bases and memory),
// nothing here is faked: read_memory serves the *running target's* live
// WebAssembly.Memory, frame bases are the real `__stack_pointer` global
// (exported via -Wl,--export=__stack_pointer), and the shadow call stack is
// built exactly as documents/design.md describes (SP comparison between
// consecutive hook firings).
//
// The last section builds a second, straight-line target with
// trace-loads/trace-stores hooks to stop mid-function (statement granularity).
//
// Two findings this encodes (see documents/remaining_work.md "Hook
// granularity"):
//  - On wasm, -fsanitize-coverage=pc-table is empty (__sanitizer_cov_pcs_init
//    gets begin==end), and trace-pc-guard passes only a guard address, never
//    a PC. So the guard->PC map is derived statically from the linked binary
//    (each `i32.const <guard>; call <hook>` pair in `llvm-objdump -d`).
//  - Hooks fire per basic block, not per statement, and a caller frame's PC
//    is its *last hook firing*, not its call site: outer frames resolve to
//    the line of the caller's most recent block entry, not the call line.
//
// Usage:
//   node --experimental-wasm-type-reflection --experimental-wasi-unstable-preview1 \
//     wasi-tests/run_lldb_wasm_reactor_e2e_smoketest.mjs [path-to-lldb-wasm-reactor.wasm] [path-to-wasi-sdk-clang]
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { WASI } from 'node:wasi';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { argv as processArgv } from 'node:process';
import { instantiateThreaded, makeFakeInstance } from './wasi_thread_hook.mjs';
import { scanGuardSites, ShadowStack, captureWasmFrames, mergeFrames } from './sancov_host.mjs';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(import.meta.dirname, '..');
const reactorPath = processArgv[2] ??
  path.join(repoRoot, 'build-lldb', 'bin', 'lldb-wasm-reactor.wasm');
const wasiSdkClang = processArgv[3] ??
  'C:/Users/mooin/AppData/Local/wasi-sdk/wasi-sdk-34.0-x86_64-windows/bin/clang.exe';
const sdkBin = path.dirname(wasiSdkClang);
const llvmDwarfdump = path.join(sdkBin, 'llvm-dwarfdump.exe');
const llvmObjdump = path.join(sdkBin, 'llvm-objdump.exe');

const workDir = await mkdtemp(path.join(tmpdir(), 'lldb-wasm-reactor-e2e-'));

// `if` blocks give each function a basic block that starts *after* its
// locals are stored: a hook at function entry fires before `a`/`b`/`c` are
// written, so only a later block's hook can observe them.
const progC = `struct P { int x, y; };

int add(int a, int b) {
  int c = a + b;
  if (c > 100)
    c = 0;
  return c;
}

int caller(int x) {
  struct P p = { x, 2 };
  int y = add(p.x, p.y + 8);
  if (y > 100)
    y = 0;
  return y;
}

int main(void) {
  return caller(1);
}
`;
const srcPath = path.join(workDir, 'prog.c');
const targetPath = path.join(workDir, 'prog.wasm');
await writeFile(srcPath, progC);

/// 1-based [first, last] source line span of top-level function `fnName`.
function sourceSpan(fnName) {
  const lines = progC.split('\n');
  const first = lines.findIndex((l) => l.startsWith(`int ${fnName}(`));
  if (first < 0) throw new Error(`no top-level "int ${fnName}(" in test source`);
  const last = lines.findIndex((l, i) => i > first && l === '}');
  return [first + 1, last + 1];
}

console.error(`Compiling ${srcPath} -> ${targetPath}...`);
// The full "Debug" build link line. --allow-undefined leaves the sancov
// hooks as `env` imports for the host to satisfy.
await execFileAsync(wasiSdkClang, ['-O0', '-g', '-fsanitize-coverage=trace-pc-guard',
  '-Wl,--export=__stack_pointer', '-Wl,--allow-undefined', '-o', targetPath, srcPath]);

const targetBytes = await readFile(targetPath);
const targetModule = new WebAssembly.Module(targetBytes);
{
  const spExport = WebAssembly.Module.exports(targetModule).find((e) => e.name === '__stack_pointer');
  if (!spExport || spExport.kind !== 'global')
    throw new Error(`target did not export __stack_pointer as a global (got ${JSON.stringify(spExport)}); ` +
      'did you mean to pass -Wl,--export=__stack_pointer?');
}
const hookImportIndex = WebAssembly.Module.imports(targetModule)
  .filter((i) => i.kind === 'function')
  .findIndex((i) => i.module === 'env' && i.name === '__sanitizer_cov_trace_pc_guard');
if (hookImportIndex < 0)
  throw new Error('target does not import env.__sanitizer_cov_trace_pc_guard; did you mean to pass -fsanitize-coverage=trace-pc-guard?');

const { stdout: dwarfDump } = await execFileAsync(llvmDwarfdump, ['--debug-info', targetPath]);
const { stdout: objDump } = await execFileAsync(llvmObjdump, ['-d', targetPath], { maxBuffer: 64 << 20 });

// Split per DW_TAG_subprogram first, not one regex across the dump -- see
// run_lldb_wasm_reactor_smoketest.mjs's findFunctionChunk for why.
const parseSubprograms = (dump) => dump.split('DW_TAG_subprogram').slice(1).map((chunk) => {
  const name = chunk.match(/DW_AT_name\s*\("([^"]+)"\)/)?.[1];
  const low = chunk.match(/DW_AT_low_pc\s*\(0x([0-9a-f]+)\)/);
  const high = chunk.match(/DW_AT_high_pc\s*\(0x([0-9a-f]+)\)/);
  const fb = chunk.match(/DW_AT_frame_base\s*\(DW_OP_WASM_location 0x0 0x([0-9a-f]+)/);
  return { name, low: low && parseInt(low[1], 16), high: high && parseInt(high[1], 16),
    frameBaseLocal: fb && parseInt(fb[1], 16) };
}).filter((s) => s.name && s.low !== null && s.high !== null);
let subprograms = parseSubprograms(dwarfDump);

const subprogram = (name) => {
  const s = subprograms.find((x) => x.name === name);
  if (!s) throw new Error(`no DW_TAG_subprogram "${name}" with a pc range in the dwarfdump output`);
  return s;
};
const subprogramForPc = (pc) => subprograms.find((s) => pc >= s.low && pc < s.high);

// objdump prints file offsets; a DWARF code address is the offset from the
// start of the CODE section payload (objdump's `<CODE>` label). A function's
// own label points at its body-size LEB, 1-2 bytes before its DW_AT_low_pc.
const objFnAddr = new Map(); // objdump label name -> file offset
for (const m of objDump.matchAll(/^([0-9a-f]+) <([^>]+)>:/gm))
  objFnAddr.set(m[2], parseInt(m[1], 16));
if (!objFnAddr.has('CODE'))
  throw new Error(`objdump -d printed no <CODE> label (labels: ${[...objFnAddr.keys()].join(', ')})`);
const addrDelta = objFnAddr.get('CODE');
for (const [dwarfName, objName] of [['add', 'add'], ['caller', 'caller'], ['main', '__original_main']]) {
  if (!objFnAddr.has(objName))
    throw new Error(`objdump has no <${objName}> label (labels: ${[...objFnAddr.keys()].join(', ')})`);
  const gap = subprogram(dwarfName).low + addrDelta - objFnAddr.get(objName);
  if (gap < 1 || gap > 3)
    throw new Error(`${dwarfName}() DW_AT_low_pc + CODE offset is ${gap} bytes past its objdump label; expected 1-3 (the size LEB)`);
}
console.error(`objdump file offset - DWARF address = 0x${addrDelta.toString(16)} (the <CODE> section start; sanity-checked against add/caller/main)`);

// Oracle: guard address -> { pc (DWARF code address of the hook call), fn },
// from llvm-objdump. The real host can't shell out, so it uses sancov_host.mjs's
// scanGuardSites() on the raw bytes instead; the two must agree exactly.
const oracleGuardSites = new Map();
{
  const lines = objDump.split('\n');
  const insn = /^\s*([0-9a-f]+):\s+(?:[0-9a-f]{2} )+\s*(\S+)\s*(.*)$/;
  for (let i = 1; i < lines.length; i++) {
    const call = lines[i].match(insn);
    if (!call || call[2] !== 'call' || parseInt(call[3], 10) !== hookImportIndex) continue;
    // The guard address is either a lone `i32.const <addr>` (first guard) or
    // `i32.const <base>; i32.const <off>; i32.add` (the rest).
    const at = (k) => lines[i - k]?.match(insn);
    let guard;
    if (at(1)?.[2] === 'i32.const') guard = parseInt(at(1)[3], 10);
    else if (at(1)?.[2] === 'i32.add' && at(2)?.[2] === 'i32.const' && at(3)?.[2] === 'i32.const')
      guard = parseInt(at(3)[3], 10) + parseInt(at(2)[3], 10);
    else
      throw new Error(`hook call at 0x${call[1]} has an unrecognized guard-address sequence: ${JSON.stringify(lines.slice(i - 3, i + 1))}`);
    const pc = parseInt(call[1], 16) - addrDelta;
    const fn = subprogramForPc(pc);
    if (!fn) throw new Error(`guard call at DWARF address 0x${pc.toString(16)} is in no DW_TAG_subprogram`);
    oracleGuardSites.set(guard, { pc, fn: fn.name });
  }
}

let scan = scanGuardSites(targetBytes);
const guardSites = new Map([...scan.guardSites].map(([g, s]) => [g, { pc: s.pc, fn: subprogramForPc(s.pc).name, funcIndex: s.funcIndex }]));
const guardOrdinal = scan.ordinals; // 0-based ordinal of each guard within its function, in code order
console.error(`guard sites: ${[...guardSites].map(([g, s]) => `${g}->${s.fn}@0x${s.pc.toString(16)}`).join(', ')}`);
{
  const same = guardSites.size === oracleGuardSites.size &&
    [...oracleGuardSites].every(([g, o]) => guardSites.get(g)?.pc === o.pc && guardSites.get(g)?.fn === o.fn);
  if (!same) throw new Error(`scanGuardSites() disagrees with llvm-objdump: ${JSON.stringify([...guardSites])} vs ${JSON.stringify([...oracleGuardSites])}`);
  console.error(`  ok   scanGuardSites() matches the llvm-objdump oracle (${guardSites.size} guards)`);
}

// --- Load the reactor (same setup as run_lldb_wasm_reactor_smoketest.mjs).
const preopens = { '/work': workDir };
const reactorBytes = await readFile(reactorPath);
console.error(`Loaded ${reactorBytes.length} bytes, compiling reactor...`);
const reactorModule = await WebAssembly.compile(reactorBytes);
const reactorWasi = new WASI({ version: 'preview1', args: ['lldb-wasm-reactor'], env: {}, preopens });

let targetInstance = null; // set before the target runs; backs read_memory
const wasmDbgImports = {
  // Real hook->LLDB path: copy straight out of the live target's memory.
  read_memory(addr, bufPtr, size) {
    addr = Number(addr);
    if (!targetInstance) throw new Error(`read_memory(0x${addr.toString(16)}) with no running target`);
    const targetMem = new Uint8Array(targetInstance.exports.memory.buffer);
    if (addr + size > targetMem.length)
      throw new Error(`read_memory(0x${addr.toString(16)}, size=${size}) is past the end of the target's ${targetMem.length}-byte memory`);
    mem8().set(targetMem.subarray(addr, addr + size), bufPtr);
    return size;
  },
  write_memory() { throw new Error('unexpected write_memory call in this smoketest'); },
};
const extraImportsModule = new URL('./lldb_wasm_reactor_dbg_imports.mjs', import.meta.url).href;
const { instance, memory } = await instantiateThreaded(
  reactorModule, reactorBytes, { ...reactorWasi.getImportObject(), wasm_dbg: wasmDbgImports },
  { wasmPath: reactorPath, preopens, extraImportsModule });
reactorWasi.initialize(makeFakeInstance(instance, memory, { forThread: true }));
const exp = instance.exports;
const mem8 = () => new Uint8Array(memory.buffer);

function allocCString(str) {
  const encoded = new TextEncoder().encode(str + '\0');
  const ptr = exp.wasm_dbg_alloc(encoded.length);
  if (!ptr) throw new Error(`wasm_dbg_alloc(${encoded.length}) failed`);
  mem8().set(encoded, ptr);
  return ptr;
}
function allocTyped(Ctor, values) {
  const ptr = exp.wasm_dbg_alloc(Math.max(1, values.length * Ctor.BYTES_PER_ELEMENT));
  if (!ptr) throw new Error('wasm_dbg_alloc for typed array failed');
  new Ctor(memory.buffer, ptr, values.length).set(values);
  return ptr;
}
function readCString(ptr, maxLen) {
  const bytes = mem8();
  let end = ptr;
  while (end < ptr + maxLen && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(ptr, end));
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
function formatValue(frame, expr) {
  const p = allocCString(expr);
  try { return callWithOutBuf(exp.wasm_dbg_format_value, frame, p); }
  finally { exp.wasm_dbg_free(p); }
}

let ok = true;
const check = (cond, msg) => {
  console.error(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  ok &&= !!cond;
};

if (exp.wasm_dbg_init() !== 0) throw new Error('wasm_dbg_init failed');
{
  const p = allocCString('/work/prog.wasm');
  const rc = exp.wasm_dbg_create_target(p);
  exp.wasm_dbg_free(p);
  if (rc !== 0) throw new Error(`wasm_dbg_create_target failed: ${getLastError()}`);
}

// Every guard's PC must resolve into its own function's source lines.
for (const [g, s] of guardSites) {
  const resolved = callWithOutBuf(exp.wasm_dbg_resolve_pc, BigInt(s.pc));
  const line = Number(resolved.match(/prog\.c:(\d+)/)?.[1]);
  const [first, last] = sourceSpan(s.fn);
  check(line >= first && line <= last, `guard ${g} (${s.fn}#${guardOrdinal.get(g)}) @0x${s.pc.toString(16)} resolves to "${resolved}", inside ${s.fn}() lines ${first}-${last}`);
}

// --- Shadow call stack, built from the hook alone (documents/design.md).
let shadowStack = new ShadowStack(scan.guardSites);

/// Feeds the current stack to wasm_dbg_set_stop, exactly as a real host
/// would: PCs from the engine's stack trace (true call sites, not each
/// caller's last block entry), one frame-base local per frame valued with
/// that frame's SP from the shadow stack. Frames without a shadow entry (no
/// frame base) are left out.
function setStopFromShadowStack() {
  const trueFrames = captureWasmFrames(scan.module.codeStart);
  const frames = mergeFrames(trueFrames, shadowStack).filter((f) => f.sp !== null)
    .map((f) => ({ ...f, fn: subprogramForPc(f.pc).name }));
  const pcs = allocTyped(BigUint64Array, frames.map((f) => BigInt(f.pc)));
  const idx = allocTyped(Uint32Array, frames.map((_, i) => i));
  const wasmIdx = allocTyped(Uint32Array, frames.map((f) => {
    const local = subprogram(f.fn).frameBaseLocal;
    if (local === null) throw new Error(`${f.fn}() has no local-based DW_AT_frame_base`);
    return local;
  }));
  const vals = allocTyped(BigUint64Array, frames.map((f) => BigInt(f.sp)));
  exp.wasm_dbg_set_stop(pcs, frames.length, idx, wasmIdx, vals, frames.length);
  for (const p of [pcs, idx, wasmIdx, vals]) exp.wasm_dbg_free(p);
}

const lineOf = (btLine) => Number(btLine.match(/prog2?\.c:(\d+)/)?.[1]);
const lineOfText = (text) => progC.split(String.fromCharCode(10)).findIndex((l) => l.includes(text)) + 1;
const inFn = (btLine, fn) => { const l = lineOf(btLine), [a, b] = sourceSpan(fn); return l >= a && l <= b; };

// Stops: (function, 0-based block ordinal) -> assertions run inside the hook.
const stops = [
  { fn: 'add', ordinal: 1, run() {
    // Block after `c = a + b` was stored; add() called from caller() from main().
    const bt = callWithOutBuf(exp.wasm_dbg_get_backtrace).split('\n');
    console.error(`  backtrace:\n${bt.map((l) => '    ' + l).join('\n')}`);
    check(bt.length === 3, 'backtrace has 3 frames (add, caller, main)');
    check(inFn(bt[0], 'add') && inFn(bt[1], 'caller') && inFn(bt[2], 'main'),
      'frames resolve into add(), caller(), main() source lines respectively');
    // Outer frames carry their true call-site line (engine stack trace), not their last block entry.
    check(lineOf(bt[1]) === lineOfText('int y = add('), `frame 1 is on the call line ${lineOfText('int y = add(')} (got ${lineOf(bt[1])})`);
    check(lineOf(bt[2]) === lineOfText('return caller(1)'), `frame 2 is on the call line ${lineOfText('return caller(1)')} (got ${lineOf(bt[2])})`);
    for (const [frame, expr, re] of [
      [0, 'a', /\(int\) a = 1\b/], [0, 'b', /\(int\) b = 10\b/], [0, 'c', /\(int\) c = 11\b/],
      [1, 'x', /\(int\) x = 1\b/], [1, 'p.y', /\(int\) y = 2\b/], [1, 'p', /x = 1[^]*y = 2/],
    ]) {
      const v = formatValue(frame, expr);
      check(re.test(v), `frame ${frame} "${expr}" -> "${v}"`);
    }
  } },
  { fn: 'caller', ordinal: 1, run() {
    // After add() returned: the shadow stack must have popped add().
    const bt = callWithOutBuf(exp.wasm_dbg_get_backtrace).split('\n');
    console.error(`  backtrace:\n${bt.map((l) => '    ' + l).join('\n')}`);
    check(bt.length === 2 && inFn(bt[0], 'caller') && inFn(bt[1], 'main'),
      'backtrace is caller, main (add() popped after return)');
    const y = formatValue(0, 'y');
    check(/\(int\) y = 11\b/.test(y), `frame 0 "y" -> "${y}"`);
    const px = formatValue(0, 'p.x');
    check(/\(int\) x = 1\b/.test(px), `frame 0 "p.x" -> "${px}"`);
  } },
];
const pending = new Set(stops);
let hookFires = 0;
let hookError = null;

const targetWasi = new WASI({ version: 'preview1', args: ['prog'], env: {} });
targetInstance = new WebAssembly.Instance(targetModule, {
  ...targetWasi.getImportObject(),
  env: {
    __sanitizer_cov_trace_pc_guard_init() {},
    __sanitizer_cov_pcs_init() {},
    __sanitizer_cov_trace_pc_guard(guardPtr) {
      if (hookError) return;
      try {
        hookFires++;
        // The real hook->LLDB input: the live exported global.
        const top = shadowStack.onHook(Number(targetInstance.exports.__stack_pointer.value), guardPtr);
        for (const stop of pending) {
          if (guardSites.get(guardPtr).fn === stop.fn && guardOrdinal.get(guardPtr) === stop.ordinal) {
            pending.delete(stop);
            console.error(`stop at ${stop.fn}() block #${stop.ordinal} (pc 0x${top.pc.toString(16)}, sp ${top.sp}):`);
            setStopFromShadowStack();
            stop.run();
          }
        }
      } catch (e) { hookError = e; }
    },
  },
});
console.error('Running instrumented target...');
const exitCode = targetWasi.start(targetInstance);
if (hookError) { console.error(`hook failed: ${hookError.stack}`); ok = false; }
check(exitCode === 11, `target ran to completion with exit code ${exitCode} (expected caller(1) == 11)`);
check(hookFires > 0 && pending.size === 0, `${hookFires} hook firings; ${pending.size} stops never reached`);

// --- Statement granularity: -fsanitize-coverage=trace-loads,trace-stores.
// A straight-line function has exactly one guard (at entry, before any local is
// written), so guards alone can never stop "after c is assigned". The
// per-memory-access hooks have no guard argument, but the engine's stack trace
// names their call site, and at -O0 nearly every statement touches the frame.
console.error('--- Fine-grained hooks (trace-pc-guard + trace-loads + trace-stores), straight-line target');
const prog2C = `int add(int a, int b) {
  int c = a + b;
  int d = c * 2;
  return d - b;
}

int main(void) {
  return add(1, 10);
}
`;
const prog2Path = path.join(workDir, 'prog2.c');
const target2Path = path.join(workDir, 'prog2.wasm');
await writeFile(prog2Path, prog2C);
await execFileAsync(wasiSdkClang, ['-O0', '-g', '-fsanitize-coverage=trace-pc-guard,trace-loads,trace-stores',
  '-Wl,--export=__stack_pointer', '-Wl,--allow-undefined', '-o', target2Path, prog2Path]);
const target2Bytes = await readFile(target2Path);
const target2Module = new WebAssembly.Module(target2Bytes);
subprograms = parseSubprograms((await execFileAsync(llvmDwarfdump, ['--debug-info', target2Path])).stdout);
scan = scanGuardSites(target2Bytes);
shadowStack = new ShadowStack(scan.guardSites);
const addFuncIndex = [...scan.guardSites.values()].find((s) => subprogramForPc(s.pc).name === 'add').funcIndex;
const addGuards = [...scan.guardSites.values()].filter((s) => s.funcIndex === addFuncIndex).length;
check(addGuards === 1, `straight-line add() has ${addGuards} guard (expected exactly 1: guards alone cannot stop mid-function)`);

{
  const p = allocCString('/work/prog2.wasm');
  const rc = exp.wasm_dbg_create_target(p);
  exp.wasm_dbg_free(p);
  if (rc !== 0) throw new Error(`wasm_dbg_create_target(prog2) failed: ${getLastError()}`);
}
const line2Of = (text) => prog2C.split(String.fromCharCode(10)).findIndex((l) => l.includes(text)) + 1;
const lineCache = new Map();
const lineAtPc = (pc) => {
  if (!lineCache.has(pc)) lineCache.set(pc, Number(callWithOutBuf(exp.wasm_dbg_resolve_pc, BigInt(pc)).match(/prog2\.c:(\d+)/)?.[1]));
  return lineCache.get(pc);
};
const fineStops = [
  { line: line2Of('int d = c * 2'), run() {
    // c was stored by the previous statement; d is not yet written.
    const c = formatValue(0, 'c');
    check(/\(int\) c = 11\b/.test(c), `mid-function, after "c = a + b": frame 0 "c" -> "${c}"`);
  } },
  { line: line2Of('return d - b'), run() {
    const d = formatValue(0, 'd');
    check(/\(int\) d = 22\b/.test(d), `mid-function, after "d = c * 2": frame 0 "d" -> "${d}"`);
    const c = formatValue(0, 'c');
    check(/\(int\) c = 11\b/.test(c), `frame 0 "c" -> "${c}"`);
  } },
];
const pending2 = new Set(fineStops);
let fineHookError = null;
let fineFires = 0;
let target2Instance = null;
targetInstance = null; // read_memory now serves target 2
const target2Wasi = new WASI({ version: 'preview1', args: ['prog2'], env: {} });
const fineHook = () => {
  if (fineHookError) return;
  try {
    fineFires++;
    shadowStack.sync(Number(target2Instance.exports.__stack_pointer.value));
    const frames = captureWasmFrames(scan.module.codeStart);
    const line = lineAtPc(frames[0].pc);
    for (const stop of pending2) {
      if (line === stop.line && shadowStack.entries.at(-1)?.funcIndex === addFuncIndex) {
        pending2.delete(stop);
        console.error(`stop at prog2.c:${line} (pc 0x${frames[0].pc.toString(16)}):`);
        setStopFromShadowStack();
        const bt = callWithOutBuf(exp.wasm_dbg_get_backtrace).split('\n');
        check(lineOf(bt[0]) === stop.line, `frame 0 is exactly on line ${stop.line} (got ${lineOf(bt[0])})`);
        check(lineOf(bt[1]) === line2Of('return add('), `frame 1 is on the call line ${line2Of('return add(')} (got ${lineOf(bt[1])})`);
        stop.run();
      }
    }
  } catch (e) { fineHookError = e; }
};
const env2 = {
  __sanitizer_cov_trace_pc_guard_init() {},
  __sanitizer_cov_pcs_init() {},
  __sanitizer_cov_trace_pc_guard(guardPtr) {
    if (fineHookError) return;
    try { shadowStack.onHook(Number(target2Instance.exports.__stack_pointer.value), guardPtr); }
    catch (e) { fineHookError = e; }
  },
};
for (const imp of WebAssembly.Module.imports(target2Module))
  if (imp.module === 'env' && /^__sanitizer_cov_(load|store)\d+$/.test(imp.name)) env2[imp.name] = fineHook;
targetInstance = target2Instance = new WebAssembly.Instance(target2Module, { ...target2Wasi.getImportObject(), env: env2 });
const exit2 = target2Wasi.start(target2Instance);
if (fineHookError) { console.error(`fine hook failed: ${fineHookError.stack}`); ok = false; }
check(exit2 === 12, `prog2 ran to completion with exit code ${exit2} (expected add(1, 10) == 12)`);
check(pending2.size === 0, `${fineFires} fine hook firings; ${pending2.size} stops never reached`);

await rm(workDir, { recursive: true, force: true });
console.error(ok ? 'SMOKETEST PASSED' : 'SMOKETEST FAILED');
process.exit(ok ? 0 : 1);
