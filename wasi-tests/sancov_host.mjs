// Host-side support for a "Debug" build's sanitizer-coverage hooks. Reference
// implementation of what the real (VS Code for Web) host needs; depends on
// nothing outside the JS standard library, so it also loads in a browser.
//
// A program built with `-fsanitize-coverage=trace-pc-guard` calls an imported
// hook with only a guard address (never a PC; pc-table is empty on wasm). This
// module supplies the missing pieces:
//  - scanGuardSites(): the static guard -> {funcIndex, pc} map, read straight
//    from the wasm bytes (no llvm-objdump). `pc` is a DWARF code address, i.e.
//    an offset from the start of the CODE section payload.
//  - ShadowStack: the call stack, rebuilt from consecutive hook firings by
//    comparing `__stack_pointer` (export it with -Wl,--export=__stack_pointer).
//  - captureWasmFrames(): the *true* wasm call stack with a call-site PC per
//    frame, from the engine's own stack trace. Use it when delivering a stop,
//    not on every hook (it is slow; see documents/notes.md for the numbers).
//
// Quirks:
//  - Hooks fire per basic block, not per statement, so a straight-line
//    function has one guard at entry. -fsanitize-coverage=trace-loads,trace-stores
//    adds per-memory-access hooks (no guard argument); pair them with
//    captureWasmFrames() to identify the call site.
//  - A leaf function that never touches __stack_pointer is invisible to the
//    ShadowStack but still appears in captureWasmFrames().
//  - captureWasmFrames() depends on the engine's stack-trace text. V8 prints
//    `wasm-function[6]:0x145`; SpiderMonkey prints `name@url:wasm-function[6]:0x145`.
//    Both match the regex below. Unverified on JavaScriptCore.

const CALL_SITE = /wasm-function\[(\d+)\]:0x([0-9a-f]+)/g;

