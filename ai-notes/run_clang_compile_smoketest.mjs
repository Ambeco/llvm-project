// Proves clang.wasm can actually *compile* a real translation unit, not
// just run its driver (see run_clang_smoketest.mjs for that narrower
// check). This exercises the real spawn path: the driver instance (this
// script's own WASI instance) invokes cc1 by calling out to
// wasi_spawn_shim.mjs's __wasi_shim_spawn_sync import, which runs cc1 in a
// worker_threads Worker (wasi_spawn_worker.mjs) and blocks until it exits --
// see llvm/lib/Support/Unix/Program.inc for the wasm-side half of this.
//
// Deliberately scoped to compile only (`-c`, no link): this repo's build
// doesn't include lld yet (LLVM_ENABLE_PROJECTS is `clang;compiler-rt`),
// so there's no linker for clang.wasm to invoke. Producing a linked
// executable is a separate, later milestone once lld is added to the build
// and the same spawn plumbing is verified to cover invoking it too.
//
// Usage:
//   node --experimental-wasi-unstable-preview1 ai-notes/run_clang_compile_smoketest.mjs [path-to-clang-wasm] [path-to-wasi-sysroot]
//
// Defaults assume this is run from the repo root against the build.bat
// layout: build/bin/clang.wasm, and the wasi-sdk install location recorded in
// ai-notes/wip.md.
import { writeFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { WASI } from 'node:wasi';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { argv as processArgv } from 'node:process';
import { makeSpawnSyncImport } from './wasi_spawn_shim.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const wasmPath = processArgv[2] ?? path.join(repoRoot, 'build', 'bin', 'clang.wasm');
const sysrootPath = processArgv[3] ??
  'C:/Users/mooin/AppData/Local/wasi-sdk/wasi-sdk-34.0-x86_64-windows/share/wasi-sysroot';
const resourceDirPath = path.join(repoRoot, 'build', 'lib', 'clang', '23');

const workDir = await mkdtemp(path.join(tmpdir(), 'clang-wasm-smoketest-'));
const helloC = `// Minimal proof-of-life for the spawn shim: real libc header (stdio.h,
// resolved via --sysroot) and a real call, compiled by an actual cc1
// subprocess invocation -- not just the driver's --version path.
#include <stdio.h>
int main(void) {
  puts("Hello, world!");
  return 0;
}
`;
await writeFile(path.join(workDir, 'hello.c'), helloC);

// Every wasm instance in this run (driver + every cc1 child) shares this
// same preopen map, matching what the real driver process would see if it
// were a real native process with these directories mounted -- cc1 itself
// is the one that actually opens /work/hello.c, /sysroot/include/*.h, and
// /resource-dir/include/*.h, and writes /work/hello.o.
const preopens = {
  '/work': workDir,
  '/sysroot': sysrootPath,
  '/resource-dir': resourceDirPath,
};

const clangArgs = [
  'clang',
  '--target=wasm32-wasip1',
  '--sysroot=/sysroot',
  '-resource-dir=/resource-dir',
  '-c', '/work/hello.c',
  '-o', '/work/hello.o',
];

const wasi = new WASI({ version: 'preview1', args: clangArgs, env: {}, preopens });

const bytes = await readFile(wasmPath);
console.error(`Loaded ${bytes.length} bytes, compiling wasm module...`);
const wasmModule = await WebAssembly.compile(bytes);

const memoryRef = {};
const importObject = wasi.getImportObject();
importObject.env = {
  __wasi_shim_spawn_sync: makeSpawnSyncImport({ memoryRef, wasmPath, preopens }),
};

console.error('Instantiating driver instance...');
const instance = await WebAssembly.instantiate(wasmModule, importObject);
memoryRef.current = instance.exports.memory;

console.error(`Running: ${clangArgs.join(' ')}`);
let driverExit = 0;
try {
  const ret = wasi.start(instance);
  if (typeof ret === 'number')
    driverExit = ret;
} catch (e) {
  console.error('Driver instance trapped:', e);
  driverExit = -1;
}
console.error(`Driver exited with code ${driverExit}`);

let ok = driverExit === 0;
if (ok) {
  try {
    const obj = await readFile(path.join(workDir, 'hello.o'));
    console.error(`hello.o written: ${obj.length} bytes`);
    ok = obj.length > 0;
  } catch (e) {
    console.error('hello.o was not produced:', e.message);
    ok = false;
  }
}

await rm(workDir, { recursive: true, force: true });
console.error(ok ? 'SMOKETEST PASSED' : 'SMOKETEST FAILED');
process.exit(ok ? 0 : 1);
