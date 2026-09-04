// Minimal hand-rolled wasi_snapshot_preview1 implementation, used instead
// of node:wasi's WASI class for anything involving a *shared, imported*
// memory: node:wasi's WASI.start()/initialize() hard-require
// `instance.exports.memory` (confirmed empirically -- it throws
// "instance.exports.memory property must be a WebAssembly.Memory object"
// otherwise), which no wasi-threads module has, by construction (memory
// has to be an *import* so every thread's instance can share the same
// one). This only implements the handful of syscalls
// ai-notes/run_wasi_threads_prototype.mjs's test program actually needs
// (clock_time_get, fd_close, fd_fdstat_get, fd_seek, fd_write, proc_exit,
// sched_yield) -- nowhere near a complete wasi_snapshot_preview1, and
// deliberately not: this is a prototype answering "does real wasi-threads
// work at all", not a production WASI host.
//
// Real file I/O (fd_read/fd_open/etc. against actual files, consistent
// across threads) is NOT implemented here -- see ai-notes/wip.md for the
// open design question about that (the "hybrid I/O-owner + RPC" idea).
// This only needs to make stdout/stderr (fd 1/2) work, which needs no
// cross-thread coordination beyond what's already inherent in writing to
// the same real stream.

export class ProcExit extends Error {
  constructor(code) {
    super(`proc_exit(${code})`);
    this.code = code;
  }
}

function readIovecs(view, iovsPtr, iovsLen) {
  const iovecs = [];
  for (let i = 0; i < iovsLen; i++) {
    const base = iovsPtr + i * 8;
    iovecs.push({ ptr: view.getUint32(base, true), len: view.getUint32(base + 4, true) });
  }
  return iovecs;
}

/// Build the wasi_snapshot_preview1 import object for a given shared
/// `memory`. Every function reads/writes through `memory.buffer` directly
/// (a fresh DataView/Uint8Array per call, since a growable memory's
/// underlying ArrayBuffer can be detached/replaced on grow).
export function makeWasiSnapshotPreview1(memory) {
  function view() { return new DataView(memory.buffer); }
  function bytes() { return new Uint8Array(memory.buffer); }

  return {
    fd_write(fd, iovsPtr, iovsLen, nwrittenPtr) {
      const v = view();
      const iovecs = readIovecs(v, iovsPtr, iovsLen);
      let total = 0;
      const chunks = [];
      for (const { ptr, len } of iovecs) {
        chunks.push(Buffer.from(memory.buffer, ptr, len));
        total += len;
      }
      const text = Buffer.concat(chunks);
      (fd === 2 ? process.stderr : process.stdout).write(text);
      v.setUint32(nwrittenPtr, total, true);
      return 0; // errno success
    },
    fd_close(_fd) { return 0; },
    fd_fdstat_get(_fd, statPtr) {
      const v = view();
      // fdstat_t: {fs_filetype: u8, fs_flags: u16, pad, fs_rights_base: u64, fs_rights_inheriting: u64}
      v.setUint8(statPtr, 2); // __WASI_FILETYPE_CHARACTER_DEVICE
      v.setUint16(statPtr + 2, 0, true);
      v.setBigUint64(statPtr + 8, 0xffffffffffffffffn, true);
      v.setBigUint64(statPtr + 16, 0xffffffffffffffffn, true);
      return 0;
    },
    fd_seek(_fd, _offsetLow, _offsetHigh, _whence, newoffsetPtr) {
      const v = view();
      v.setBigUint64(newoffsetPtr, 0n, true);
      return 0;
    },
    clock_time_get(_clockId, _precision, timePtr) {
      const v = view();
      v.setBigUint64(timePtr, BigInt(process.hrtime.bigint()), true);
      return 0;
    },
    sched_yield() { return 0; },
    proc_exit(code) { throw new ProcExit(code); },
    // Referenced by the CRT even when args/env are empty.
    args_sizes_get(argcPtr, argvBufSizePtr) {
      const v = view(); v.setUint32(argcPtr, 0, true); v.setUint32(argvBufSizePtr, 0, true); return 0;
    },
    args_get(_argv, _argvBuf) { return 0; },
    environ_sizes_get(countPtr, bufSizePtr) {
      const v = view(); v.setUint32(countPtr, 0, true); v.setUint32(bufSizePtr, 0, true); return 0;
    },
    environ_get(_environ, _environBuf) { return 0; },
  };
}
