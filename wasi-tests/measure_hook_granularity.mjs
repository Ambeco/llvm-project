// Measures the stop granularity and runtime overhead of the sanitizer-coverage
// instrumentation options for the "Debug" build (documents/design.md,
// "Hook granularity"). Prints a table; not a pass/fail test.
//
// Granularity is reported against the DWARF line table: its is_stmt row count
// is exactly how many hooks a custom per-line-row pass would emit.
//
// Usage:
//   node --experimental-wasm-type-reflection --experimental-wasi-unstable-preview1 \
//     wasi-tests/measure_hook_granularity.mjs [path-to-wasi-sdk-clang]
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { WASI } from 'node:wasi';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { argv as processArgv } from 'node:process';
import { scanGuardSites, ShadowStack, captureWasmFrames } from './sancov_host.mjs';

const execFileAsync = promisify(execFile);
const wasiSdkClang = processArgv[2] ??
  'C:/Users/mooin/AppData/Local/wasi-sdk/wasi-sdk-34.0-x86_64-windows/bin/clang.exe';
const sdkBin = path.dirname(wasiSdkClang);
const workDir = await mkdtemp(path.join(tmpdir(), 'hook-granularity-'));

const src = `#include <stdlib.h>
static int fib(int n) {
  int r;
  if (n < 2)
    r = n;
  else
    r = fib(n - 1) + fib(n - 2);
  return r;
}

static int sum(int n) {
  int s = 0;
  for (int i = 0; i < n; i++) {
    s += i * 3;
    s ^= i;
  }
  return s;
}

int main(int argc, char** argv) {
  int r = fib(atoi(argv[1]));
  r += sum(atoi(argv[2]));
  return r & 0x7f;
}
`;
const srcPath = path.join(workDir, 'bench.c');
await writeFile(srcPath, src);

const CONFIGS = {
  none: { flags: [] },
  'guard (empty hook)': { flags: ['trace-pc-guard'], hooks: 'empty' },
  'guard (shadow stack)': { flags: ['trace-pc-guard'], hooks: 'shadow' },
  'inline-8bit-counters (floor; cannot stop)': { flags: ['inline-8bit-counters'], hooks: 'empty' },
  'trace-pc (empty hook; no args, no guard)': { flags: ['trace-pc'], hooks: 'empty' },
  'guard+loads+stores (empty hooks)': { flags: ['trace-pc-guard', 'trace-loads', 'trace-stores'], hooks: 'empty' },
  'guard+loads+stores (1-frame stack capture per hook)': { flags: ['trace-pc-guard', 'trace-loads', 'trace-stores'], hooks: 'capture' },
};

async function build(name, cfg) {
  const out = path.join(workDir, `bench-${Object.keys(CONFIGS).indexOf(name)}.wasm`);
  const flags = ['-O0', '-g', '-Wl,--export=__stack_pointer', '-Wl,--allow-undefined', '-o', out, srcPath];
  if (cfg.flags.length) flags.unshift(`-fsanitize-coverage=${cfg.flags.join(',')}`);
  await execFileAsync(wasiSdkClang, flags);
  return { out, bytes: await readFile(out) };
}

/// One run; returns { ms, fires, lines (Set of DWARF-address line hits, capture config only) }.
function run(module, bytes, cfg, args, codeStart, guardSites, lineAt) {
  const wasi = new WASI({ version: 'preview1', args: ['bench', ...args], env: {} });
  let inst;
  let fires = 0;
  const shadow = guardSites && new ShadowStack(guardSites);
  const linesHit = new Set();
  const noop = () => { fires++; };
  const env = {
    __sanitizer_cov_trace_pc_guard_init() {},
    __sanitizer_cov_pcs_init() {},
    __sanitizer_cov_8bit_counters_init() {},
  };
  const guardHook = cfg.hooks === 'shadow'
    ? (g) => { fires++; shadow.onHook(inst.exports.__stack_pointer.value, g); }
    : cfg.hooks === 'capture'
      ? (g) => { fires++; shadow.onHook(inst.exports.__stack_pointer.value, g); }
      : noop;
  const fineHook = cfg.hooks === 'capture'
    ? () => { fires++; shadow.sync(inst.exports.__stack_pointer.value); linesHit.add(lineAt(captureWasmFrames(codeStart, true)[0].pc)); }
    : noop;
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.module !== 'env' || env[imp.name]) continue;
    if (imp.name === '__sanitizer_cov_trace_pc_guard') env[imp.name] = guardHook;
    else if (imp.name === '__sanitizer_cov_trace_pc') env[imp.name] = cfg.hooks === 'capture' ? fineHook : noop;
    else if (/^__sanitizer_cov_(load|store)\d+$/.test(imp.name)) env[imp.name] = fineHook;
    else throw new Error(`unexpected env import ${imp.name}; did you mean to handle it in measure_hook_granularity.mjs?`);
  }
  inst = new WebAssembly.Instance(module, { ...wasi.getImportObject(), env });
  const t0 = performance.now();
  wasi.start(inst);
  return { ms: performance.now() - t0, fires, linesHit };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/// DWARF line table rows: { addr, line, isStmt }, sorted by address.
