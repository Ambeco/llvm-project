// Stress test for the "third and later function resolves to the first" report: lldb-wasm-reactor.wasm must resolve
// every function's PCs to that function, and produce a correct deep backtrace with correct locals in EVERY frame, for
// (a) six functions in one compile unit and (b) six functions in six separate compile units.
//
// Same synthetic-stop approach as run_lldb_wasm_reactor_smoketest.mjs (read its header first); the program is never run.
//
// Usage:
//   node --experimental-wasm-type-reflection --experimental-wasi-unstable-preview1 \
//     wasi-tests/run_lldb_wasm_reactor_multiframe_smoketest.mjs [path-to-lldb-wasm-reactor.wasm] [path-to-wasi-sdk-clang]
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
const reactorPath = processArgv[2] ?? path.join(repoRoot, 'build-lldb', 'bin', 'lldb-wasm-reactor.wasm');
const wasiSdkClang = processArgv[3] ?? 'C:/Users/mooin/AppData/Local/wasi-sdk/wasi-sdk-34.0-x86_64-windows/bin/clang.exe';
const llvmDwarfdump = path.join(path.dirname(wasiSdkClang), 'llvm-dwarfdump.exe');
const dumpOpts = { maxBuffer: 512 * 1024 * 1024 };

// Function i calls function i+1 and holds one parameter (`x`) and one local (`lN`) with distinct planted values.
const FUNCS = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'];
const body = (i) => {
  const name = FUNCS[i];
  const call = i + 1 < FUNCS.length ? `return ${FUNCS[i + 1]}(l${i + 1} + 1);` : `return l${i + 1};`;
  return `int ${name}(int x) {\n  int l${i + 1} = x * 2;\n  ${call}\n}\n`;
};
const decls = FUNCS.map((f) => `int ${f}(int x);`).join('\n') + '\n';
const mainBody = `int main(void) {\n  return f1(1);\n}\n`;

/// Builds one program and returns { wasmPath, files: Map<fn, sourceFile> }.
async function buildProgram(workDir, name, layout) {
  const files = new Map();
  const srcs = [];
  if (layout === 'single') {
    const f = `${name}.c`;
    await writeFile(path.join(workDir, f), decls + FUNCS.map((_, i) => body(i)).join('\n') + '\n' + mainBody);
    FUNCS.forEach((fn) => files.set(fn, f));
    files.set('main', f);
    srcs.push(f);
  } else {
    for (let i = 0; i < FUNCS.length; i++) {
      const f = `${name}_${FUNCS[i]}.c`;
      await writeFile(path.join(workDir, f), `${decls}${body(i)}`);
      files.set(FUNCS[i], f);
      srcs.push(f);
    }
    const f = `${name}_main.c`;
    await writeFile(path.join(workDir, f), `${decls}${mainBody}`);
    files.set('main', f);
    srcs.push(f);
  }
  const wasmPath = path.join(workDir, `${name}.wasm`);
  await execFileAsync(wasiSdkClang, ['--target=wasm32-wasip1', '-O0', '-g', '-Wl,--export=__stack_pointer', '-o', wasmPath, ...srcs], { cwd: workDir });
  return { wasmPath, files };
}

const workDir = await mkdtemp(path.join(tmpdir(), 'lldb-wasm-reactor-multi-smoketest-'));
const programs = {
  single: await buildProgram(workDir, 'single', 'single'),
  multi: await buildProgram(workDir, 'multi', 'multi'),
};

const preopens = { '/work': workDir };
const bytes = await readFile(reactorPath);
const wasmModule = await WebAssembly.compile(bytes);
const wasi = new WASI({ version: 'preview1', args: ['lldb-wasm-reactor'], env: {}, preopens });
const syntheticMemoryRegions = [];
const wasmDbgImports = {
  read_memory(addr, bufPtr, size) {
    addr = Number(addr);
    const region = syntheticMemoryRegions.find((r) => addr >= r.base && addr + size <= r.base + r.bytes.length);
    if (!region) throw new Error(`unexpected read_memory(0x${addr.toString(16)}, size=${size})`);
    mem8().set(region.bytes.subarray(addr - region.base, addr - region.base + size), bufPtr);
    return size;
  },
  write_memory() { throw new Error('unexpected write_memory call in this smoketest'); },
};
const importObjectBase = { ...wasi.getImportObject(), wasm_dbg: wasmDbgImports };
const extraImportsModule = new URL('./lldb_wasm_reactor_dbg_imports.mjs', import.meta.url).href;
const isThreaded = WebAssembly.Module.imports(wasmModule).some((i) => i.name === 'thread-spawn');
console.error(isThreaded ? 'Threaded reactor.' : 'Single-threaded reactor.');
let instance, memory;
if (isThreaded) {
  ({ instance, memory } = await instantiateThreaded(wasmModule, bytes, importObjectBase, { wasmPath: reactorPath, preopens, extraImportsModule }));
} else {
  instance = await WebAssembly.instantiate(wasmModule, importObjectBase);
  memory = instance.exports.memory;
}
wasi.initialize(isThreaded ? makeFakeInstance(instance, memory, { forThread: true }) : instance);
const exp = instance.exports;
const mem8 = () => new Uint8Array(memory.buffer);