class Reader {
  constructor(bytes, pos = 0) { this.b = bytes; this.pos = pos; }
  u8() {
    if (this.pos >= this.b.length) throw new Error(`wasm decode ran past the end of the module at offset ${this.pos}`);
    return this.b[this.pos++];
  }
  // Both LEB flavors only need to be *skipped* or read as small numbers.
  u32() {
    let result = 0, shift = 0, byte;
    do { byte = this.u8(); result += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80);
    return result;
  }
  s32() {
    let result = 0, shift = 0, byte;
    do { byte = this.u8(); result |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
    if (shift < 32 && (byte & 0x40)) result |= -1 << shift;
    return result | 0;
  }
  skipLeb() { while (this.u8() & 0x80); }
  skip(n) { this.pos += n; }
  name() { const n = this.u32(); const s = new TextDecoder().decode(this.b.subarray(this.pos, this.pos + n)); this.pos += n; return s; }
}

function skipMemarg(r) {
  const align = r.u32();
  if (align >= 64) r.skipLeb(); // multi-memory: explicit memory index follows
  r.skipLeb();
}

/// Reads one instruction's immediates; returns the i32.const value for 0x41, else undefined.
function readImmediates(r, op) {
  if (op === 0x41) return r.s32();
  if ((op >= 0x28 && op <= 0x3e)) return skipMemarg(r);
  if (op >= 0x45 && op <= 0xc4) return;
  switch (op) {
    case 0x00: case 0x01: case 0x05: case 0x0b: case 0x0f: case 0x1a: case 0x1b: case 0x19: case 0x0a: case 0xd1:
      return;
    case 0x02: case 0x03: case 0x04: r.skipLeb(); return; // blocktype
    case 0x0c: case 0x0d: case 0x10: case 0x12: case 0x20: case 0x21: case 0x22: case 0x23: case 0x24:
    case 0x25: case 0x26: case 0xd2: case 0x07: case 0x08: case 0x09: case 0x18:
      r.skipLeb(); return;
    case 0x0e: { const n = r.u32(); for (let i = 0; i <= n; i++) r.skipLeb(); return; }
    case 0x11: case 0x13: r.skipLeb(); r.skipLeb(); return;
    case 0x1c: { const n = r.u32(); r.skip(n); return; }
    case 0x3f: case 0x40: case 0xd0: r.skipLeb(); return;
    case 0x42: r.skipLeb(); return;
    case 0x43: r.skip(4); return;
    case 0x44: r.skip(8); return;
    case 0xfc: {
      const sub = r.u32();
      if (sub <= 7) return;
      if (sub === 9 || sub === 13 || sub === 11 || (sub >= 15 && sub <= 17)) { r.skipLeb(); return; }
      if (sub === 8 || sub === 10 || sub === 12 || sub === 14) { r.skipLeb(); r.skipLeb(); return; }
      break;
    }
    case 0xfe: {
      const sub = r.u32();
      if (sub === 0x03) { r.skip(1); return; }
      skipMemarg(r);
      return;
    }
    case 0xfd: {
      const sub = r.u32();
      if (sub <= 0x0b || sub === 0x5c || sub === 0x5d) { skipMemarg(r); return; }
      if (sub === 0x0c || sub === 0x0d) { r.skip(16); return; }
      if (sub >= 0x15 && sub <= 0x22) { r.skip(1); return; }
      if (sub >= 0x54 && sub <= 0x5b) { skipMemarg(r); r.skip(1); return; }
      return;
    }
  }
  throw new Error(`unsupported wasm opcode 0x${op.toString(16)} at offset ${r.pos - 1} while scanning for hook calls; ` +
    'did you mean to extend readImmediates() in sancov_host.mjs for this (exception-handling?) instruction?');
}

/// Section-level view of a wasm module: import count, code payload start, function names.
export function parseModule(bytes) {
  const r = new Reader(bytes, 8);
  const mod = { bytes, funcImports: [], codeStart: -1, bodies: [], names: new Map() };
  while (r.pos < bytes.length) {
    const id = r.u8();
    const size = r.u32();
    const end = r.pos + size;
    if (id === 2) {
      const n = r.u32();
      for (let i = 0; i < n; i++) {
        const module = r.name(), name = r.name(), kind = r.u8();
        if (kind === 0) { r.skipLeb(); mod.funcImports.push({ module, name }); }
        else if (kind === 1) { r.skip(1); const f = r.u8(); r.skipLeb(); if (f & 1) r.skipLeb(); }
        else if (kind === 2) { const f = r.u8(); r.skipLeb(); if (f & 1) r.skipLeb(); }
        else if (kind === 3) { r.skip(2); }
        else r.skipLeb(), r.skipLeb(); // tag: attribute + type index
      }
    } else if (id === 10) {
      mod.codeStart = r.pos;
      const n = r.u32();
      for (let i = 0; i < n; i++) {
        const bodySize = r.u32();
        mod.bodies.push({ start: r.pos, end: r.pos + bodySize });
        r.pos += bodySize;
      }
    } else if (id === 0) {
      const sectionName = r.name();
      if (sectionName === 'name') {
        while (r.pos < end) {
          const sub = r.u8(), subSize = r.u32(), subEnd = r.pos + subSize;
          if (sub === 1) {
            const n = r.u32();
            for (let i = 0; i < n; i++) { const idx = r.u32(); mod.names.set(idx, r.name()); }
          }
          r.pos = subEnd;
        }
      }
    }
    r.pos = end;
  }
  if (mod.codeStart < 0) throw new Error('wasm module has no code section');
  return mod;
}

/// Finds every `call <hook>` and the guard address pushed just before it.
///
/// Returns { guardSites: Map<guard, {pc, funcIndex}>, ordinals: Map<guard, n> (0-based code order within its function), module }.
export function scanGuardSites(bytes, hookImport = { module: 'env', name: '__sanitizer_cov_trace_pc_guard' }) {
  const mod = parseModule(bytes);
  const hookIndex = mod.funcImports.findIndex((i) => i.module === hookImport.module && i.name === hookImport.name);
  if (hookIndex < 0)
    throw new Error(`module does not import ${hookImport.module}.${hookImport.name}; did you mean to compile with -fsanitize-coverage=trace-pc-guard?`);
  const guardSites = new Map();
  mod.bodies.forEach((body, bodyIdx) => {
    const r = new Reader(bytes, body.start);
    const nLocalGroups = r.u32();
    for (let i = 0; i < nLocalGroups; i++) { r.skipLeb(); r.skip(1); }
    const recent = []; // last 3 instructions: { op, imm }
    while (r.pos < body.end) {
      const at = r.pos;
      const op = r.u8();
      const imm = op === 0x10 ? (() => r.u32())() : readImmediates(r, op);
      if (op === 0x10 && imm === hookIndex) {
        const [p1, p2, p3] = [recent.at(-1), recent.at(-2), recent.at(-3)];
        let guard;
        if (p1?.op === 0x41) guard = p1.imm; // lone i32.const (the first guard)
        else if (p1?.op === 0x6a && p2?.op === 0x41 && p3?.op === 0x41) guard = p3.imm + p2.imm; // base + off
        else throw new Error(`hook call at wasm offset 0x${at.toString(16)} has an unrecognized guard-address sequence (previous opcodes: ${recent.map((x) => '0x' + x.op.toString(16)).join(', ')})`);
        guardSites.set(guard >>> 0, { pc: at - mod.codeStart, funcIndex: mod.funcImports.length + bodyIdx });
      }
      recent.push({ op, imm });
      if (recent.length > 3) recent.shift();
    }
  });
  const ordinals = new Map();
  const perFn = new Map();
  for (const [g, s] of [...guardSites].sort((a, b) => a[1].pc - b[1].pc)) {
    const n = perFn.get(s.funcIndex) ?? 0;
    ordinals.set(g, n);
    perFn.set(s.funcIndex, n + 1);
  }
  return { guardSites, ordinals, module: mod };
}

/// Call stack rebuilt from hook firings; entries are { funcIndex, pc, sp }, innermost last.
export class ShadowStack {
  constructor(guardSites) { this.guardSites = guardSites; this.entries = []; }

