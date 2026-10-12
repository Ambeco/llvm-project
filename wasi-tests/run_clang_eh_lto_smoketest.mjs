// Proves clang.wasm + lld.wasm can build user programs that use C++ exceptions and/or -flto from the
// packaged sysroot, on a stock WASI host (same setup as run_clang_nospawn_smoketest.mjs).
//
// compile-flags.json's defaults already enable C++ exceptions (-fwasm-exceptions, -lunwind, libc++ built from this
// tree), so the `exceptions` cases use them as-is. The `no-exceptions-code` case checks that code built with
// -fno-exceptions still links and runs against those same libraries.
//
// Usage:
//   node --experimental-wasm-type-reflection --experimental-wasi-unstable-preview1 \
//     wasi-tests/run_clang_eh_lto_smoketest.mjs <release-dir> [--threads] [--bin <dir-with-clang.wasm-and-lld.wasm>]
// Prints one PASS/FAIL line per case and a final SMOKETEST PASSED/FAILED.
import { writeFile, mkdtemp, readFile } from 'node:fs/promises';
import { WASI } from 'node:wasi';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { argv } from 'node:process';
import { findResourceDir } from './wasi_spawn_shim.mjs';
import { instantiateThreaded, makeFakeInstance } from './wasi_thread_hook.mjs';

const threads = argv.includes('--threads');
const binArg = argv.indexOf('--bin');
const positional = argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--bin');
if (!positional[0])
  throw new Error('usage: run_clang_eh_lto_smoketest.mjs <release-dir> [--threads] [--bin <dir>]\n' +
    'release-dir is the output of wasi-tests/package_release.mjs (did you forget it?)');
const releaseDir = path.resolve(positional[0]);
const binDir = binArg >= 0 ? path.resolve(argv[binArg + 1]) : path.join(releaseDir, 'bin');
const slice = threads ? 'wasm32-wasip1-threads' : 'wasm32-wasip1';
const resourceDir = await findResourceDir(path.join(releaseDir, 'resource', 'lib', 'clang'));
const workDir = await mkdtemp(path.join(tmpdir(), 'clang-wasm-eh-lto-'));
const preopens = { '/work': workDir, '/sysroot': path.join(releaseDir, 'sysroot'), '/resource': resourceDir };

const ehSrc = `#include <stdexcept>
#include <string>
#include <iostream>
struct Custom { int code; };
static int thrower(int n) { if (n > 2) throw std::runtime_error("boom " + std::to_string(n)); return n; }
int main() {
  int caught = 0;
  try { thrower(5); } catch (const std::runtime_error& e) { caught++; std::cout << "caught: " << e.what() << std::endl; }
  try { throw Custom{42}; } catch (const Custom& c) { if (c.code == 42) caught++; }
  try { try { throw 7; } catch (int) { throw std::logic_error("rethrown"); } } catch (const std::exception&) { caught++; }
  std::cout << "caught = " << caught << " (expected 3)" << std::endl;
  return caught == 3 ? 0 : 1;
}
`;
const ltoSrc = `#include <iostream>
#include <vector>
#include <numeric>
int main() {
  std::vector<int> v(100); std::iota(v.begin(), v.end(), 1);
  long sum = std::accumulate(v.begin(), v.end(), 0L);
  std::cout << "sum = " << sum << " (expected 5050)" << std::endl;
  return sum == 5050 ? 0 : 1;
}
`;

const subst = (a) => a.replaceAll('${SYSROOT}', '/sysroot').replaceAll('${RESOURCE}', '/resource');
const flags = JSON.parse(await readFile(path.join(releaseDir, 'compile-flags.json'), 'utf8'));
const baseCompile = flags.compile[slice].map(subst);
const baseLink = flags.link[slice].map(subst);
const ehCompile = baseCompile;
const ehLink = baseLink;

async function run(wasmFile, args) {
  const wasi = new WASI({ version: 'preview1', args, env: {}, preopens });
  const module = await WebAssembly.compile(await readFile(path.join(binDir, wasmFile)));
  const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
  try { return wasi.start(instance) ?? 0; } catch (e) { console.error(`${wasmFile} trapped:`, e); return -1; }
}

async function execute(wasmPath) {
  const out = await readFile(wasmPath);
  const w = new WASI({ version: 'preview1', args: ['prog'], env: {}, preopens: {} });
  if (threads) {
    const { instance, memory } = await instantiateThreaded(await WebAssembly.compile(out), out,
      w.getImportObject(), { wasmPath, preopens: {} });
    return w.start(makeFakeInstance(instance, memory)) ?? 0;
  }
  const inst = await WebAssembly.instantiate(await WebAssembly.compile(out), w.getImportObject());
  return w.start(inst) ?? 0;
}

const cases = [
  { name: 'exceptions', src: ehSrc, compile: ehCompile, link: ehLink, extraCompile: [], extraLink: [] },
  { name: 'no-exceptions-code', src: ltoSrc, compile: baseCompile, link: baseLink, extraCompile: ['-fno-exceptions'], extraLink: [] },
  { name: 'lto', src: ltoSrc, compile: baseCompile, link: baseLink, extraCompile: ['-flto'], extraLink: [], expectBitcode: true },
  { name: 'exceptions+lto', src: ehSrc, compile: ehCompile, link: ehLink, extraCompile: ['-flto'], extraLink: [], expectBitcode: true },
];
let allOk = true;
for (const c of cases) {
  let ok = false, detail = '';
  try {
    const base = path.join(workDir, c.name.replace('+', '_'));
    await writeFile(`${base}.cpp`, c.src);
    const guest = `/work/${c.name.replace('+', '_')}`;
    const rc = await run('clang.wasm', ['clang++', ...c.compile, ...c.extraCompile, '-fno-crash-diagnostics', '-c', `${guest}.cpp`, '-o', `${guest}.o`]);
    if (rc !== 0) { detail = `compile exit ${rc}`; }
    else {
      const head = (await readFile(`${base}.o`)).subarray(0, 4);
      const isBitcode = head[0] === 0x42 && head[1] === 0x43 && head[2] === 0xc0 && head[3] === 0xde;
      if (c.expectBitcode && !isBitcode) { detail = 'expected LLVM bitcode from -flto -c but got a regular object'; }
      else {
        const lrc = await run('lld.wasm', ['wasm-ld', c.link[0], `${guest}.o`, ...c.link.slice(1), ...c.extraLink, '-o', `${guest}.wasm`]);
        if (lrc !== 0) { detail = `link exit ${lrc}`; }
        else {
          const erc = await execute(`${base}.wasm`);
          ok = erc === 0;
          if (!ok) detail = `program exit ${erc}`;
        }
      }
    }
  } catch (e) { detail = String(e?.stack ?? e); }
  console.error(`${ok ? 'PASS' : 'FAIL'}: ${c.name}${detail ? ` -- ${detail}` : ''}`);
  allOk &&= ok;
}
console.error(allOk ? 'SMOKETEST PASSED' : 'SMOKETEST FAILED');
process.exit(allOk ? 0 : 1);
