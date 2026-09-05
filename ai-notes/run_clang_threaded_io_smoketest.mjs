// Tests the one thing run_clang_threaded_output_smoketest.mjs deliberately
// didn't: a *user's own compiled program* doing concurrent file I/O across
// its own threads. Two cases, compiled into one C program
// (ai-notes/../ scratch file written below):
//
//   Case A: main thread opens ONE fd, shares it (a plain int) with worker
//   threads -- completely normal in a real process, since all pthreads
//   share one fd table by definition. Each thread pwrite()s at a distinct
//   offset using that SAME fd number.
//   Case B (control): each thread opens its OWN fd to the same path
//   independently.
//
// This project's current design gives each spawned thread its own
// independent node:wasi instance (see wasi_thread_worker.mjs) with its own
// fd table -- so Case A is expected to be where a real gap shows up, if
// one exists. This test exists to find out what actually happens
// (silent wrong output, a clean error, or does it just work), not to
// assume an answer -- see ai-notes/wip.md for the result.
//
// Usage:
//   node --experimental-wasm-type-reflection --experimental-wasi-unstable-preview1 ai-notes/run_clang_threaded_io_smoketest.mjs [path-to-clang-wasm] [path-to-wasi-sysroot]
import { writeFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { WASI } from 'node:wasi';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { argv as processArgv } from 'node:process';
import { installSpawnHook, findResourceDir } from './wasi_spawn_shim.mjs';
import { instantiateThreaded, makeFakeInstance, loadModule } from './wasi_thread_hook.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const wasmPath = processArgv[2] ?? path.join(repoRoot, 'build', 'bin', 'clang.wasm');
const binDir = path.dirname(wasmPath);
const sysrootPath = processArgv[3] ??
  'C:/Users/mooin/AppData/Local/wasi-sdk/wasi-sdk-34.0-x86_64-windows/share/wasi-sysroot';
const resourceDirPath = await findResourceDir(path.join(repoRoot, 'build', 'lib', 'clang'));
// Pass --no-shim as a 5th arg to prove -mno-wasi-threaded-io actually
// disables compiler-rt/lib/wasi_threaded_io -- Case A should go back to
// failing with EBADF, the same as before that runtime existed.
const noShim = processArgv[4] === '--no-shim';

const workDir = await mkdtemp(path.join(tmpdir(), 'clang-wasm-threaded-io-'));
const tmpDir = await mkdtemp(path.join(tmpdir(), 'clang-wasm-threaded-io-tmp-'));
const sourceC = await readFile(
  'C:/Users/mooin/AppData/Local/Temp/claude/threadtest/hello_threads_io.c', 'utf-8');
await writeFile(path.join(workDir, 'hello_threads_io.c'), sourceC);

const preopens = {
  '/work': workDir,
  '/sysroot': sysrootPath,
  '/resource-dir': resourceDirPath,
  '/bin': binDir,
  '/tmp': tmpDir,
};

const clangArgs = [
  'clang',
  '--target=wasm32-wasip1-threads',
  '-pthread',
  '--sysroot=/sysroot',
  '-resource-dir=/resource-dir',
  // -Wl,--import-memory deliberately NOT passed here anymore: the driver
  // (WebAssembly.cpp's WantsSharedMemory handling) now adds it
  // automatically for -pthread WASI-threads targets -- this smoketest is
  // exactly what proves that. -Wl,--max-memory is unrelated (wasm-ld
  // defaults a memory's max to its min unless this is set explicitly;
  // still needs to be passed by hand) so it stays.
  '-Wl,--max-memory=2147483648',
  '-fno-crash-diagnostics', // the crash-reproducer path itself needs I/O
                            // redirection, unsupported by our Program.inc
                            // -- suppress it so a real cc1 crash surfaces
                            // directly instead of being masked by a
                            // second, unrelated failure.
  '/work/hello_threads_io.c',
  '-o', '/work/hello_threads_io.wasm',
];
if (noShim)
  clangArgs.splice(clangArgs.length - 2, 0, '-mno-wasi-threaded-io');

const wasi = new WASI({
  version: 'preview1',
  args: clangArgs,
  env: { PATH: '/bin', TMPDIR: '/tmp' },
  preopens,
});

const { bytes, module: wasmModule } = await loadModule(wasmPath);
console.error('Instantiating driver instance...');
const { instance, memory } = await instantiateThreaded(
  wasmModule, bytes, wasi.getImportObject(), { wasmPath, preopens });
installSpawnHook(instance, { wasmPath, preopens, memory });

console.error(`Compiling: ${clangArgs.join(' ')}`);
let driverExit = 0;
try {
  const ret = wasi.start(makeFakeInstance(instance, memory));
  if (typeof ret === 'number')
    driverExit = ret;
} catch (e) {
  console.error('Driver instance trapped:', e);
  driverExit = -1;
}
console.error(`Driver exited with code ${driverExit}`);

let programExit = null;
if (driverExit === 0) {
  const outPath = path.join(workDir, 'hello_threads_io.wasm');
  const outBytes = await readFile(outPath);
  console.error(`hello_threads_io.wasm written: ${outBytes.length} bytes`);
  console.error('Running the compiled program...');
  const helloModule = await WebAssembly.compile(outBytes);
  const helloWasi = new WASI({
    version: 'preview1', args: ['hello_threads_io'], env: {},
    preopens: { '/work': workDir },
  });
  try {
    const { instance: helloInstance, memory: helloMemory } = await instantiateThreaded(
      helloModule, outBytes, helloWasi.getImportObject(), { wasmPath: outPath, preopens: { '/work': workDir } });
    try {
      const ret = helloWasi.start(makeFakeInstance(helloInstance, helloMemory));
      programExit = typeof ret === 'number' ? ret : 0;
    } catch (e) {
      console.error('hello_threads_io.wasm trapped:', e);
      programExit = -1;
    }
  } catch (e) {
    console.error('Could not run the compiled program as a wasi-threads module:', e);
    programExit = -1;
  }
  console.error(`hello_threads_io.wasm exited with code ${programExit}`);
}

// Independently inspect the actual files from the host side too, not just
// trusting the program's own fopen/fread self-check.
console.error('\n--- Host-side inspection of the actual files ---');
for (const name of ['case_a.txt', 'case_b.txt']) {
  try {
    const contents = await readFile(path.join(workDir, name), 'utf-8');
    console.error(`${name} (${contents.length} bytes):\n${contents}`);
  } catch (e) {
    console.error(`${name}: could not read (${e.message})`);
  }
}

await rm(workDir, { recursive: true, force: true });
await rm(tmpDir, { recursive: true, force: true });
console.error(programExit === 0 ? 'RESULT: program reported success' : 'RESULT: program reported failure or trapped');
// The shim's dedicated I/O-owner thread (and its worker pthreads) are
// real Worker threads that outlive the WASI instance's own exit -- same
// operational requirement documented in
// documents/threaded-file-io-rpc-plan.md for any host running a
// wasi-threads binary. Without an explicit exit, this process now hangs
// by default (it didn't before wasi_threaded_io was linked in
// automatically).
process.exit(programExit === 0 ? 0 : 1);