  /// Pops frames that have returned, given the live `__stack_pointer`. Call it from
  /// guard-less hooks (trace-loads/stores), where a callee may have just returned.
  sync(sp) {
    while (this.entries.length && this.entries.at(-1).sp < sp) this.entries.pop();
  }

  /// Feed one hook firing: the live `__stack_pointer` value and the guard argument.
  onHook(sp, guard) {
    const site = this.guardSites.get(guard);
    if (!site) throw new Error(`hook fired for unknown guard address ${guard}; known: ${[...this.guardSites.keys()].join(', ')}`);
    const e = this.entries;
    this.sync(sp); // returned
    const top = e.at(-1);
    if (top && top.sp === sp) top.pc = site.pc; // same frame, new block
    else e.push({ funcIndex: site.funcIndex, pc: site.pc, sp }); // deeper call, or first frame
    return e.at(-1);
  }

  /// Frames innermost first.
  frames() { return [...this.entries].reverse(); }
}

/// True wasm call stack from the engine's stack trace, innermost first: { funcIndex, pc }.
///
/// `codeStart` is parseModule()'s codeStart. The innermost frame is the hook
/// call site (the JS import frame itself has no wasm-function marker).
/// `onlyInnermost` bounds the engine's stack walk to the innermost wasm frame,
/// which assumes the hook function calls this directly (the walk counts JS
/// frames, so a deeper wrapper would hide the wasm frame). A full walk costs
/// tens of microseconds, the bounded one a few.
export function captureWasmFrames(codeStart, onlyInnermost = false) {
  const maxFrames = onlyInnermost ? 3 : Infinity; // this function, the hook, the wasm frame
  const saved = Error.stackTraceLimit;
  Error.stackTraceLimit = maxFrames;
  const stack = new Error().stack;
  Error.stackTraceLimit = saved;
  return [...stack.matchAll(CALL_SITE)].map((m) => ({ funcIndex: Number(m[1]), pc: parseInt(m[2], 16) - codeStart }));
}

/// Pairs true frames (PCs) with shadow-stack entries (frame-base SPs), innermost first.
///
/// Shadow entries are a subsequence of the true frames (leaf functions that
/// never touch __stack_pointer, and the _start wrapper, have none); matched by
/// function index from the innermost frame outwards. Frames with no shadow
/// entry get sp = null.
export function mergeFrames(trueFrames, shadow) {
  const remaining = [...shadow.frames()];
  return trueFrames.map((f) => {
    const next = remaining[0];
    if (next && next.funcIndex === f.funcIndex) { remaining.shift(); return { ...f, sp: next.sp }; }
    return { ...f, sp: null };
  });
}
