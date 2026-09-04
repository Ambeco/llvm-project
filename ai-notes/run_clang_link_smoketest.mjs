// Proves clang.wasm can compile *and link* a real translation unit into a
// runnable wasm binary -- the actual "Hello World" milestone. Builds on
// run_clang_compile_smoketest.mjs (read that first): the same
// __wasi_shim_spawn_sync plumbing now also has to spawn a genuinely
// *different* wasm binary for the link step (build/bin/wasm-ld, not
// clang.wasm itself) -- see wasi_spawn_shim.mjs's resolveGuestPath() for how
// the shim tells the two cases apart.
//
// Usage:
//   node --experimental-wasi-unstable-preview1 ai-notes/run_clang_link_smoketest.mjs [path-to-clang-wasm] [path-to-wasi-sysroot]
import { writeFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { WASI } from 'node:wasi';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { argv as processArgv } from 'node:process';
import { makeSpawnSyncImport, findResourceDir } from './wasi_spawn_shim.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const wasmPath = processArgv[2] ?? path.join(repoRoot, 'build', 'bin', 'clang.wasm');
const binDir = path.dirname(wasmPath);
const sysrootPath = processArgv[3] ??
  'C:/Users/mooin/AppData/Local/wasi-sdk/wasi-sdk-34.0-x86_64-windows/share/wasi-sysroot';
const resourceDirPath = await findResourceDir(path.join(repoRoot, 'build', 'lib', 'clang'));

const workDir = await mkdtemp(path.join(tmpdir(), 'clang-wasm-link-smoketest-'));
const helloC = `#include <stdio.h>
int main(void) {
  puts("Hello, world!");
  return 0;
}
`;
await writeFile(path.join(workDir, 'hello.c'), helloC);

// "/bin" is new here relative to run_clang_compile_smoketest.mjs: it's how
// the driver actually *finds* wasm-ld (Driver::GetProgramPath() searches
// PATH, since getMainExecutable() returns "" on WASI -- see Path.inc -- so
// it can't derive its own install dir the way a real installed clang would).
// clang doesn't emit a linker input directly from the driver -- it compiles
// hello.c to a temp .o first, then invokes wasm-ld on that -- so it needs
// somewhere to put that temp file too.
const tmpDir = await mkdtemp(path.join(tmpdir(), 'clang-wasm-link-smoketest-tmp-'));
const preopens = {
  '/work': workDir,
  '/sysroot': sysrootPath,
  '/resource-dir': resourceDirPath,
  '/bin': binDir,
  '/tmp': tmpDir,
};

const clangArgs = [
  'clang',
  '--target=wasm32-wasip1',
  '--sysroot=/sysroot',
  '-resource-dir=/resource-dir',
  '/work/hello.c',
  '-o', '/work/hello.wasm',
];

const wasi = new WASI({
  version: 'preview1',
  args: clangArgs,
  env: { PATH: '/bin', TMPDIR: '/tmp' },
  preopens,
});

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
let outBytes = null;
if (ok) {
  try {
    outBytes = await readFile(path.join(workDir, 'hello.wasm'));
    console.error(`hello.wasm written: ${outBytes.length} bytes`);
    ok = outBytes.length > 0 && outBytes[0] === 0x00 && outBytes[1] === 0x61 &&
         outBytes[2] === 0x73 && outBytes[3] === 0x6d; // '\0asm'
    if (!ok)
      console.error('hello.wasm does not start with the wasm magic number');
  } catch (e) {
    console.error('hello.wasm was not produced:', e.message);
    ok = false;
  }
}

// The real proof it's a genuinely linked, runnable binary: actually run it
// (a plain node:wasi instance, same as run_clang_smoketest.mjs -- no custom
// imports needed, hello.wasm doesn't spawn anything).
if (ok) {
  console.error('Running the linked hello.wasm...');
  const helloWasi = new WASI({ version: 'preview1', args: ['hello'], env: {}, preopens: {} });
  const helloModule = await WebAssembly.compile(outBytes);
  const helloInstance = await WebAssembly.instantiate(helloModule, helloWasi.getImportObject());
  let helloExit = 0;
  try {
    const ret = helloWasi.start(helloInstance);
    if (typeof ret === 'number')
      helloExit = ret;
  } catch (e) {
    console.error('hello.wasm trapped:', e);
    helloExit = -1;
  }
  console.error(`hello.wasm exited with code ${helloExit}`);
  ok = helloExit === 0;
}

await rm(workDir, { recursive: true, force: true });
await rm(tmpDir, { recursive: true, force: true });
console.error(ok ? 'SMOKETEST PASSED' : 'SMOKETEST FAILED');
process.exit(ok ? 0 : 1);
