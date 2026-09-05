// Answers a question that's easy to get confused about: clang.wasm ITSELF
// now runs multithreaded (see wip.md's STATUS), but that's completely
// independent of whether *output* programs clang.wasm compiles (for a
// user's own -pthread/--target=wasm32-wasip1-threads code) actually work.
// This compiles+links a real multithreaded C program (4 pthreads, a
// mutex-protected shared counter -- same shape as the standalone
// wasi-threads prototype) *through clang.wasm*, then runs the resulting
// output binary through our own thread-hosting machinery, to see if a
// program clang.wasm produces is itself a correct wasi-threads module.
//
// Usage:
//   node --experimental-wasm-type-reflection --experimental-wasi-unstable-preview1 ai-notes/run_clang_threaded_output_smoketest.mjs [path-to-clang-wasm] [path-to-wasi-sysroot]
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

const workDir = await mkdtemp(path.join(tmpdir(), 'clang-wasm-threaded-output-'));
const tmpDir = await mkdtemp(path.join(tmpdir(), 'clang-wasm-threaded-output-tmp-'));
const helloC = `#include <stdio.h>
#include <pthread.h>

pthread_mutex_t m = PTHREAD_MUTEX_INITIALIZER;
long counter = 0;

void *worker(void *arg) {
  int n = (int)(long)arg;
  for (int i = 0; i < 100000; i++) {
    pthread_mutex_lock(&m);
    counter++;
    pthread_mutex_unlock(&m);
  }
  printf("thread %d done\\n", n);
  return NULL;
}

int main(void) {
  pthread_t threads[4];
  for (long i = 0; i < 4; i++)
    pthread_create(&threads[i], NULL, worker, (void *)i);
  for (int i = 0; i < 4; i++)
    pthread_join(threads[i], NULL);
  printf("counter = %ld (expected 400000)\\n", counter);
  return counter == 400000 ? 0 : 1;
}
`;
await writeFile(path.join(workDir, 'hello_threads.c'), helloC);

const preopens = {
  '/work': workDir,
  '/sysroot': sysrootPath,
  '/resource-dir': resourceDirPath,
  '/bin': binDir,
  '/tmp': tmpDir,
};

// The key difference from run_clang_link_smoketest.mjs: -pthread and a
// threads-capable output target, instead of plain wasm32-wasip1.
const clangArgs = [
  'clang',
  '--target=wasm32-wasip1-threads',
  '-pthread',
  '--sysroot=/sysroot',
  '-resource-dir=/resource-dir',
  // -pthread alone gets you -Wl,--shared-memory automatically (confirmed:
  // visible in the wasm-ld invocation this test logs) but NOT
  // --import-memory/--max-memory -- that's not a clang.wasm bug, it's how
  // wasi-sdk's toolchain works in general (confirmed against native
  // wasi-sdk clang++ too, see ai-notes/wip.md). A host that needs to
  // supply its own shared memory across multiple Worker instantiations
  // (like ours) needs the program built with these explicitly.
  '-Wl,--import-memory', '-Wl,--max-memory=2147483648',
  '/work/hello_threads.c',
  '-o', '/work/hello_threads.wasm',
];

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

console.error(`Running: ${clangArgs.join(' ')}`);
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

let ok = driverExit === 0;
let outBytes = null;
if (ok) {
  try {
    outBytes = await readFile(path.join(workDir, 'hello_threads.wasm'));
    console.error(`hello_threads.wasm written: ${outBytes.length} bytes`);
    ok = outBytes.length > 0;
  } catch (e) {
    console.error('hello_threads.wasm was not produced:', e.message);
    ok = false;
  }
}

if (ok) {
  console.error('Running the compiled multithreaded program...');
  const helloModule = await WebAssembly.compile(outBytes);
  const helloWasi = new WASI({ version: 'preview1', args: ['hello_threads'], env: {}, preopens: {} });
  try {
    const { instance: helloInstance, memory: helloMemory } = await instantiateThreaded(
      helloModule, outBytes, helloWasi.getImportObject(), { wasmPath: path.join(workDir, 'hello_threads.wasm'), preopens: {} });
    let helloExit = 0;
    try {
      const ret = helloWasi.start(makeFakeInstance(helloInstance, helloMemory));
      if (typeof ret === 'number')
        helloExit = ret;
    } catch (e) {
      console.error('hello_threads.wasm trapped:', e);
      helloExit = -1;
    }
    console.error(`hello_threads.wasm exited with code ${helloExit}`);
    ok = helloExit === 0;
  } catch (e) {
    console.error('Could not run the compiled program as a wasi-threads module:', e);
    ok = false;
  }
}

await rm(workDir, { recursive: true, force: true });
await rm(tmpDir, { recursive: true, force: true });
console.error(ok ? 'SMOKETEST PASSED' : 'SMOKETEST FAILED');
process.exit(ok ? 0 : 1);
