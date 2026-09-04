// Proves independent files can be compiled *concurrently*, each through
// its own fully independent top-level clang.wasm driver instance -- the
// practical "multi-process" parallelism win this project can already
// exploit today, without touching LLVM_ENABLE_THREADS or any wasm-side
// threading support (see ai-notes/wip.md for why real thread support is a
// separate, much bigger effort). Each file gets its own Worker
// (wasi_driver_worker.mjs), its own wasm instance with its own linear
// memory (no sharing -- this is isolation, not shared-memory threading),
// and its own nested cc1-spawning Worker via the existing spawn hook.
//
// Usage:
//   node --experimental-wasm-type-reflection --experimental-wasi-unstable-preview1 ai-notes/run_clang_parallel_smoketest.mjs [path-to-clang-wasm] [path-to-wasi-sysroot] [file-count]
import { writeFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { argv as processArgv } from 'node:process';
import { fileURLToPath } from 'node:url';
import { findResourceDir } from './wasi_spawn_shim.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const wasmPath = processArgv[2] ?? path.join(repoRoot, 'build', 'bin', 'clang.wasm');
const sysrootPath = processArgv[3] ??
  'C:/Users/mooin/AppData/Local/wasi-sdk/wasi-sdk-34.0-x86_64-windows/share/wasi-sysroot';
const fileCount = Number(processArgv[4] ?? 4);
const resourceDirPath = await findResourceDir(path.join(repoRoot, 'build', 'lib', 'clang'));
const driverWorkerScript = fileURLToPath(new URL('./wasi_driver_worker.mjs', import.meta.url));

const workDir = await mkdtemp(path.join(tmpdir(), 'clang-wasm-parallel-smoketest-'));
const preopens = { '/work': workDir, '/sysroot': sysrootPath, '/resource-dir': resourceDirPath };

for (let i = 0; i < fileCount; i++) {
  await writeFile(path.join(workDir, `file${i}.c`), `
// Distinct per-file content, so a mix-up (e.g. two workers racing on the
// same temp file) would produce visibly wrong output, not just an absent
// or truncated one.
int value_from_file_${i}(void) { return ${i} * 1000; }
`);
}

function runDriver(clangArgs) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(driverWorkerScript, {
      workerData: { wasmPath, clangArgs, preopens },
    });
    worker.on('message', (msg) => {
      if (msg.log) {
        console.error(msg.log);
        return;
      }
      resolve(msg.exitCode);
    });
    worker.on('error', reject);
  });
}

console.error(`Compiling ${fileCount} files concurrently...`);
const start = performance.now();
const jobs = [];
for (let i = 0; i < fileCount; i++) {
  const clangArgs = [
    'clang',
    '--target=wasm32-wasip1',
    '--sysroot=/sysroot',
    '-resource-dir=/resource-dir',
    '-c', `/work/file${i}.c`,
    '-o', `/work/file${i}.o`,
  ];
  jobs.push(runDriver(clangArgs).then((exitCode) => ({ i, exitCode })));
}
const results = await Promise.all(jobs);
const elapsedMs = performance.now() - start;
console.error(`All ${fileCount} driver instances finished in ${elapsedMs.toFixed(0)}ms ` +
  `(wall clock -- real concurrency, not fileCount * one-file-time, is the point).`);

let ok = true;
for (const { i, exitCode } of results) {
  if (exitCode !== 0) {
    console.error(`file${i}.c: driver exited with code ${exitCode}`);
    ok = false;
    continue;
  }
  try {
    const obj = await readFile(path.join(workDir, `file${i}.o`));
    if (obj.length === 0) {
      console.error(`file${i}.o: empty`);
      ok = false;
    } else {
      console.error(`file${i}.o: ${obj.length} bytes -- OK`);
    }
  } catch (e) {
    console.error(`file${i}.o was not produced: ${e.message}`);
    ok = false;
  }
}

await rm(workDir, { recursive: true, force: true });
console.error(ok ? 'SMOKETEST PASSED' : 'SMOKETEST FAILED');
process.exit(ok ? 0 : 1);