async function lineTable(wasmPath) {
  const { stdout } = await execFileAsync(path.join(sdkBin, 'llvm-dwarfdump.exe'), ['--debug-line', wasmPath], { maxBuffer: 64 << 20 });
  const rows = [];
  // Only the table that describes bench.c (wasi-libc objects carry their own).
  const table = stdout.split(/^debug_line\[/m).find((t) => /name:\s*"[^"]*bench\.c"/.test(t)) ?? '';
  for (const m of table.matchAll(/^0x([0-9a-f]+)\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s*(.*)$/gm))
    rows.push({ addr: parseInt(m[1], 16), line: Number(m[2]), isStmt: /is_stmt/.test(m[3]), end: /end_sequence/.test(m[3]) });
  return rows.sort((a, b) => a.addr - b.addr);
}
const lineAtFor = (rows) => (pc) => {
  let lo = 0, hi = rows.length - 1, best = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (rows[mid].addr <= pc) { best = mid; lo = mid + 1; } else hi = mid - 1; }
  return best < 0 ? 0 : rows[best].line;
};

const results = [];
const SMALL = ['16', '20000']; // fine-grained configs are far slower
const BIG = ['27', '3000000'];
for (const [name, cfg] of Object.entries(CONFIGS)) {
  console.error(`building ${name}...`);
  const { out, bytes } = await build(name, cfg);
  const module = new WebAssembly.Module(bytes);
  const scan = cfg.flags.includes('trace-pc-guard') ? scanGuardSites(bytes) : null;
  const rows = await lineTable(out);
  const lineAt = lineAtFor(rows);
  const stmtRows = rows.filter((r) => r.isStmt && !r.end);
  const stmtLines = new Set(stmtRows.map((r) => r.line).filter((l) => l > 0));
  const guardLines = scan ? new Set([...scan.guardSites.values()].map((s) => lineAt(s.pc))) : null;
  const reps = cfg.hooks === 'capture' ? 5 : 7;
  const args = cfg.hooks === 'capture' ? SMALL : BIG;
  const samples = [];
  let fires = 0, linesHit = new Set();
  for (let i = 0; i < reps; i++) {
    const r = run(module, bytes, cfg, args, scan?.module.codeStart ?? 0, scan?.guardSites, lineAt);
    samples.push(r.ms); fires = r.fires; linesHit = r.linesHit;
  }
  results.push({ name, hooks: cfg.hooks, stmtRows: stmtRows.length, stmtLines: stmtLines.size, guardSites: scan?.guardSites.size ?? 0,
    guardLines: guardLines?.size ?? 0, args, ms: median(samples), fires, linesHit: linesHit.size });
}

const base = results[0];
console.log(`\nSource: ${src.split('\n').filter((l) => l.trim()).length} non-blank lines. DWARF line table for bench.c: ${base.stmtRows} is_stmt rows over ${base.stmtLines} distinct lines (= hooks a per-row pass would emit).\n`);
console.log('config'.padEnd(52), 'sites', 'lines', 'workload'.padEnd(10), 'ms'.padStart(8), 'x none'.padStart(7), 'hooks'.padStart(9), 'ns/hook'.padStart(8));
const noneAt = new Map();
for (const args of [SMALL, BIG]) {
  const none = CONFIGS.none;
  const { out, bytes } = await build('none', none);
  const module = new WebAssembly.Module(bytes);
  noneAt.set(args, median(Array.from({ length: 9 }, () => run(module, bytes, none, args, 0, null, null).ms)));
}
for (const r of results) {
  const baseMs = noneAt.get(r.args);
  const nsPerHook = r.fires ? (((r.ms - baseMs) * 1e6) / r.fires).toFixed(0) : '-';
  console.log(r.name.padEnd(52), String(r.guardSites || '-').padEnd(5), String(r.hooks === 'capture' ? r.linesHit : (r.guardLines || '-')).padEnd(5),
    (r.args === BIG ? 'big' : 'small').padEnd(10), r.ms.toFixed(1).padStart(8), (r.args === BIG ? (r.ms / baseMs).toFixed(2) : '-').padStart(7),
    String(r.fires).padStart(9), nsPerHook.padStart(8));
}
console.log('\n"lines" = distinct bench.c lines a hook can stop on (static for guard-only rows; observed at run time for the stack-capture row).');
console.log('big = fib(27) + sum(3000000); small = fib(16) + sum(20000). ns/hook = (config - none) / hook firings at the same workload.');

await rm(workDir, { recursive: true, force: true });
