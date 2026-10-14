// Proves llvm-ar.wasm works on a stock WASI host: creates, lists, extracts, edits and deletes archive members, is
// deterministic, reports errors with a nonzero exit, and produces archives that wasm-ld can link into a program
// that runs (including an archive of LTO bitcode objects).
//
// Objects and the final link come from wasi-sdk's native clang (this tests llvm-ar, not clang.wasm).
//
// Usage:
//   node --experimental-wasm-type-reflection --experimental-wasi-unstable-preview1 \
//     wasi-tests/run_llvm_ar_smoketest.mjs [--threads] [path-to-llvm-ar.wasm] [path-to-wasi-sdk-clang]
// Default is the single-threaded build (build-single-threaded/bin); --threads uses build/bin and needs the
// wasi-threads host machinery (shared memory + thread-spawn), like the other threaded tools.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { openSync, closeSync, readFileSync } from 'node:fs';
import { WASI } from 'node:wasi';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { argv } from 'node:process';
import { instantiateThreaded, makeFakeInstance, terminateWorkers } from './wasi_thread_hook.mjs';

const execFileAsync = promisify(execFile);
const threads = argv.includes('--threads');
const positional = argv.slice(2).filter((a) => !a.startsWith('--'));
const repoRoot = path.resolve(import.meta.dirname, '..');
const arPath = positional[0] ??
  path.join(repoRoot, threads ? 'build' : 'build-single-threaded', 'bin', 'llvm-ar.wasm');
const clang = positional[1] ?? 'C:/Users/mooin/AppData/Local/wasi-sdk/wasi-sdk-34.0-x86_64-windows/bin/clang.exe';

const workDir = await mkdtemp(path.join(tmpdir(), 'llvm-ar-smoketest-'));
const outDir = await mkdtemp(path.join(tmpdir(), 'llvm-ar-smoketest-out-'));
const preopens = { '/work': workDir };
const arBytes = await readFile(arPath);
const arModule = await WebAssembly.compile(arBytes);

/// Runs llvm-ar.wasm with `args` (guest paths under /work); returns { rc, stdout, stderr }.
let argv0 = 'llvm-ar'; // the tool picks its personality (ar/ranlib) from argv[0]
async function ar(...args) {
  const outFile = path.join(outDir, 'stdout.txt');
  const errFile = path.join(outDir, 'stderr.txt');
  const outFd = openSync(outFile, 'w');
  const errFd = openSync(errFile, 'w');
  const wasi = new WASI({ version: 'preview1', args: [argv0, ...args], env: {}, preopens,
    stdout: outFd, stderr: errFd, returnOnExit: true });
  let rc;
  let workers;
  try {
    if (threads) {
      const r = await instantiateThreaded(arModule, arBytes, wasi.getImportObject(), { wasmPath: arPath, preopens });
      workers = r.workers;
      rc = wasi.start(makeFakeInstance(r.instance, r.memory)) ?? 0;
    } else {
      const instance = await WebAssembly.instantiate(arModule, wasi.getImportObject());
      rc = wasi.start(instance) ?? 0;
    }
  } catch (e) {
    rc = -1;
    writeFileSyncSafe(errFile, `trapped: ${e?.stack ?? e}`);
  } finally {
    if (workers) await terminateWorkers(workers);
    closeSync(outFd);
    closeSync(errFd);
  }
  return { rc, stdout: readFileSync(outFile, 'utf8'), stderr: readFileSync(errFile, 'utf8') };
}
function writeFileSyncSafe(f, s) { try { readFileSync(f); } catch {} void s; }

let allOk = true;
function check(name, cond, detail = '') {
  console.error(`${cond ? 'PASS' : 'FAIL'}: ${name}${cond ? '' : ` -- ${detail}`}`);
  allOk &&= cond;
}
const rd = (f) => readFile(path.join(workDir, f));

const srcs = {
  'a.c': 'int a_value(void) { return 2; }\n',
  'b.c': 'int b_value(void) { return 3; }\n',
  'main.c': '#include <stdio.h>\nint a_value(void); int b_value(void);\nint main(void) { printf("sum=%d\\n", a_value() + b_value()); return 0; }\n',
};
for (const [f, s] of Object.entries(srcs)) await writeFile(path.join(workDir, f), s);
const cc = (args) => execFileAsync(clang, ['--target=wasm32-wasip1', ...args], { cwd: workDir });
for (const f of ['a', 'b', 'main']) await cc(['-c', '-O1', `${f}.c`, '-o', `${f}.o`]);
for (const f of ['a', 'b']) await cc(['-c', '-O1', '-flto', `${f}.c`, '-o', `${f}.lto.o`]);

