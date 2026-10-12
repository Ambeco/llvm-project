// Runs build/bin/clang.wasm (or lld.wasm as wasm-ld) like a normal host CLI so CMake/ninja can use it as a compiler.
// Host drive paths are exposed under guest `/c`, `/d`, ...; args are rewritten `C:/x` -> `/c/x`, relative path args are
// made absolute against the cwd, and any `-MF` depfile is rewritten back to host paths afterwards for ninja.
//
// clang++ is clang with --driver-mode=g++; -resource-dir is injected.
// Usage (via clang-wasm.bat / wasm-ld-wasm.bat wrappers):
//   node --experimental-wasm-type-reflection --experimental-wasi-unstable-preview1 wasi-tests/clang_wasm_cli.mjs <clang|wasm-ld> [args...]
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { WASI } from 'node:wasi';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { argv } from 'node:process';
import { installSpawnHook, findResourceDir } from './wasi_spawn_shim.mjs';
import { instantiateThreaded, makeFakeInstance } from './wasi_thread_hook.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const binDir = path.join(repoRoot, 'build', 'bin');
const tool = argv[2];
if (!['clang', 'clang++', 'wasm-ld'].includes(tool))
  throw new Error(`usage: clang_wasm_cli.mjs <clang|clang++|wasm-ld> [args...] (got '${tool}')`);
const wasmPath = path.join(binDir, tool !== 'wasm-ld' ? 'clang.wasm' : 'lld.wasm');
const resourceDir = await findResourceDir(path.join(repoRoot, 'build', 'lib', 'clang'));

const toGuest = (s) => s.replace(/(^|[=:,;\s]|(?<=^-(?:[IL]|isystem|iquote|include)))([A-Za-z]):[\\/]/g, (_, pre, d) => `${pre}/${d.toLowerCase()}/`).replace(/\\/g, '/');
const cwd = process.cwd();
const absolutize = (a, force = false) => {
  if (a.startsWith('-') || a.startsWith('/') || /^[A-Za-z]:/.test(a)) return a;
  const abs = path.resolve(cwd, a);
  return (force || a.includes('/') || a.includes('\\') || existsSync(abs)) && existsSync(path.dirname(abs)) ? abs : a;
};
const pathFlagPrefixes = ['-I', '-isystem', '-include', '-MF', '-L', '--sysroot='];
const pathValuedPrev = new Set(['-o', '-MF', '-I', '-isystem', '-include', '-L', '-iquote', '-isysroot']);
let prev = '';
const rawArgs = argv.slice(3);
const injected = tool === 'wasm-ld' ? [] : ['-resource-dir=/resource-dir', ...(tool === 'clang++' ? ['--driver-mode=g++'] : [])];
// The driver derives a relative default output name that the spawned -cc1 can't resolve (no cwd on WASI); make it absolute.
if (tool !== 'wasm-ld' && !rawArgs.includes('-o') && (rawArgs.includes('-c') || rawArgs.includes('-S'))) {
  const src = rawArgs.find((a) => /\.(c|cc|cpp|cxx|m|mm|S|s|i|ii)$/.test(a));
  if (src) rawArgs.push('-o', path.join(cwd, path.basename(src).replace(/\.[^.]+$/, rawArgs.includes('-S') ? '.s' : '.o')));
}
const args = rawArgs.map((a) => {
  let out = a;
  if (pathValuedPrev.has(prev)) out = absolutize(a, true);
  else if (!a.startsWith('--') || a.startsWith('--sysroot=')) {
    const p = pathFlagPrefixes.find((x) => a.startsWith(x) && a.length > x.length);
    if (p) out = p + absolutize(a.slice(p.length));
    else out = absolutize(a);
  }
  prev = a;
  return toGuest(out);
});
const mf = rawArgs.indexOf('-MF');
const depFile = mf >= 0 ? path.resolve(cwd, rawArgs[mf + 1]) : null;

const roots = {};
for (const d of 'cdefg') if (existsSync(`${d}:\\`)) roots[`/${d}`] = `${d.toUpperCase()}:\\`;
const tmpDir = await mkdtemp(path.join(tmpdir(), 'clang-wasm-cli-'));
const preopens = { ...roots, '/bin': binDir, '/tmp': tmpDir, '/resource-dir': resourceDir };

const wasi = new WASI({ version: 'preview1', args: [tool === 'wasm-ld' ? tool : 'clang', ...injected, ...args], env: { PATH: '/bin', TMPDIR: '/tmp' }, preopens, returnOnExit: true });
const bytes = await readFile(wasmPath);
const mod = await WebAssembly.compile(bytes);
const { instance, memory } = await instantiateThreaded(mod, bytes, wasi.getImportObject(), { wasmPath, preopens });
installSpawnHook(instance, { wasmPath, preopens, memory });
let rc = 0;
try { rc = wasi.start(makeFakeInstance(instance, memory)) ?? 0; }
catch (e) { console.error('clang_wasm_cli: trapped:', e); rc = 1; }
if (depFile && existsSync(depFile)) {
  const t = await readFile(depFile, 'utf8');
  await writeFile(depFile, t.replace(/(^|[\s:])\/([a-g])\//g, (_, pre, d) => `${pre}${d.toUpperCase()}:/`));
}
await rm(tmpDir, { recursive: true, force: true });
process.exit(rc);
