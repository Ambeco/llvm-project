# VS Code for Web's WASI host (`wasm-wasi-core`): API reference

Source: <https://github.com/microsoft/vscode-wasm>, package `wasm-wasi-core`
(also `wasm-wasi-core-preview2`, not investigated here -- the "preview2"
variant presumably targets the newer WASI 0.2/Component Model, which this
project isn't using). Everything below was read directly from that repo's
source on 2026-09-04 (`src/common/api.ts`, `src/web/process.ts`,
`src/web/threadWorker.ts`, and the package README) -- not from memory, and
not exhaustively: treat this as "what we found useful," not a full API
survey. Re-check the actual source before relying on anything here for a
real integration; this extension is explicitly still evolving ("WASI is
work in progress... newer versions of this extension might not be
backwards compatible with older WASI standards" -- their README's own
words).

This doc exists for two purposes: (1) actually integrating `clang.wasm`
into a VS Code for Web extension, and (2) as a head start for whoever
eventually looks at building a debugger -- see "Debugging" at the bottom,
which is mostly open questions, not answers.

## The core API surface (`Wasm` namespace, from `src/common/api.ts`)

```typescript
export interface Wasm {
	readonly versions: { api: number; extension: string };

	createPseudoterminal(options?: TerminalOptions): WasmPseudoterminal;
	createMemoryFileSystem(): Promise<MemoryFileSystem>;
	createRootFileSystem(descriptors: MountPointDescriptor[]): Promise<RootFileSystem>;
	createReadable(): Readable;
	createWritable(encoding?: 'utf-8'): Writable;
	createWritable(options: { eot?: boolean; encoding?: 'utf-8' }): Writable;

	createProcess(name: string, module: WebAssembly.Module | Promise<WebAssembly.Module>,
		options?: ProcessOptions): Promise<WasmProcess>;
	createProcess(name: string, module: WebAssembly.Module | Promise<WebAssembly.Module>,
		memory: WebAssembly.MemoryDescriptor | WebAssembly.Memory,
		options?: ProcessOptions): Promise<WasmProcess>;

	compile(source: Uri): Promise<WebAssembly.Module>;
}
```

You get an instance of this via an `APILoader` the extension exposes
(exact activation-time API not captured here -- check the README's usage
example when actually integrating). `compile()` is worth using over
rolling your own `WebAssembly.compile`: "In the Web the implementation
uses streaming, on the desktop the bits are first loaded into memory" --
i.e. it already does the right thing per-platform.

### `WasmProcess` -- the thing `createProcess` gives you

```typescript
export interface WasmProcess {
	readonly stdin: Writable | undefined;
	readonly stdout: Readable | undefined;
	readonly stderr: Readable | undefined;
	run(): Promise<number>;       // resolves with the exit code
	terminate(): Promise<number>; // ditto, but for a forced stop
}
```

That's the *entire* lifecycle surface: no separate "kill with SIGKILL vs.
SIGTERM," no `onExit` event distinct from `run()`'s own resolution, no
process ID. Directly relevant to this project's own "hosting JS is
responsible for invoking cleanup when it terminates" design (see this
repo's README's "JS Framework" section): **`terminate()` is the one and
only hook** a real integration would call `llvm::sys::RunInterruptHandlers()`/
`CleanupOnSignal()` from -- there's no lower-level "the worker died,
here's why" signal to hook into instead. Call our cleanup entry point
right after (or as part of the same code path as) calling `terminate()`.

### File system mounting (`MountPointDescriptor` union)

```typescript
export type MountPointDescriptor =
	| { kind: 'workspaceFolder' }
	| { kind: 'extensionLocation'; extension: ExtensionContext | Extension<any>; path: string; mountPoint: string }
	| { kind: 'vscodeFileSystem'; uri: Uri; mountPoint: string }
	| { kind: 'memoryFileSystem'; fileSystem: MemoryFileSystem; mountPoint: string };
```

