// Packages the build outputs into one release tree for the vsclang extension:
//
//   <out>/bin/clang.wasm, lld.wasm            single-process, single-thread (build-single-threaded)
//   <out>/bin/clang-threads.wasm, lld-threads.wasm   threaded pair (build)
//   <out>/bin/lldb.wasm, lldb-wasm-reactor.wasm      (build-lldb, skipped if absent)
//   <out>/sysroot/include, sysroot/lib        wasip1 + wasip1-threads slices of wasi-sdk's sysroot
//   <out>/resource/lib/clang/<ver>/           clang resource dir from the threaded build
//   <out>/MANIFEST                            sha256 + size of every file, plus the release tag
//
// The threaded build's resource dir is used because it is the only one that
// has both libclang_rt.builtins.a variants and libclang_rt.wasi_threaded_io.
//
// Usage: node wasi-tests/package_release.mjs <tag> [out-dir] [path-to-wasi-sysroot]
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { argv } from 'node:process';
import { findResourceDir } from './wasi_spawn_shim.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tag = argv[2];
if (!tag)
  throw new Error('usage: node wasi-tests/package_release.mjs <tag> [out-dir] [wasi-sysroot]\n' +
    'did you forget the release tag (e.g. v0.1.0)? Binaries and sysroot are tagged together.');
const outDir = path.resolve(argv[3] ?? path.join(repoRoot, 'release', tag));
const sysrootSrc = argv[4] ??
  'C:/Users/mooin/AppData/Local/wasi-sdk/wasi-sdk-34.0-x86_64-windows/share/wasi-sysroot';

const SLICES = ['wasm32-wasip1', 'wasm32-wasip1-threads'];

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function mustExist(p, hint) {
  if (!(await exists(p)))
    throw new Error(`missing ${p}\n${hint}`);
  return p;
}

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else out.push(p);
  }
  return out;
}

await rm(outDir, { recursive: true, force: true });
await mkdir(path.join(outDir, 'bin'), { recursive: true });

const single = path.join(repoRoot, 'build-single-threaded', 'bin');
const threaded = path.join(repoRoot, 'build', 'bin');
const copies = [
  [path.join(single, 'clang.wasm'), 'bin/clang.wasm', 'run build-single-threaded.bat'],
  [path.join(single, 'lld.wasm'), 'bin/lld.wasm', 'run build-single-threaded.bat'],
  [path.join(threaded, 'clang.wasm'), 'bin/clang-threads.wasm', 'run build.bat'],
  [path.join(threaded, 'lld.wasm'), 'bin/lld-threads.wasm', 'run build.bat'],
];
for (const [src, dst, hint] of copies)
  await copyFile(await mustExist(src, hint), path.join(outDir, dst));

for (const name of ['lldb.wasm', 'lldb-wasm-reactor.wasm']) {
  const src = path.join(repoRoot, 'build-lldb', 'bin', name);
  if (await exists(src))
    await copyFile(src, path.join(outDir, 'bin', name));
  else
    console.error(`note: ${src} not found; skipping (run build-lldb.bat to include it)`);
}

for (const sub of ['include', 'lib']) {
  for (const slice of SLICES) {
    await cp(path.join(sysrootSrc, sub, slice), path.join(outDir, 'sysroot', sub, slice),
      { recursive: true });
  }
}
// libc++ headers live outside the per-triple dirs in wasi-sdk's layout.
await cp(path.join(sysrootSrc, 'include', 'c++'), path.join(outDir, 'sysroot', 'include', 'c++'),
  { recursive: true });

const resSrc = await findResourceDir(path.join(repoRoot, 'build', 'lib', 'clang'));
const ver = path.basename(resSrc);
await cp(resSrc, path.join(outDir, 'resource', 'lib', 'clang', ver), { recursive: true });

const lines = [`tag ${tag}`, `clang-resource-version ${ver}`];
let total = 0;
for (const f of (await walk(outDir)).sort()) {
  const buf = await readFile(f);
  total += buf.length;
  const rel = path.relative(outDir, f).split(path.sep).join('/');
  lines.push(`${createHash('sha256').update(buf).digest('hex')}  ${buf.length}  ${rel}`);
}
await writeFile(path.join(outDir, 'MANIFEST'), lines.join('\n') + '\n');

const sysrootFiles = (await walk(path.join(outDir, 'sysroot'))).length;
console.error(`packaged ${lines.length - 2} files, ${(total / 1048576).toFixed(1)} MiB total -> ${outDir}`);
console.error(`(sysroot: ${sysrootFiles} files; see MANIFEST for per-file sizes)`);
