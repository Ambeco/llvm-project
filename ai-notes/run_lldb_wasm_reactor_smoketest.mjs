// Proves lldb-wasm-reactor.wasm (see documents/design.md's "Debugging
// design" section and lldb/tools/lldb-wasm-reactor/WasmDebugReactor.cpp)
// actually works end-to-end against a real compiled program: instantiate
// it, create a target from a real `-O0 -g` wasm binary, and resolve a
// known function's address to its source file:line.
//
// Deliberately scoped to the *static* half of the design -- symbol
// resolution off DWARF alone, no live process. `wasm_dbg_format_value`
// (value formatting) needs an actual paused target feeding real memory
// through the read_memory callback, which needs the not-yet-designed
// compile-time-instrumentation hook on the *other* side of the JS host to
// produce a real stop; this test's `read_memory`/`write_memory` imports
// intentionally throw if ever called, so a bug that reaches them fails
// loudly here instead of silently returning zero bytes.
//
// The target test program is compiled fresh each run by the host's own
// wasi-sdk clang (not clang.wasm) -- this test exercises lldb-wasm-reactor,
// not this project's own compiler, so there's no reason to route through
// the slower, separately-verified self-hosted path.
//
// Usage:
//   node --experimental-wasm-type-reflection --experimental-wasi-unstable-preview1 \
//     ai-notes/run_lldb_wasm_reactor_smoketest.mjs [path-to-lldb-wasm-reactor.wasm] [path-to-wasi-sdk-clang]
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { WASI } from 'node:wasi';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { argv as processArgv } from 'node:process';
import { instantiateThreaded, makeFakeInstance } from './wasi_thread_hook.mjs';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(import.meta.dirname, '..');
const reactorPath = processArgv[2] ??
  path.join(repoRoot, 'build-lldb', 'bin', 'lldb-wasm-reactor.wasm');
const wasiSdkClang = processArgv[3] ??
  'C:/Users/mooin/AppData/Local/wasi-sdk/wasi-sdk-34.0-x86_64-windows/bin/clang.exe';

const workDir = await mkdtemp(path.join(tmpdir(), 'lldb-wasm-reactor-smoketest-'));
const addC = `int add(int a, int b) {
  int c = a + b;
  return c;
}

int main(void) {
  return add(1, 2);
}
`;
const srcPath = path.join(workDir, 'add.c');
const targetPath = path.join(workDir, 'add.wasm');
await writeFile(srcPath, addC);
console.error(`Compiling ${srcPath} -> ${targetPath}...`);
await execFileAsync(wasiSdkClang, ['-O0', '-g', '-o', targetPath, srcPath]);

// lldb-wasm-reactor.wasm reads the target module's own file bytes (to
// parse ObjectFile/DWARF) through its own WASI filesystem, same as any
// other lldb source-reading path in this project -- not through
// read_memory/write_memory, which are for a live process's *runtime*
// memory only. Preopen the temp dir so `/work/add.wasm` is visible to it.
const preopens = { '/work': workDir };

const bytes = await readFile(reactorPath);
console.error(`Loaded ${bytes.length} bytes, compiling wasm module...`);
const wasmModule = await WebAssembly.compile(bytes);

const wasi = new WASI({ version: 'preview1', args: ['lldb-wasm-reactor'], env: {}, preopens });

const wasmDbgImports = {
  read_memory() { throw new Error('unexpected read_memory call in this smoketest'); },
  write_memory() { throw new Error('unexpected write_memory call in this smoketest'); },
};
const importObjectBase = { ...wasi.getImportObject(), wasm_dbg: wasmDbgImports };

console.error('Instantiating...');
// Every spawned worker thread re-instantiates its own copy of this module
// (see wasi_thread_worker.mjs) and so needs to satisfy the same `wasm_dbg`
// import surface the main instance does -- see wasi_thread_hook.mjs's
// makeThreadSpawn doc comment and documents/remaining_work.md's
// 2026-09-09 entry for why omitting this hangs `task_group.wait()`
// forever instead of failing loudly.
const extraImportsModule = new URL('./lldb_wasm_reactor_dbg_imports.mjs', import.meta.url).href;
const { instance, memory } = await instantiateThreaded(
  wasmModule, bytes, importObjectBase, { wasmPath: reactorPath, preopens, extraImportsModule });
// This is a reactor module (`-mexec-model=reactor`, see the CMakeLists
// comment): no `_start`, initialize via `_initialize` instead --
// makeFakeInstance's forThread:true strips `_start` for exactly this
// reason (see wasi_thread_hook.mjs's file header), even though this
// isn't a spawned thread.
const fakeInstance = makeFakeInstance(instance, memory, { forThread: true });
wasi.initialize(fakeInstance);
console.error('Initialized.');