This is the equivalent of our own `preopens` map in the Node reference
host (`ai-notes/wasi_spawn_shim.mjs` et al.) -- each descriptor says what
shows up at a given path inside the wasm process's view of the
filesystem. `workspaceFolder` mounts the open VS Code workspace at
`/workspace` (or `/workspaces/<name>` for multi-root); `vscodeFileSystem`
mounts an arbitrary VS Code filesystem provider (so this can reach
anything VS Code itself can -- remote SSH, a virtual FS provider, etc.,
not just local disk); `extensionLocation` mounts files bundled with an
extension (e.g. this is almost certainly how you'd expose `clang.wasm`'s
own resource-dir/sysroot headers to the compiled process); `memoryFileSystem`
mounts an in-memory scratch filesystem (`Wasm.createMemoryFileSystem()`),
useful for temp files (matches our own `/tmp` preopen for the linker's
intermediate `.o`).

`RootFileSystem` (from `createRootFileSystem`) adds path translation:

```typescript
toVSCode(path: string): Promise<Uri | undefined>;  // wasm path -> VS Code URI
toWasm(uri: Uri): Promise<string | undefined>;      // VS Code URI -> wasm path
stat(path: string): Promise<{ filetype: Filetype }>;
```

`ProcessOptions` takes *either* `{ mountPoints }` (simple case) *or*
`{ rootFileSystem }` (when you need the path-translation methods above) --
they're a discriminated union (`MountPointOptions | RootFileSystemOptions`),
not both at once.

### Stdio wiring (`Stdio` type)

```typescript
export type Stdio = {
	in?:  { kind: 'file'; path: string; openFlags?: OpenFlags }
	    | { kind: 'terminal'; terminal: WasmPseudoterminal }
	    | { kind: 'pipeIn'; pipe?: Writable };
	out?: { kind: 'file'; ... } | { kind: 'terminal'; ... }
	    | { kind: 'console' } | { kind: 'pipeOut'; pipe?: Readable };
	err?: /* same shape as out */;
};
```

For a compiler invocation you'd almost certainly use `pipeOut`/`pipeIn`
(or `console` for stderr diagnostics you want to show directly in a VS
Code output channel) rather than `terminal`, which is for genuinely
interactive processes.

### `BaseProcessOptions` (the rest of what `createProcess` accepts)

```typescript
export type BaseProcessOptions = {
	encoding?: 'utf-8';           // the only supported encoding, currently
	args?: (string | Uri)[];     // argv[1..], argv[0] is the `name` param
	env?: Environment;            // { [key: string]: string }
	stdio?: Stdio;
	trace?: boolean;              // traces the WASM/WASI API calls -- useful for debugging *this integration*, not the compiled program
};
```

## Threading / shared memory

Confirmed directly from source (not just the README's claim of "[thread
support]"):

- **`createProcess`'s second overload takes `memory: WebAssembly.MemoryDescriptor | WebAssembly.Memory`** as a first-class, explicit parameter -- this is the real, public, intended way to run a threads-enabled module, not an internal detail.
- `MemoryDescriptor.is()` (a runtime type guard in `api.ts`) validates `{ initial: number, maximum?: number, shared?: boolean }` -- standard `WebAssembly.MemoryDescriptor` shape, nothing project-specific.
- `src/web/process.ts` detects whether a module needs this via `doesImportMemory()`, which just checks `WebAssembly.Module.imports()` for a `memory`-kind import named `"memory"` -- **it does not parse the module's actual min/max/shared limits from the import section**. That parsing is on the caller (see `ai-notes/wasi_thread_hook.mjs`'s `readImportedMemoryLimits()` in this repo -- reuse that logic, or hardcode known-correct values for a specific build).
- `src/web/threadWorker.ts` receives a `memory` object via a `StartThreadMessage` (postMessage from whichever worker called `wasi.thread-spawn`), builds an import object with `env: { memory }`, instantiates the module, and calls `instance.exports.wasi_thread_start` directly -- **structurally identical** to this repo's own `ai-notes/wasi_thread_worker.mjs` prototype (worker-per-thread, shared `WebAssembly.Memory`, direct `wasi_thread_start` call rather than a normal `_start`).
- Their internal WASI-host abstraction does `host.initialize(memory ?? instance)` -- a fallback that explicitly handles both an *imported* memory (thread) and a module's own *exported* memory (a normal, non-threaded process). This is exactly the case `node:wasi` in plain Node does **not** handle (confirmed empirically -- `wasi.start()` throws `"instance.exports.memory property must be a WebAssembly.Memory object"` for an imported-memory module). `wasm-wasi-core` was apparently built with this case in mind from the start, which is a good sign for actually integrating our `experiment-wasi-threads` work here.

