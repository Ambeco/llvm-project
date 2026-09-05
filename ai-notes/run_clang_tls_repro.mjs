// Minimal repro attempt for the "memory access out of bounds" crash in
// IRBuilderBase::CreateThreadLocalAddress observed while compiling a
// program using `errno` (thread-local under -pthread) with clang.wasm
// (--target=wasm32-wasip1-threads). Native wasi-sdk clang++ compiles the
// exact same source with zero errors, so this is specific to our
// clang.wasm build, not an upstream LLVM bug -- see ai-notes/wip.md.
import { writeFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { WASI } from 'node:wasi';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { argv as processArgv } from 'node:process';
import { installSpawnHook, findResourceDir } from './wasi_spawn_shim.mjs';
import { instantiateThreaded, makeFakeInstance, loadModule } from './wasi_thread_hook.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const wasmPath = processArgv[2] ?? path.join(repoRoot, 'build', 'bin', 'clang.wasm');
const sysrootPath = processArgv[3] ??
  'C:/Users/mooin/AppData/Local/wasi-sdk/wasi-sdk-34.0-x86_64-windows/share/wasi-sysroot';
const resourceDirPath = await findResourceDir(path.join(repoRoot, 'build', 'lib', 'clang'));

const workDir = await mkdtemp(path.join(tmpdir(), 'clang-wasm-tls-repro-'));
await writeFile(path.join(workDir, 'tls_min2.c'), `#include <errno.h>
#include <string.h>
#include <stdio.h>

int main(void) {
  fprintf(stderr, "err: %s\\n", strerror(errno));
  return 0;
}
`);

const preopens = { '/work': workDir, '/sysroot': sysrootPath, '/resource-dir': resourceDirPath };
const clangArgs = [
  'clang',
  '--target=wasm32-wasip1-threads',
  '-pthread',
  '--sysroot=/sysroot',
  '-resource-dir=/resource-dir',
  '-fno-crash-diagnostics',
  '-c', '/work/tls_min2.c',
  '-o', '/work/tls_min2.o',
];

const wasi = new WASI({ version: 'preview1', args: clangArgs, env: {}, preopens });
const { bytes, module: wasmModule } = await loadModule(wasmPath);
const { instance, memory } = await instantiateThreaded(
  wasmModule, bytes, wasi.getImportObject(), { wasmPath, preopens });
installSpawnHook(instance, { wasmPath, preopens, memory });

console.error(`Running: ${clangArgs.join(' ')}`);
let exitCode = 0;
try {
  const ret = wasi.start(makeFakeInstance(instance, memory));
  if (typeof ret === 'number')
    exitCode = ret;
} catch (e) {
  console.error('Driver instance trapped:', e);
  exitCode = -1;
}
console.error(`Exit code: ${exitCode}`);
try {
  const obj = await readFile(path.join(workDir, 'tls_min2.o'));
  console.error(`tls_min2.o written: ${obj.length} bytes`);
} catch (e) {
  console.error('tls_min2.o was not produced:', e.message);
}
await rm(workDir, { recursive: true, force: true });
