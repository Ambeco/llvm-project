// Quick sanity-check runner for build/bin/clang.wasm, using Node's built-in WASI
// implementation (no browser/VS Code extension involved). Confirms the wasm
// binary is well-formed and its driver logic actually runs, without needing
// the JS-side Worker executor that real compilation (cc1 invocation) needs.
//
// Usage:
//   node --experimental-wasi-unstable-preview1 ai-notes/run_clang_smoketest.mjs <path-to-clang-wasm> [clang args...]
//
// Examples:
//   node --experimental-wasi-unstable-preview1 ai-notes/run_clang_smoketest.mjs build/bin/clang.wasm --version
//   node --experimental-wasi-unstable-preview1 ai-notes/run_clang_smoketest.mjs build/bin/clang.wasm -c foo.c -o foo.o
//
// The second example is expected to fail loudly with a report_fatal_error
// from llvm::sys::ExecuteAndWait (see README.md's "JS Framework" section) --
// that's the current, correct behavior until a real process executor exists.
import { readFile } from 'node:fs/promises';
import { WASI } from 'node:wasi';
import { argv } from 'node:process';

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
// No custom imports needed -- clang.wasm is self-contained by default (see
// Unix/Program.inc): spawning a subprocess without a JS host installing a
// hook post-instantiation just fails loudly (report_fatal_error) when
// actually attempted, same as the second usage example below. Nothing is
// *required* at instantiation time, unlike an import-based design.
const instance = await WebAssembly.instantiate(wasmModule, wasi.getImportObject());
console.error('Instantiated. Starting...');
try {
  wasi.start(instance);
} catch (e) {
  console.error('EXIT/ERROR:', e);
}