function allocCString(str) {
  const e = new TextEncoder().encode(str + '\0');
  const ptr = exp.wasm_dbg_alloc(e.length);
  mem8().set(e, ptr);
  return ptr;
}
function allocU32(values) { const p = exp.wasm_dbg_alloc(Math.max(1, values.length * 4)); new Uint32Array(memory.buffer, p, values.length).set(values); return p; }
function allocU64(values) { const p = exp.wasm_dbg_alloc(Math.max(1, values.length * 8)); new BigUint64Array(memory.buffer, p, values.length).set(values); return p; }
function readCString(ptr, max) { const b = mem8(); let e = ptr; while (e < ptr + max && b[e] !== 0) e++; return new TextDecoder().decode(b.subarray(ptr, e)); }
function lastError() {
  const o = exp.wasm_dbg_alloc(4096);
  try { const n = exp.wasm_dbg_get_last_error(o, 4096); return n > 0 ? readCString(o, Math.min(n, 4095)) : '<no detail>'; } finally { exp.wasm_dbg_free(o); }
}
function callOut(fn, ...args) {
  const o = exp.wasm_dbg_alloc(4096);
  try {
    const n = fn(...args, o, 4096);
    if (n < 0) throw new Error(`call failed (${n}): ${lastError()}`);
    return readCString(o, Math.min(n, 4095));
  } finally { exp.wasm_dbg_free(o); }
}

let ok = true;
function check(name, cond, detail = '') {
  console.error(`${cond ? 'PASS' : 'FAIL'}: ${name}${cond ? '' : ` -- ${detail}`}`);
  ok &&= cond;
}
check('wasm_dbg_init', exp.wasm_dbg_init() === 0);

