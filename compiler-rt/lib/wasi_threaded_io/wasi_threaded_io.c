//===-- wasi_threaded_io.c ------------------------------------*- C -*-===//
//
// Dedicated file-I/O thread + in-wasm RPC for wasm32-wasi*-threads targets.
//
// Background: our wasi-threads hosting model (and, per
// documents/vscode-wasi-host.md, VS Code for Web's wasm-wasi-core host
// too, unless proven otherwise -- see that doc's "genuinely unresearched"
// section) gives each spawned thread its own independent WASI host
// instance, each with its own private file-descriptor table. A completely
// normal pthread program -- main thread opens a file, hands the plain
// `int` fd to worker threads, each thread reads/writes using that same fd
// number -- fails with EBADF, because the fd number is only meaningful in
// whichever thread's table it was allocated from. And symmetrically:
// whichever thread opens a file (main or a worker), every OTHER thread
// that later touches that fd needs the SAME fix -- there's no special
// case for "the main thread happened to be the opener." Both directions
// fall out of the single design below for free.
//
// This file fixes that *without any host support*, entirely inside the
// compiled wasm module: one dedicated thread (spawned lazily, on first
// use) owns the one real, canonical fd table by being the only thread
// that ever actually calls the raw WASI syscall imports. Every other
// thread's raw WASI call is intercepted and instead marshals its
// arguments to the I/O thread through a single shared-memory mailbox,
// blocks (by spinning -- see the note on memory.atomic.wait32 below), and
// receives the real result back.
//
// See documents/threaded-file-io-rpc-plan.md for the full design
// rationale this implements, including an earlier version of this file
// that intercepted at the POSIX (open/read/write/...) layer instead --
// kept there for the reasoning trail on why this raw-import layer
// replaced it.
//
// ---- Why the raw WASI import layer, not the POSIX layer ----
//
// wasi-libc's own POSIX-ish functions (open/read/write/pread/pwrite/
// close/fcntl/isatty/lseek, and FILE*-based fopen/fread/fwrite/fclose) are
// all, eventually, thin wrappers around a small, fixed set of raw
// WASI Preview1 imports: fd_read, fd_write, fd_pread, fd_pwrite,
// fd_close, fd_seek, fd_fdstat_get, fd_fdstat_set_flags, and path_open.
// An earlier version of this file wrapped the POSIX layer instead (via
// `-Wl,--wrap=`) and broke twice during validation: `fopen()` bypasses
// `open()`/`openat()` and calls a lower-level wasi-libc-internal
// primitive directly, and `fdopen()` (which `fopen()` calls) runs
// `fcntl()`/`isatty()` on the fd it just opened -- both silently missed
// by wrapping only the "obvious" POSIX names. Those internal primitive
// names (`__wasilibc_nocwd_openat_nomode`, `__isatty`, `__lseek`, ...) are
// wasi-libc implementation details, not a stable contract, so new gaps
// like that could reappear on a wasi-libc upgrade. The raw imports below
// are the actual WASI Preview1 ABI: a small, spec'd, stable surface that
// every one of those POSIX/stdio functions is contractually required to
// fall through to, by construction -- there's no lower level to bypass.
//
// ---- The interception mechanism ----
//
// wasi-libc calls these raw imports through symbols named
// `__imported_wasi_snapshot_preview1_<name>` (e.g.
// `__imported_wasi_snapshot_preview1_fd_write`), declared but not
// defined -- i.e. genuine wasm imports, resolved by the host at
// instantiation time. Giving one of those exact symbol names a real
// function body (as this file does, in the `__imported_wasi_snapshot_preview1_*`
// definitions below) makes the linker use that definition instead of
// importing it -- turning it from a wasm import into an ordinary defined
// function, transparently redirecting *every* caller (raw POSIX code and
// FILE*/stdio internals alike) with no `-Wl,--wrap=` or `-u` linker
// flags needed at all. Confirmed empirically (see the session that added
// this file) against the real wasi-sdk `libc.a`: no duplicate-symbol
// error, and a test program's `printf`/stdio path and its raw `write()`
// call both observably passed through the override.
//
// The dedicated I/O thread still needs its own way to reach the *real*
// host import, since the module-wide symbol now points at our
// definition. It gets one via a second, differently-named import
// declaration for the identical (module, name) pair (`wasi_io_real_*`
// below, using the `import_module`/`import_name` attributes directly) --
// wasm allows multiple import entries for the same (module, name); the
// host binds each to the same underlying host function independently.
// Confirmed empirically too: both the override and this second import
// coexist and both actually reach the host.
//
// `fd_prestat_get`/`fd_prestat_dir_name` are deliberately NOT
// intercepted: they're only ever called once, very early during crt
// startup on the main thread (populating the preopens table each thread
// later reads from, as plain shared global data -- no interception
// needed there either), before any thread this file's RPC needs to
// reach exists.
//
// Usage: compile this file for a wasm32-wasi*-threads target (it compiles
// to nothing -- an empty translation unit -- everywhere else, so it's
// always safe to add to a build). No special link flags are required
// (unlike the earlier `--wrap`-based version) -- just link the object in.
//
// Not yet wired into build.bat/CMake or the clang driver -- see
// documents/threaded-file-io-rpc-plan.md's build order. For now, link
// this .c file (or its .o) directly into whatever wasm32-wasi*-threads
// binary needs shared-fd-across-threads support (both clang.wasm itself,
// if it ever needs this, and any -pthread program clang.wasm compiles).
//
//===--------------------------------------------------------------------===//