console.error(threads ? 'Threaded llvm-ar.wasm' : 'Single-threaded llvm-ar.wasm');
try {
  // Does the module's shape match the variant? The threaded build imports a shared memory; it only imports
  // wasi.thread-spawn if the tool actually spawns threads (llvm-ar does not), so that is not asserted.
  const imports = WebAssembly.Module.imports(arModule).map((i) => `${i.module}.${i.name}`);
  check(threads ? 'threaded build imports env.memory' : 'single-threaded build imports neither env.memory nor thread-spawn',
    threads ? imports.includes('env.memory') : !imports.includes('env.memory') && !imports.includes('wasi.thread-spawn'),
    imports.filter((i) => !i.startsWith('wasi_snapshot')).join(','));

  let r = await ar('rcs', '/work/libab.a', '/work/a.o', '/work/b.o');
  check('create archive (rcs)', r.rc === 0, `${r.rc} ${r.stderr}`);
  r = await ar('t', '/work/libab.a');
  check('list members (t)', r.rc === 0 && r.stdout.split(/\r?\n/).filter(Boolean).join(',') === 'a.o,b.o', JSON.stringify(r));
  r = await ar('s', '/work/libab.a'); // regenerate symbol table
  check('write symbol table (s)', r.rc === 0, r.stderr);

  // Archive is consumable by wasm-ld and the program runs.
  await cc(['main.o', 'libab.a', '-o', 'prog.wasm']);
  const progWasi = new WASI({ version: 'preview1', args: ['prog'], env: {}, preopens: {}, stdout: openSync(path.join(outDir, 'prog.txt'), 'w'), returnOnExit: true });
  const progInst = await WebAssembly.instantiate(await WebAssembly.compile(await rd('prog.wasm')), progWasi.getImportObject());
  const progRc = progWasi.start(progInst) ?? 0;
  check('program linked from the archive runs and prints sum=5', progRc === 0 && readFileSync(path.join(outDir, 'prog.txt'), 'utf8').trim() === 'sum=5', `rc=${progRc}`);

  // Extract returns the original bytes. Plain `x` writes into the cwd, which WASI does not have (it fails with
  // "No such file or directory"), so extraction needs --output=<dir>.
  await mkdir(path.join(workDir, 'ex'));
  const original = await rd('a.o');
  r = await ar('x', '--output=/work/ex', '/work/libab.a', 'a.o');
  check('extract member (x --output) is byte-identical to the original', r.rc === 0 && Buffer.compare(await rd('ex/a.o'), original) === 0, JSON.stringify(r));
  r = await ar('x', '/work/libab.a', 'a.o');
  check('extract without --output fails loudly (no cwd on WASI)', r.rc !== 0 && /a\.o/.test(r.stderr), JSON.stringify(r));

  // Edit: add, then delete, a member.
  r = await ar('r', '/work/libab.a', '/work/main.o');
  r = await ar('t', '/work/libab.a');
  check('add member (r)', r.stdout.split(/\r?\n/).filter(Boolean).join(',') === 'a.o,b.o,main.o', r.stdout);
  r = await ar('d', '/work/libab.a', 'main.o');
  r = await ar('t', '/work/libab.a');
  check('delete member (d)', r.stdout.split(/\r?\n/).filter(Boolean).join(',') === 'a.o,b.o', r.stdout);

  // llvm-ranlib is this same binary run with argv[0] "llvm-ranlib".
  argv0 = 'llvm-ranlib';
  r = await ar('/work/libab.a');
  argv0 = 'llvm-ar';
  check('ranlib personality (argv[0]=llvm-ranlib) rewrites the symbol table', r.rc === 0, JSON.stringify(r));

  // Deterministic output (same inputs -> identical bytes), needed for reproducible/cached builds.
  await ar('rcsD', '/work/d1.a', '/work/a.o', '/work/b.o');
  await ar('rcsD', '/work/d2.a', '/work/a.o', '/work/b.o');
  check('deterministic: two identical runs give identical archives', Buffer.compare(await rd('d1.a'), await rd('d2.a')) === 0);

  // LTO bitcode archive links with -flto.
  r = await ar('rcs', '/work/liblto.a', '/work/a.lto.o', '/work/b.lto.o');
  check('archive of LTO bitcode objects', r.rc === 0, r.stderr);
  await cc(['-flto', 'main.o', 'liblto.a', '-o', 'proglto.wasm']);
  const lw = new WASI({ version: 'preview1', args: ['p'], env: {}, preopens: {}, stdout: openSync(path.join(outDir, 'lto.txt'), 'w'), returnOnExit: true });
  const li = await WebAssembly.instantiate(await WebAssembly.compile(await rd('proglto.wasm')), lw.getImportObject());
  check('program linked from the LTO archive (-flto) runs', (lw.start(li) ?? 0) === 0 && readFileSync(path.join(outDir, 'lto.txt'), 'utf8').trim() === 'sum=5');

  // Errors: nonzero exit and a message naming the problem.
  r = await ar('r', '/work/err.a', '/work/does_not_exist.o');
  check('missing member: nonzero exit with a message', r.rc !== 0 && /does_not_exist/.test(r.stderr), JSON.stringify(r));
  r = await ar('--version');
  check('--version runs', r.rc === 0 && /LLVM/i.test(r.stdout), JSON.stringify(r));
} catch (e) {
  check('smoketest ran without exception', false, e?.stack ?? String(e));
}

await rm(workDir, { recursive: true, force: true });
await rm(outDir, { recursive: true, force: true });
console.error(allOk ? 'SMOKETEST PASSED' : 'SMOKETEST FAILED');
process.exit(allOk ? 0 : 1);
