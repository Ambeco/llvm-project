// Quick sanity-check runner for build/bin/clang.wasm, using Node's built-in WASI
// implementation (no browser/VS Code extension involved). Confirms the wasm
// binary is well-formed and its driver logic actually runs, without needing
// the JS-side Worker executor that real compilation (cc1 invocation) needs.
//
// Usage:
//   node --experimental-wasm-type-reflection --experimental-wasi-unstable-preview1 ai-notes/run_clang_smoketest.mjs <path-to-clang-wasm> [clang args...]
//
// Examples:
//   node --experimental-wasm-type-reflection --experimental-wasi-unstable-preview1 ai-notes/run_clang_smoketest.mjs build/bin/clang.wasm --version
//   node --experimental-wasm-type-reflection --experimental-wasi-unstable-preview1 ai-notes/run_clang_smoketest.mjs build/bin/clang.wasm -c foo.c -o foo.o
//
// The second example is expected to fail loudly with a report_fatal_error
// from llvm::sys::ExecuteAndWait (see README.md's "JS Framework" section) --
// that's the current, correct behavior until a real process executor
// installs a spawn hook (see run_clang_compile_smoketest.mjs for that).
import { readFile } from 'node:fs/promises';
import { WASI } from 'node:wasi';
import { argv } from 'node:process';
import { instantiateThreaded, makeFakeInstance } from './wasi_thread_hook.mjs';

const wasmPath = argv[2];
const clangArgs = argv.slice(3);
if (!wasmPath) {
  console.error('usage: run_clang_smoketest.mjs <path-to-clang-wasm> [clang args...]');
  process.exit(1);
}

const wasi = new WASI({
  version: 'preview1',
  args: ['clang', ...(clangArgs.length ? clangArgs : ['--version'])],
  env: {},
  preopens: {},
});

const bytes = await readFile(wasmPath);
console.error(`Loaded ${bytes.length} bytes, compiling...`);
const wasmModule = await WebAssembly.compile(bytes);
console.error('Compiled. Instantiating...');
// clang.wasm is built against wasm32-wasip1-threads (see build.bat), so it
// unconditionally *requires* env.memory + wasi.thread-spawn to instantiate
// at all -- see wasi_thread_hook.mjs. Subprocess spawning (cc1 invocation)
// is separately still optional/self-contained by default (see
// Unix/Program.inc): without a spawn hook installed, that just fails
// loudly (report_fatal_error) when actually attempted, same as the second
// usage example above.
const { instance, memory } = await instantiateThreaded(
  wasmModule, bytes, wasi.getImportObject(), { wasmPath, preopens: {} });
console.error('Instantiated. Starting...');
try {
  wasi.start(makeFakeInstance(instance, memory));
} catch (e) {
  console.error('EXIT/ERROR:', e);
}