#if defined(__wasi__) && defined(__wasm_atomics__)

#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdint.h>

// ---- The real, unwrapped imports -- only the I/O server thread calls these.
//
// Each is a second, independent import of the same (module, name) pair
// that `__imported_wasi_snapshot_preview1_<name>` below is normally bound
// to -- see the file header comment above.
#define WASI_IMPORT(name)                                                    \
  __attribute__((import_module("wasi_snapshot_preview1"), import_name(#name)))

WASI_IMPORT(fd_close) extern int32_t wasi_io_real_fd_close(int32_t fd);
WASI_IMPORT(fd_fdstat_get)
extern int32_t wasi_io_real_fd_fdstat_get(int32_t fd, int32_t retptr0);
WASI_IMPORT(fd_fdstat_set_flags)
extern int32_t wasi_io_real_fd_fdstat_set_flags(int32_t fd, int32_t flags);
WASI_IMPORT(fd_seek)
extern int32_t wasi_io_real_fd_seek(int32_t fd, int64_t offset,
                                     int32_t whence, int32_t retptr0);
WASI_IMPORT(fd_write)
extern int32_t wasi_io_real_fd_write(int32_t fd, int32_t iovs,
                                      int32_t iovs_len, int32_t retptr0);
WASI_IMPORT(fd_read)
extern int32_t wasi_io_real_fd_read(int32_t fd, int32_t iovs,
                                     int32_t iovs_len, int32_t retptr0);
WASI_IMPORT(fd_pwrite)
extern int32_t wasi_io_real_fd_pwrite(int32_t fd, int32_t iovs,
                                       int32_t iovs_len, int64_t offset,
                                       int32_t retptr0);
WASI_IMPORT(fd_pread)
extern int32_t wasi_io_real_fd_pread(int32_t fd, int32_t iovs,
                                      int32_t iovs_len, int64_t offset,
                                      int32_t retptr0);
WASI_IMPORT(path_open)
extern int32_t wasi_io_real_path_open(int32_t dirfd, int32_t dirflags,
                                       int32_t path, int32_t path_len,
                                       int32_t oflags, int64_t rights_base,
                                       int64_t rights_inheriting,
                                       int32_t fdflags, int32_t retptr0);

#undef WASI_IMPORT

enum io_op {
  IO_FD_CLOSE,
  IO_FD_FDSTAT_GET,
  IO_FD_FDSTAT_SET_FLAGS,
  IO_FD_SEEK,
  IO_FD_WRITE,
  IO_FD_READ,
  IO_FD_PWRITE,
  IO_FD_PREAD,
  IO_PATH_OPEN,
};

// All threads share one linear memory, so pointer-shaped fields (path,
// iovs, retptr0) are just plain i32 addresses -- the server thread
// dereferences them directly, including writing results (byte counts,
// the new seek offset, a fdstat struct, ...) straight into the caller's
// own retptr0 buffer. No result data needs to travel back through the
// mailbox at all; only the raw WASI errno return code does. This relies
// on retptr0 (and iovs, and the buffers iovs itself points to) actually
// living in linear memory reachable from every thread -- true today
// because wasi-libc's pthread stacks are wasi-libc-managed heap
// allocations inside the one shared `--import-memory`/`--shared-memory`
// linear memory, not some separate per-thread region; a caller passing a
// pointer into genuinely thread-private storage outside linear memory
// would break this, but no such storage exists for a wasm32-wasi*-threads
// binary under the current toolchain.
struct io_request {
  enum io_op op;
  int32_t fd;
  int32_t iovs;
  int32_t iovs_len;
  int64_t offset;
  int32_t whence;
  int32_t retptr0;
  int32_t dirfd;
  int32_t dirflags;
  int32_t path;
  int32_t path_len;
  int32_t oflags;
  int64_t rights_base;
  int64_t rights_inheriting;
  int32_t fdflags;
};

enum mbox_state { MBOX_IDLE = 0, MBOX_REQUEST = 1, MBOX_RESPONSE = 2 };

// A single mailbox slot: simplest possible design, callers serialize
// through g_mbox.submit_lock. If this becomes a throughput bottleneck,
// upgrade to a small ring buffer (see documents/threaded-file-io-rpc-plan.md,
// suggested build order item 1) -- not needed to be correct.
static struct {
  _Atomic int state;
  _Atomic int submit_lock;
  struct io_request req;
  _Atomic int32_t resp_ret;
} g_mbox;

static pthread_once_t g_io_once = PTHREAD_ONCE_INIT;
static _Atomic int g_io_thread_ready = 0;

// Set as the first statement of io_server_main(), before anything else
// (including the g_io_thread_ready store below) can run on this thread.
// Deliberately thread-local rather than comparing pthread_self() against
// a shared "which thread is the server" global: such a global is written
// by the *parent* in pthread_create() and could be read here before that
// write is visible, making the server appear not-yet-itself to itself
// and RPC to itself -- a guaranteed deadlock. A thread-local a thread
// sets about itself has no such ordering dependency.
static _Thread_local int t_is_io_thread = 0;

static int32_t do_real_io(struct io_request *r) {
  switch (r->op) {
  case IO_FD_CLOSE:
    return wasi_io_real_fd_close(r->fd);
  case IO_FD_FDSTAT_GET:
    return wasi_io_real_fd_fdstat_get(r->fd, r->retptr0);
  case IO_FD_FDSTAT_SET_FLAGS:
    return wasi_io_real_fd_fdstat_set_flags(r->fd, r->fdflags);
  case IO_FD_SEEK:
    return wasi_io_real_fd_seek(r->fd, r->offset, r->whence, r->retptr0);
  case IO_FD_WRITE:
    return wasi_io_real_fd_write(r->fd, r->iovs, r->iovs_len, r->retptr0);
  case IO_FD_READ:
    return wasi_io_real_fd_read(r->fd, r->iovs, r->iovs_len, r->retptr0);
  case IO_FD_PWRITE:
    return wasi_io_real_fd_pwrite(r->fd, r->iovs, r->iovs_len, r->offset,
                                   r->retptr0);
  case IO_FD_PREAD:
    return wasi_io_real_fd_pread(r->fd, r->iovs, r->iovs_len, r->offset,
                                  r->retptr0);
  case IO_PATH_OPEN:
    return wasi_io_real_path_open(r->dirfd, r->dirflags, r->path, r->path_len,
                                   r->oflags, r->rights_base,
                                   r->rights_inheriting, r->fdflags,
                                   r->retptr0);
  }
  return 28; // __WASI_ERRNO_INVAL -- unreachable in practice.
}

static void *io_server_main(void *arg) {
  (void)arg;
  t_is_io_thread = 1;
  atomic_store_explicit(&g_io_thread_ready, 1, memory_order_release);
  for (;;) {
    // Plain atomic-load spin, deliberately not memory.atomic.wait32/notify32:
    // see the matching comment in do_rpc() below for why every waiter in
    // this file (including this one) uses the same strategy.
    while (atomic_load_explicit(&g_mbox.state, memory_order_acquire) !=
           MBOX_REQUEST)
      sched_yield();
    int32_t ret = do_real_io(&g_mbox.req);
    atomic_store_explicit(&g_mbox.resp_ret, ret, memory_order_relaxed);
    atomic_store_explicit(&g_mbox.state, MBOX_RESPONSE, memory_order_release);
  }
  return NULL;
}

static void start_io_thread(void) {
  pthread_attr_t attr;
  pthread_attr_init(&attr);
  // `-Wl,--stack-first` (see build.bat) only protects the *main* thread's
  // stack by placing it at the bottom of linear memory; spawned pthread
  // stacks (this one included) come from wasi-libc's normal runtime
  // allocation and get no such protection. Give this thread a generous,
  // explicit stack rather than relying on the linker default -- see
  // documents/threaded-file-io-rpc-plan.md constraint 3.
  pthread_attr_setstacksize(&attr, 262144);
  pthread_t io_thread;
  pthread_create(&io_thread, &attr, io_server_main, NULL);
  pthread_attr_destroy(&attr);
  while (!atomic_load_explicit(&g_io_thread_ready, memory_order_acquire))
    sched_yield();
}

// True only for the I/O server thread itself -- lets its own incidental
// I/O (if any) call straight through instead of RPCing to itself and
// deadlocking.
static int on_io_thread(void) { return t_is_io_thread; }

static int32_t do_rpc(struct io_request *r) {
  pthread_once(&g_io_once, start_io_thread);

  int expected = 0;
  while (!atomic_compare_exchange_weak_explicit(
      &g_mbox.submit_lock, &expected, 1, memory_order_acquire,
      memory_order_relaxed)) {
    expected = 0;
    sched_yield();
  }

  g_mbox.req = *r;
  atomic_store_explicit(&g_mbox.state, MBOX_REQUEST, memory_order_release);

  // Deliberately a spin on a plain atomic load, not memory.atomic.wait32:
  // wait32 traps unconditionally on a real browser main/UI thread (see
  // documents/threaded-file-io-rpc-plan.md constraint 1), and this
  // function is called from every thread, including main. Using wait32
  // for worker threads and a spin only for main would mean two waiter
  // strategies to keep in sync for one protocol; one spin loop shared by
  // every caller is simpler and provably correct everywhere, at the cost
  // of busy-waiting during I/O latency (sched_yield() bounds how hard).
  while (atomic_load_explicit(&g_mbox.state, memory_order_acquire) !=
         MBOX_RESPONSE)
    sched_yield();

  int32_t ret = atomic_load_explicit(&g_mbox.resp_ret, memory_order_relaxed);
  atomic_store_explicit(&g_mbox.state, MBOX_IDLE, memory_order_release);
  atomic_store_explicit(&g_mbox.submit_lock, 0, memory_order_release);
  return ret;
}

// ---- The intercepted imports themselves --------------------------------
//
// Each of these takes over a wasm import wasi-libc otherwise resolves
// against the host directly -- see the file header comment.
//
// fd 0/1/2 (stdin/stdout/stderr) are exempted below from RPCing out at
// all: unlike a fd a program opens itself, these are host-global by
// convention -- every thread's own independent WASI host instance
// already maps them to the same real stdin/stdout/stderr, which is
// exactly why console output from every thread worked correctly all
// through this file's development, before any of this RPC existed.
// Routing them through the RPC anyway would be merely redundant on a
// Node host, but turns the single mailbox slot into a global lock on
// *all* console output -- every thread's `printf` would serialize
// through one spinlock, including the main thread's, which is the exact
// contention pattern constraint 1 exists to avoid (reached here via a
// spin rather than a trap, but still real contention on a host that
// can't cheaply yield, e.g. a browser main thread). Skipping the RPC for
// these fds removes console I/O from the critical path entirely, with
// no known correctness cost for typical programs -- the one case this
// exemption gets wrong is a program that itself `close()`s fd 0/1/2 and
// reuses that fd number for a real, cross-thread-shared file (rare, and
// arguably already dubious practice).
static int is_std_fd(int32_t fd) { return fd == 0 || fd == 1 || fd == 2; }

int32_t __imported_wasi_snapshot_preview1_fd_close(int32_t fd) {
  if (on_io_thread())
    return wasi_io_real_fd_close(fd);
  struct io_request r = {.op = IO_FD_CLOSE, .fd = fd};
  return do_rpc(&r);
}

int32_t __imported_wasi_snapshot_preview1_fd_fdstat_get(int32_t fd,
                                                          int32_t retptr0) {
  if (on_io_thread() || is_std_fd(fd))
    return wasi_io_real_fd_fdstat_get(fd, retptr0);
  struct io_request r = {.op = IO_FD_FDSTAT_GET, .fd = fd, .retptr0 = retptr0};
  return do_rpc(&r);
}

int32_t
__imported_wasi_snapshot_preview1_fd_fdstat_set_flags(int32_t fd,
                                                       int32_t flags) {
  if (on_io_thread() || is_std_fd(fd))
    return wasi_io_real_fd_fdstat_set_flags(fd, flags);
  struct io_request r = {
      .op = IO_FD_FDSTAT_SET_FLAGS, .fd = fd, .fdflags = flags};
  return do_rpc(&r);
}

int32_t __imported_wasi_snapshot_preview1_fd_seek(int32_t fd, int64_t offset,
                                                   int32_t whence,
                                                   int32_t retptr0) {
  if (on_io_thread())
    return wasi_io_real_fd_seek(fd, offset, whence, retptr0);
  struct io_request r = {.op = IO_FD_SEEK,
                          .fd = fd,
                          .offset = offset,
                          .whence = whence,
                          .retptr0 = retptr0};
  return do_rpc(&r);
}

int32_t __imported_wasi_snapshot_preview1_fd_write(int32_t fd, int32_t iovs,
                                                    int32_t iovs_len,
                                                    int32_t retptr0) {
  if (on_io_thread() || is_std_fd(fd))
    return wasi_io_real_fd_write(fd, iovs, iovs_len, retptr0);
  struct io_request r = {.op = IO_FD_WRITE,
                          .fd = fd,
                          .iovs = iovs,
                          .iovs_len = iovs_len,
                          .retptr0 = retptr0};
  return do_rpc(&r);
}

int32_t __imported_wasi_snapshot_preview1_fd_read(int32_t fd, int32_t iovs,
                                                   int32_t iovs_len,
                                                   int32_t retptr0) {
  if (on_io_thread() || is_std_fd(fd))
    return wasi_io_real_fd_read(fd, iovs, iovs_len, retptr0);
  struct io_request r = {.op = IO_FD_READ,
                          .fd = fd,
                          .iovs = iovs,
                          .iovs_len = iovs_len,
                          .retptr0 = retptr0};
  return do_rpc(&r);
}

int32_t __imported_wasi_snapshot_preview1_fd_pwrite(int32_t fd, int32_t iovs,
                                                     int32_t iovs_len,
                                                     int64_t offset,
                                                     int32_t retptr0) {
  if (on_io_thread())
    return wasi_io_real_fd_pwrite(fd, iovs, iovs_len, offset, retptr0);
  struct io_request r = {.op = IO_FD_PWRITE,
                          .fd = fd,
                          .iovs = iovs,
                          .iovs_len = iovs_len,
                          .offset = offset,
                          .retptr0 = retptr0};
  return do_rpc(&r);
}

int32_t __imported_wasi_snapshot_preview1_fd_pread(int32_t fd, int32_t iovs,
                                                    int32_t iovs_len,
                                                    int64_t offset,
                                                    int32_t retptr0) {
  if (on_io_thread())
    return wasi_io_real_fd_pread(fd, iovs, iovs_len, offset, retptr0);
  struct io_request r = {.op = IO_FD_PREAD,
                          .fd = fd,
                          .iovs = iovs,
                          .iovs_len = iovs_len,
                          .offset = offset,
                          .retptr0 = retptr0};
  return do_rpc(&r);
}

int32_t __imported_wasi_snapshot_preview1_path_open(
    int32_t dirfd, int32_t dirflags, int32_t path, int32_t path_len,
    int32_t oflags, int64_t rights_base, int64_t rights_inheriting,
    int32_t fdflags, int32_t retptr0) {
  if (on_io_thread())
    return wasi_io_real_path_open(dirfd, dirflags, path, path_len, oflags,
                                   rights_base, rights_inheriting, fdflags,
                                   retptr0);
  struct io_request r = {.op = IO_PATH_OPEN,
                          .dirfd = dirfd,
                          .dirflags = dirflags,
                          .path = path,
                          .path_len = path_len,
                          .oflags = oflags,
                          .rights_base = rights_base,
                          .rights_inheriting = rights_inheriting,
                          .fdflags = fdflags,
                          .retptr0 = retptr0};
  return do_rpc(&r);
}

#endif // defined(__wasi__) && defined(__wasm_atomics__)
