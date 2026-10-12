@echo off
node --no-warnings --experimental-wasm-type-reflection --experimental-wasi-unstable-preview1 "%~dp0..\..\wasi-tests\clang_wasm_cli.mjs" wasm-ld %*