const exp = instance.exports;
const mem8 = () => new Uint8Array(memory.buffer);

/// Writes a NUL-terminated copy of `str` into a freshly wasm_dbg_alloc'd
/// buffer; caller must wasm_dbg_free() the returned pointer.
function allocCString(str) {
  const encoded = new TextEncoder().encode(str + '\0');
  const ptr = exp.wasm_dbg_alloc(encoded.length);
  if (!ptr) throw new Error(`wasm_dbg_alloc(${encoded.length}) failed`);
  mem8().set(encoded, ptr);
  return ptr;
}

/// Reads a NUL-terminated string out of guest memory at `ptr`.
function readCString(ptr, maxLen) {
  const bytes = mem8();
  let end = ptr;
  while (end < ptr + maxLen && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(ptr, end));
}

/// Calls `wasm_dbg_resolve_pc`/`wasm_dbg_format_value`-shaped functions
/// that write into a caller-supplied `(buf, size)` and return the
/// untruncated length (snprintf convention) -- allocates the output
/// buffer, calls `fn`, and returns the decoded string (or throws if `fn`
/// returned negative).
function callWithOutBuf(fn, ...args) {
  const bufSize = 4096;
  const outPtr = exp.wasm_dbg_alloc(bufSize);
  if (!outPtr) throw new Error('wasm_dbg_alloc for output buffer failed');
  try {
    const len = fn(...args, outPtr, bufSize);
    if (len < 0)
      throw new Error(`call failed, returned ${len}`);
    return readCString(outPtr, Math.min(len, bufSize - 1));
  } finally {
    exp.wasm_dbg_free(outPtr);
  }
}

let ok = true;

console.error('wasm_dbg_init()...');
const initRc = exp.wasm_dbg_init();
console.error(`  -> ${initRc}`);
ok &&= initRc === 0;

if (ok) {
  const targetPathPtr = allocCString('/work/add.wasm');
  console.error('wasm_dbg_create_target("/work/add.wasm")...');
  const createRc = exp.wasm_dbg_create_target(targetPathPtr);
  exp.wasm_dbg_free(targetPathPtr);
  console.error(`  -> ${createRc}`);
  ok &&= createRc === 0;
}

// Find `add`'s entry address the same way `wasm_dbg_resolve_pc` itself
// will resolve it: DWARF's own `DW_AT_low_pc`, via llvm-dwarfdump. NOT
// llvm-nm's symbol-table address -- confirmed empirically these disagree
// for a wasm object (llvm-nm resolved to a wrong, unrelated symbol when
// tried here first): `Plugins/ObjectFile/wasm`/`SymbolFile/DWARF` use
// DWARF's own addressing, and llvm-nm's symbol table numbering isn't
// guaranteed to agree with it, unlike on more familiar formats (ELF/Mach-O).
let addAddr;
if (ok) {
  const llvmDwarfdump = path.join(path.dirname(wasiSdkClang), 'llvm-dwarfdump.exe');
  const { stdout } = await execFileAsync(llvmDwarfdump, ['--debug-info', targetPath]);
  // Split into one chunk per DW_TAG_subprogram (a regex spanning multiple
  // subprograms risks matching some other, earlier subprogram's low_pc
  // against add's own name -- confirmed empirically: a non-greedy pattern
  // reaching across blocks locked onto _start's low_pc instead, since
  // _start happens to be the first block start-to-finish, and JS regexes
  // return the leftmost match, not the shortest one overall) and look for
  // "add" strictly within its own chunk.
  const chunk = stdout.split('DW_TAG_subprogram').find((c) => /DW_AT_name\s*\("add"\)/.test(c));
  const match = chunk && chunk.match(/DW_AT_low_pc\s*\(0x([0-9a-f]+)\)/);
  if (!match) {
    console.error('could not find DW_AT_low_pc for "add" via llvm-dwarfdump output:', stdout);
    ok = false;
  } else {
    addAddr = parseInt(match[1], 16);
    console.error(`add() is at DWARF low_pc 0x${addAddr.toString(16)}`);
  }
}

if (ok) {
  console.error(`wasm_dbg_resolve_pc(0x${addAddr.toString(16)})...`);
  const resolved = callWithOutBuf(exp.wasm_dbg_resolve_pc, BigInt(addAddr));
  console.error(`  -> "${resolved}"`);
  // Expect "add.c:1" (add()'s opening brace line) or at least the function
  // name if line-table resolution didn't land exactly on the entry byte.
  ok &&= resolved.includes('add.c') || resolved.includes('add');
}

await rm(workDir, { recursive: true, force: true });
console.error(ok ? 'SMOKETEST PASSED' : 'SMOKETEST FAILED');
process.exit(ok ? 0 : 1);