for (const [layout, { wasmPath, files }] of Object.entries(programs)) {
  const rel = path.basename(wasmPath);
  const { stdout: info } = await execFileAsync(llvmDwarfdump, ['--debug-info', wasmPath], dumpOpts);
  const { stdout: lines } = await execFileAsync(llvmDwarfdump, ['--debug-line', wasmPath], dumpOpts);
  const chunk = (fn) => info.split('DW_TAG_subprogram').find((c) => new RegExp(`DW_AT_name\\s*\\("${fn}"\\)`).test(c));
  const lowPc = (fn) => parseInt(chunk(fn).match(/DW_AT_low_pc\s*\(0x([0-9a-f]+)\)/)[1], 16);
  const frameLocal = (fn) => parseInt(chunk(fn).match(/DW_AT_frame_base\s*\(DW_OP_WASM_location 0x0 0x([0-9a-f]+)/)[1], 16);
  const fbreg = (fn, v) => {
    const c = chunk(fn).split(/DW_TAG_(?:formal_parameter|variable)/).find((x) => new RegExp(`DW_AT_name\\s*\\("${v}"\\)`).test(x));
    return parseInt(c.match(/DW_AT_location\s*\(DW_OP_fbreg (-?\+?\d+)\)/)[1], 10);
  };
  const declLine = (fn) => Number(chunk(fn).match(/DW_AT_decl_line\s*\((\d+)\)/)[1]);

  const p = allocCString(`/work/${rel}`);
  const rc = exp.wasm_dbg_create_target(p);
  exp.wasm_dbg_free(p);
  check(`[${layout}] create_target`, rc === 0, lastError());
  if (rc !== 0) { ok = false; continue; }

  // 1. Each function's entry PC resolves to its own source file and declaration line.
  const all = ['main', ...FUNCS];
  for (const fn of all) {
    const r = callOut(exp.wasm_dbg_resolve_pc, BigInt(lowPc(fn)));
    const want = files.get(fn);
    check(`[${layout}] resolve_pc(${fn} entry) -> ${want}:${declLine(fn)}`,
      r.replace(/\\/g, '/').endsWith(`${want}:${declLine(fn)}`), r);
  }

  // 2. Every is_stmt line-table row of our own sources resolves to its own file and line (all tables, all functions).
  let rowsChecked = 0;
  const bad = [];
  for (const table of lines.split(/^debug_line\[/m)) {
    const names = [...table.matchAll(/name: "([^"]+)"/g)].map((m) => m[1]);
    const mine = names.find((n) => [...files.values()].includes(path.basename(n)));
    if (!mine) continue;
    const byAddr = new Map();
    for (const m of table.matchAll(/^0x([0-9a-f]+)[ \t]+(\d+)[ \t]+\d+[ \t]+(\d+)[ \t]+\d+[ \t]+\d+[ \t]+\d+[ \t]*(.*)$/gm)) {
      if (!/is_stmt/.test(m[4]) || /end_sequence/.test(m[4])) continue;
      const a = parseInt(m[1], 16);
      (byAddr.get(a) ?? byAddr.set(a, new Set()).get(a)).add(`${m[3]}:${m[2]}`);
    }
    for (const [a, set] of byAddr) {
      if (set.size !== 1) continue;
      const [fileIdxLine] = set;
      const line = fileIdxLine.split(':')[1];
      const r = callOut(exp.wasm_dbg_resolve_pc, BigInt(a)).replace(/\\/g, '/');
      rowsChecked++;
      if (!r.endsWith(`:${line}`) || !all.some((f) => r.includes(files.get(f)))) bad.push(`0x${a.toString(16)} want line ${line}, got ${r}`);
      else {
        // the resolved file must be the one this table belongs to
        const base = path.basename(mine);
        if (!r.endsWith(`${base}:${line}`)) bad.push(`0x${a.toString(16)} want ${base}:${line}, got ${r}`);
      }
    }
  }
  console.error(`[${layout}] checked ${rowsChecked} line-table addresses`);
  check(`[${layout}] every line-table row resolves to its own file and line`, rowsChecked >= 12 && bad.length === 0, bad.slice(0, 4).join('; '));

  // 3. Deep synthetic stop: f6 <- f5 <- ... <- f1 <- main. Backtrace names every frame's own file; each frame's
  // parameter x and local lN format to that frame's own planted values.
  const order = [...FUNCS].reverse().concat(['main']); // innermost first
  syntheticMemoryRegions.length = 0;
  const framePcs = [], bases = [], localIdx = [], localVals = [];
  order.forEach((fn, i) => {
    const base = 0x100000 + i * 0x10000;
    const img = new Uint8Array(4096);
    const dv = new DataView(img.buffer);
    if (fn !== 'main') {
      const n = Number(fn.slice(1));
      dv.setInt32(fbreg(fn, 'x'), 100 * n + 1, true);
      dv.setInt32(fbreg(fn, `l${n}`), 1000 * n + 7, true);
    }
    syntheticMemoryRegions.push({ base, bytes: img });
    framePcs.push(BigInt(lowPc(fn) + 5));
    bases.push(BigInt(base));
    localIdx.push(i);
  });
  const wasmLocals = order.map(frameLocal);
  const a1 = allocU64(framePcs), a2 = allocU32(localIdx), a3 = allocU32(wasmLocals), a4 = allocU64(bases);
  exp.wasm_dbg_set_stop(a1, framePcs.length, a2, a3, a4, bases.length);
  for (const x of [a1, a2, a3, a4]) exp.wasm_dbg_free(x);
  const bt = callOut(exp.wasm_dbg_get_backtrace).split('\n').map((l) => l.replace(/\\/g, '/'));
  console.error(`[${layout}] backtrace:\n${bt.join('\n')}`);
  check(`[${layout}] backtrace has ${order.length} frames`, bt.length === order.length, `${bt.length}`);
  order.forEach((fn, i) => {
    check(`[${layout}] frame ${i} (${fn}) is in ${files.get(fn)}`, !!bt[i] && bt[i].includes(files.get(fn)), bt[i]);
  });
  order.forEach((fn, i) => {
    if (fn === 'main') return;
    const n = Number(fn.slice(1));
    const fmt = (expr) => { const e = allocCString(expr); try { return callOut(exp.wasm_dbg_format_value, i, e); } finally { exp.wasm_dbg_free(e); } };
    const x = fmt('x'), l = fmt(`l${n}`);
    check(`[${layout}] frame ${i} (${fn}): x = ${100 * n + 1}, l${n} = ${1000 * n + 7}`,
      new RegExp(`\\b${100 * n + 1}\\b`).test(x) && new RegExp(`\\b${1000 * n + 7}\\b`).test(l), `${x} | ${l}`);
  });
}

await rm(workDir, { recursive: true, force: true });
console.error(ok ? 'SMOKETEST PASSED' : 'SMOKETEST FAILED');
process.exit(ok ? 0 : 1);
