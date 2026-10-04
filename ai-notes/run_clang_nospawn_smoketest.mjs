// Proves the single-process, single-thread toolchain (build-single-threaded,
// -DCLANG_SPAWN_CC1=OFF) works on a STOCK WASI host: plain node:wasi, no
// spawn hook, no thread hook, no custom imports. Compile and link are two
// separate instantiations, exactly how the vsclang extension runs them.
//
// Usage:
//   node --experimental-wasi-unstable-preview1 ai-notes/run_clang_nospawn_smoketest.mjs [release-dir]
// release-dir is the output of package_release.mjs (default: assembled in
// place from build-single-threaded/ and the wasi-sdk sysroot).
import { writeFile, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { WASI } from 'node:wasi';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { argv } from 'node:process';
import { findResourceDir } from './wasi_spawn_shim.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const releaseDir = argv[2] ? path.resolve(argv[2]) : null;
const binDir = releaseDir ? path.join(releaseDir, 'bin') : path.join(repoRoot, 'build-single-threaded', 'bin');
const sysrootPath = releaseDir ? path.join(releaseDir, 'sysroot')
  : 'C:/Users/mooin/AppData/Local/wasi-sdk/wasi-sdk-34.0-x86_64-windows/share/wasi-sysroot';
const resourceDir = releaseDir
  ? await findResourceDir(path.join(releaseDir, 'resource', 'lib', 'clang'))
  : await findResourceDir(path.join(repoRoot, 'build-single-threaded', 'lib', 'clang'));

const workDir = await mkdtemp(path.join(tmpdir(), 'clang-wasm-nospawn-'));
await writeFile(path.join(workDir, 'hello.cpp'),
  '#include <iostream>\nint main() { std::cout << "Hello, nospawn!" << std::endl; return 0; }\n');

// Only the preopens a stock host can provide; deliberately no /bin or /tmp
// with a spawn hook behind it.
const preopens = { '/work': workDir, '/sysroot': sysrootPath, '/resource': resourceDir };

async function runTool(wasmFile, args) {
  const wasi = new WASI({ version: 'preview1', args, env: {}, preopens });
  const module = await WebAssembly.compile(await readFile(path.join(binDir, wasmFile)));
  const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
  console.error(`Running ${wasmFile}: ${args.join(' ')}`);
  try {
    return wasi.start(instance) ?? 0;
  } catch (e) {
    console.error(`${wasmFile} trapped:`, e);
    return -1;
  }
}

const sys = '/sysroot/lib/wasm32-wasip1';
// node:wasi on Windows can't list directories (opendir -> ENOSYS), so the
// driver's libc++ include-path auto-detection finds nothing here; pass the
// paths explicitly. A host with working readdir doesn't need these.
const inc = '/sysroot/include/wasm32-wasip1/noeh/c++/v1';
const rc = await runTool('clang.wasm', ['clang++', '--target=wasm32-wasip1', '--sysroot=/sysroot',
  '-resource-dir=/resource', `-isystem${inc}`, '-isystem/sysroot/include/c++/v1', '-fno-exceptions', '-fno-crash-diagnostics', '-c', '/work/hello.cpp', '-o', '/work/hello.o']);
let ok = rc === 0;
if (ok) {
  const lrc = await runTool('lld.wasm', ['wasm-ld', `${sys}/crt1.o`, '/work/hello.o', `-L${sys}/noeh`, `-L${sys}`,
    '-lc++', '-lc++abi', '-lc', `/resource/lib/wasm32-unknown-wasip1/libclang_rt.builtins.a`, '-o', '/work/hello.wasm']);
  ok = lrc === 0;
}
if (ok) {
  const out = await readFile(path.join(workDir, 'hello.wasm'));
  const w = new WASI({ version: 'preview1', args: ['hello'], env: {}, preopens: {} });
  const inst = await WebAssembly.instantiate(await WebAssembly.compile(out), w.getImportObject());
  ok = (w.start(inst) ?? 0) === 0;
}
console.error(ok ? 'SMOKETEST PASSED' : 'SMOKETEST FAILED');
process.exit(ok ? 0 : 1);
