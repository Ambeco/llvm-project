// Proves the single-process, single-thread toolchain (build-single-threaded,
// -DCLANG_SPAWN_CC1=OFF) works on a STOCK WASI host: plain node:wasi, no
// spawn hook, no thread hook, no custom imports. Compile and link are two
// separate instantiations, exactly how the vsclang extension runs them.
//
// Usage:
//   node --experimental-wasm-type-reflection --experimental-wasi-unstable-preview1 wasi-tests/run_clang_nospawn_smoketest.mjs [release-dir] [--threads]
// --threads exercises the wasm32-wasip1-threads slice flags (needs release-dir):
// compiles a 4-pthread program and runs the output through the wasi-threads host.
// release-dir is the output of package_release.mjs (default: assembled in
// place from build-single-threaded/ and the wasi-sdk sysroot).
import { writeFile, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { WASI } from 'node:wasi';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { argv } from 'node:process';
import { findResourceDir } from './wasi_spawn_shim.mjs';
import { instantiateThreaded, makeFakeInstance } from './wasi_thread_hook.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const threads = argv.includes('--threads');
const positional = argv.slice(2).filter((a) => !a.startsWith('--'));
const releaseDir = positional[0] ? path.resolve(positional[0]) : null;
if (threads && !releaseDir)
  throw new Error('--threads needs a release-dir (the flags under test come from its compile-flags.json)');
const slice = threads ? 'wasm32-wasip1-threads' : 'wasm32-wasip1';
const binDir = releaseDir ? path.join(releaseDir, 'bin') : path.join(repoRoot, 'build-single-threaded', 'bin');
const sysrootPath = releaseDir ? path.join(releaseDir, 'sysroot')
  : 'C:/Users/mooin/AppData/Local/wasi-sdk/wasi-sdk-34.0-x86_64-windows/share/wasi-sysroot';
const resourceDir = releaseDir
  ? await findResourceDir(path.join(releaseDir, 'resource', 'lib', 'clang'))
  : await findResourceDir(path.join(repoRoot, 'build-single-threaded', 'lib', 'clang'));

const workDir = await mkdtemp(path.join(tmpdir(), 'clang-wasm-nospawn-'));
const threadsSrc = `#include <thread>
#include <mutex>
#include <vector>
#include <iostream>
int main() {
  std::mutex m; long counter = 0;
  std::vector<std::thread> ts;
  for (int i = 0; i < 4; i++)
    ts.emplace_back([&] { for (int j = 0; j < 100000; j++) { std::lock_guard<std::mutex> g(m); counter++; } });
  for (auto& t : ts) t.join();
  std::cout << "counter = " << counter << " (expected 400000)" << std::endl;
  return counter == 400000 ? 0 : 1;
}
`;
await writeFile(path.join(workDir, 'hello.cpp'), threads ? threadsSrc :
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

const sys = `/sysroot/lib/${slice}`;
// node:wasi on Windows can't list directories (opendir -> ENOSYS), so the
// driver's libc++ include-path auto-detection finds nothing here. With a
// release dir we use the packaged compile-flags.json (the documented flags the
// extension must pass); without one, the equivalent hardcoded set.
const subst = (a) => a.replaceAll('${SYSROOT}', '/sysroot').replaceAll('${RESOURCE}', '/resource');
const flags = releaseDir ? JSON.parse(await readFile(path.join(releaseDir, 'compile-flags.json'), 'utf8')) : null;
const compileFlags = flags ? flags.compile[slice].map(subst)
  : ['--target=wasm32-wasip1', '--sysroot=/sysroot', '-resource-dir=/resource',
    '-isystem/sysroot/include/wasm32-wasip1/noeh/c++/v1', '-isystem/sysroot/include/c++/v1', '-fno-exceptions'];
const linkFlags = flags ? flags.link[slice].map(subst)
  : [`${sys}/crt1.o`, `-L${sys}/noeh`, `-L${sys}`, '-lc++', '-lc++abi', '-lc',
    '/resource/lib/wasm32-unknown-wasip1/libclang_rt.builtins.a'];
const rc = await runTool('clang.wasm', ['clang++', ...compileFlags, '-fno-crash-diagnostics', '-c', '/work/hello.cpp', '-o', '/work/hello.o']);
let ok = rc === 0;
if (ok) {
  const lrc = await runTool('lld.wasm', ['wasm-ld', ...linkFlags.slice(0, 1), '/work/hello.o', ...linkFlags.slice(1), '-o', '/work/hello.wasm']);
  ok = lrc === 0;
}
if (ok) {
  const out = await readFile(path.join(workDir, 'hello.wasm'));
  const w = new WASI({ version: 'preview1', args: ['hello'], env: {}, preopens: {} });
  if (threads) {
    const { instance, memory } = await instantiateThreaded(await WebAssembly.compile(out), out,
      w.getImportObject(), { wasmPath: path.join(workDir, 'hello.wasm'), preopens: {} });
    ok = (w.start(makeFakeInstance(instance, memory)) ?? 0) === 0;
  } else {
    const inst = await WebAssembly.instantiate(await WebAssembly.compile(out), w.getImportObject());
    ok = (w.start(inst) ?? 0) === 0;
  }
}
console.error(ok ? 'SMOKETEST PASSED' : 'SMOKETEST FAILED');
process.exit(ok ? 0 : 1);