**Practical implication for us**: when actually wiring `clang.wasm`
(built against `wasm32-wasip1-threads`) into this host, we still need our
own `readImportedMemoryLimits()`-equivalent logic to construct the right
`MemoryDescriptor` before calling the memory-taking `createProcess`
overload -- the host won't infer it for us.

## What's genuinely unresearched / open

- **Real file I/O consistency across threads** (multiple threads of one
  `WasmProcess` doing concurrent `fd_read`/`fd_write` against the same
  mounted filesystem) -- not investigated here at all. Whatever
  `wasm-wasi-core` does internally when several `threadWorker.ts`
  instances are alive simultaneously and all touch the filesystem wasn't
  read; check this before assuming it's handled, one way or the other.
- **Debugging.** This README makes no mention of DWARF, breakpoints,
  source maps, or a Debug Adapter Protocol integration anywhere, and none
  of the source files fetched this session referenced any of that either.
  As far as this investigation goes, `wasm-wasi-core` is a pure
  *execution* host (run a wasm process, get its stdio/exit code) with no
  debugging story of its own. A few concrete starting points for whoever
  picks this up later, none of them verified:
  - `clang.wasm` can already emit real DWARF (`-g`) -- that part is free,
    it's an ordinary compiler flag, unrelated to this host.
  - Whether the *browser's own* wasm devtools support (Chrome/Firefox can
    already show wasm call stacks and, with a DWARF extension, source-level
    debugging in their own devtools panel) is reachable at all from code
    running inside a VS Code for Web extension host is unknown -- extension
    code doesn't obviously get a devtools panel of its own, and VS Code's
    *own* debugging UI (breakpoints in the editor gutter, the Debug
    sidebar) would need a real Debug Adapter Protocol implementation
    talking to VS Code, not the browser's devtools protocol.
  - A DAP implementation would need some way to actually control execution
    of the running wasm (pause at a breakpoint, step, inspect locals) --
    unclear whether `wasm-wasi-core`'s `WasmProcess`/thread-worker
    machinery exposes any hook for this (nothing in the API surface above
    suggests it does -- `run()`/`terminate()` is all there is) or whether
    a debugger would need its own, separate execution host entirely
    (e.g. instrumenting the compiled binary itself, or running it under a
    custom interpreter loop instead of `WebAssembly.instantiate`+`start`).
  - Worth checking, next time: the `wasm-kit` directory in the same repo
    (seen in a directory listing this session, not opened) -- name
    suggests it might be a lower-level toolkit some of this is built on,
    possibly with more primitives than the `wasm-wasi-core` public API
    exposes.

## How this maps onto this repo's own prototypes

| This repo (Node reference host) | `wasm-wasi-core` equivalent |
|---|---|
| `ai-notes/wasi_spawn_shim.mjs`'s `installSpawnHook` (our own optional table-hook design) | No equivalent -- this is our own `Program.inc` extension point, not a WASI-standard thing. Would still need to be wired up by hand inside a `wasm-wasi-core`-hosted process, same shape as the Node prototype. |
| `preopens` map | `MountPointDescriptor[]` (`createRootFileSystem`/`ProcessOptions.mountPoints`) |
| `wasi_spawn_worker.mjs` (Worker-per-spawned-process) | `Wasm.createProcess()` itself -- the host already does this internally |
| `wasi_thread_hook.mjs`'s `readImportedMemoryLimits()` | Still needed -- the host's `doesImportMemory()` doesn't parse limits, only presence |
| `wasi_thread_worker.mjs` (Worker-per-thread, shared memory, direct `wasi_thread_start` call) | `src/web/threadWorker.ts` -- already implemented, matches our shape |
| Hand-rolled `wasi_thread_syscalls.mjs` (`node:wasi` doesn't support imported memory) | Not needed -- their host's `host.initialize(memory ?? instance)` already handles this case |
