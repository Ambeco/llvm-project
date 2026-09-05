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
// whichever thread's table it was allocated from.
//
// This file fixes that *without any host support*, entirely inside the
// compiled wasm module: one dedicated thread (spawned lazily, on first
// use) owns the one real, canonical fd table by being the only thread
// that ever calls the real open/read/write/... entry points. Every other
// thread's call to open/read/write/pread/pwrite/readv/writev/close is
// intercepted (via `-Wl,--wrap=`) and instead marshals its arguments to
// the I/O thread through a single shared-memory mailbox, blocks (by
// spinning -- see the note on memory.atomic.wait32 below), and receives
// the real result back.
//
// See documents/threaded-file-io-rpc-plan.md for the full design
// rationale this implements.
//
// Usage: compile this file for a wasm32-wasi*-threads target (it compiles
// to nothing -- an empty translation unit -- everywhere else, so it's
// always safe to add to a build) and pass these extra linker flags (each
// wrapped name needs BOTH -Wl,--wrap= and -Wl,-u, -- see "Linker gotcha"
// in documents/threaded-file-io-rpc-plan.md for why the -u half matters):
//
//   -Wl,--wrap=__wasilibc_nocwd_openat_nomode -Wl,-u,__wasilibc_nocwd_openat_nomode \
//   -Wl,--wrap=read     -Wl,-u,read     -Wl,--wrap=write  -Wl,-u,write  \
//   -Wl,--wrap=pread    -Wl,-u,pread    -Wl,--wrap=pwrite -Wl,-u,pwrite \
//   -Wl,--wrap=readv    -Wl,-u,readv    -Wl,--wrap=writev -Wl,-u,writev \
//   -Wl,--wrap=close    -Wl,-u,close    -Wl,--wrap=fcntl  -Wl,-u,fcntl  \
//   -Wl,--wrap=__isatty -Wl,-u,__isatty -Wl,--wrap=__lseek -Wl,-u,__lseek
//
// Interception point note: `open`/`openat` themselves are NOT wrapped --
// wasi-libc's own `fopen()` bypasses them and calls the lower-level
// `__wasilibc_nocwd_openat_nomode` (path already resolved to a preopen
// dirfd + relative path by `__wasilibc_find_relpath`, which is pure
// computation on an already-shared global table, not a host call, so it
// needs no interception of its own) directly, so wrapping only
// `open`/`openat` silently misses every `FILE*` (`fopen`/`fread`/etc.)
// caller. Wrapping this one lower primitive instead catches raw
// `open()`/`openat()` and `fopen()` uniformly, in one place. `fcntl` and
// `__isatty` are wrapped too because `fdopen()` (which `fopen()` calls)
// uses both on the fd it just opened, and both would otherwise resolve
// the fd against the calling thread's own (empty, for that fd) table
// instead of the server's -- this was found and fixed after an initial
// version of this file passed the open/pwrite/close smoketest above but
// silently broke `fopen`+`fread` on a cross-thread-visible fd (a real
// regression, caught by comparing against a no-shim baseline rather than
// trusting the program's own self-check -- see the smoketest program's
// own comment about exactly this trap).
//
// Not yet wired into build.bat/CMake or the clang driver -- see
// documents/threaded-file-io-rpc-plan.md's build order. For now, link
// this .c file (or its .o) directly into whatever wasm32-wasi*-threads
// binary needs shared-fd-across-threads support (both clang.wasm itself,
// if it ever needs this, and any -pthread program clang.wasm compiles).
//
//===--------------------------------------------------------------------===//

#if defined(__wasi__) && defined(__wasm_atomics__)

#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <sched.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <string.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <unistd.h>

// The real, unwrapped entry points -- `-Wl,--wrap=X` renames the module's
// own callers of `X` to call `__wrap_X` (defined below) and makes `X`'s
// original definition reachable as `__real_X`. Only the dedicated I/O
// thread ever calls these.
int __real___wasilibc_nocwd_openat_nomode(int, const char *, int);
ssize_t __real_read(int, void *, size_t);
ssize_t __real_write(int, const void *, size_t);
ssize_t __real_pread(int, void *, size_t, off_t);
ssize_t __real_pwrite(int, const void *, size_t, off_t);
ssize_t __real_readv(int, const struct iovec *, int);
ssize_t __real_writev(int, const struct iovec *, int);
int __real_close(int);
int __real_fcntl(int, int, ...);
int __real___isatty(int);
off_t __real___lseek(int, off_t, int);

enum io_op {
  IO_OPENAT_NOMODE,
  IO_READ,
  IO_WRITE,
  IO_PREAD,
  IO_PWRITE,
  IO_READV,
  IO_WRITEV,
  IO_CLOSE,
  IO_FCNTL,
  IO_ISATTY,
  IO_LSEEK,
};

// All threads share one linear memory, so pointers (path, buf, iov) can be
// handed across as-is -- no serialization needed, just a plain struct copy.
struct io_request {
  enum io_op op;
  int fd;
  int dirfd;
  const char *path;
  int oflags;
  void *buf;
  size_t count;
  const struct iovec *iov;
  int iovcnt;
  off_t offset;
  long fcntl_arg; // fcntl()'s optional 3rd argument, forwarded as a plain
                   // word -- int and pointer are both 32 bits on wasm32,
                   // so this covers both without needing to know which
                   // fcntl command was requested.
  int whence;      // lseek()'s 3rd argument.
};

struct io_response {
  long long ret;
  int err;
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
  struct io_response resp;
} g_mbox;

static pthread_once_t g_io_once = PTHREAD_ONCE_INIT;
static _Atomic int g_io_thread_ready = 0;

// Forward decl -- t_is_io_thread's definition sits next to do_real_io()
// below, where it's easiest to explain, but on_io_thread() (used by every
// __wrap_* function further down) needs it declared first.
static _Thread_local int t_is_io_thread;

static long long do_real_io(struct io_request *r, int *out_err) {
  long long ret;
  switch (r->op) {
  case IO_OPENAT_NOMODE:
    ret = __real___wasilibc_nocwd_openat_nomode(r->dirfd, r->path, r->oflags);
    break;
  case IO_READ:
    ret = __real_read(r->fd, r->buf, r->count);
    break;
  case IO_WRITE:
    ret = __real_write(r->fd, r->buf, r->count);
    break;
  case IO_PREAD:
    ret = __real_pread(r->fd, r->buf, r->count, r->offset);
    break;
  case IO_PWRITE:
    ret = __real_pwrite(r->fd, r->buf, r->count, r->offset);
    break;
  case IO_READV:
    ret = __real_readv(r->fd, r->iov, r->iovcnt);
    break;
  case IO_WRITEV:
    ret = __real_writev(r->fd, r->iov, r->iovcnt);
    break;
  case IO_CLOSE:
    ret = __real_close(r->fd);
    break;
  case IO_FCNTL:
    ret = __real_fcntl(r->fd, r->oflags, r->fcntl_arg);
    break;
  case IO_ISATTY:
    ret = __real___isatty(r->fd);
    break;
  case IO_LSEEK:
    ret = __real___lseek(r->fd, r->offset, r->whence);
    break;
  default:
    *out_err = EINVAL;
    return -1;
  }
  *out_err = (ret < 0) ? errno : 0;
  return ret;
}

// Set as the first statement of io_server_main(), before anything else
// (including the g_io_thread_ready store below) can run on this thread.
// Deliberately thread-local rather than comparing pthread_self() against
// a shared g_io_thread global: g_io_thread is written by the *parent* in
// pthread_create() and could otherwise be read here before that write is
// visible, making the server appear not-yet-ready to itself and RPC to
// itself -- a guaranteed deadlock. A thread-local set by the thread about
// itself has no such ordering dependency.
static _Thread_local int t_is_io_thread = 0;

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
    int err = 0;
    long long ret = do_real_io(&g_mbox.req, &err);
    g_mbox.resp.ret = ret;
    g_mbox.resp.err = err;
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

static long long do_rpc(struct io_request *r, int *out_err) {
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

  long long ret = g_mbox.resp.ret;
  *out_err = g_mbox.resp.err;
  atomic_store_explicit(&g_mbox.state, MBOX_IDLE, memory_order_release);
  atomic_store_explicit(&g_mbox.submit_lock, 0, memory_order_release);
  return ret;
}

// ---- wrapped entry points (need -Wl,--wrap=<name> at link time each) ----
//
// open()/openat() themselves are deliberately NOT wrapped -- see the file
// header comment. This one catches both of them and fopen().
int __wrap___wasilibc_nocwd_openat_nomode(int dirfd, const char *path,
                                           int oflags) {
  if (on_io_thread())
    return __real___wasilibc_nocwd_openat_nomode(dirfd, path, oflags);
  struct io_request r = {
      .op = IO_OPENAT_NOMODE, .dirfd = dirfd, .path = path, .oflags = oflags};
  int err = 0;
  long long ret = do_rpc(&r, &err);
  if (ret < 0)
    errno = err;
  return (int)ret;
}

ssize_t __wrap_read(int fd, void *buf, size_t count) {
  if (on_io_thread())
    return __real_read(fd, buf, count);
  struct io_request r = {.op = IO_READ, .fd = fd, .buf = buf, .count = count};
  int err = 0;
  long long ret = do_rpc(&r, &err);
  if (ret < 0)
    errno = err;
  return (ssize_t)ret;
}

ssize_t __wrap_write(int fd, const void *buf, size_t count) {
  if (on_io_thread())
    return __real_write(fd, buf, count);
  struct io_request r = {
      .op = IO_WRITE, .fd = fd, .buf = (void *)buf, .count = count};
  int err = 0;
  long long ret = do_rpc(&r, &err);
  if (ret < 0)
    errno = err;
  return (ssize_t)ret;
}

ssize_t __wrap_pread(int fd, void *buf, size_t count, off_t offset) {
  if (on_io_thread())
    return __real_pread(fd, buf, count, offset);
  struct io_request r = {
      .op = IO_PREAD, .fd = fd, .buf = buf, .count = count, .offset = offset};
  int err = 0;
  long long ret = do_rpc(&r, &err);
  if (ret < 0)
    errno = err;
  return (ssize_t)ret;
}

ssize_t __wrap_pwrite(int fd, const void *buf, size_t count, off_t offset) {
  if (on_io_thread())
    return __real_pwrite(fd, buf, count, offset);
  struct io_request r = {.op = IO_PWRITE,
                          .fd = fd,
                          .buf = (void *)buf,
                          .count = count,
                          .offset = offset};
  int err = 0;
  long long ret = do_rpc(&r, &err);
  if (ret < 0)
    errno = err;
  return (ssize_t)ret;
}

ssize_t __wrap_readv(int fd, const struct iovec *iov, int iovcnt) {
  if (on_io_thread())
    return __real_readv(fd, iov, iovcnt);
  struct io_request r = {.op = IO_READV, .fd = fd, .iov = iov, .iovcnt = iovcnt};
  int err = 0;
  long long ret = do_rpc(&r, &err);
  if (ret < 0)
    errno = err;
  return (ssize_t)ret;
}

ssize_t __wrap_writev(int fd, const struct iovec *iov, int iovcnt) {
  if (on_io_thread())
    return __real_writev(fd, iov, iovcnt);
  struct io_request r = {
      .op = IO_WRITEV, .fd = fd, .iov = iov, .iovcnt = iovcnt};
  int err = 0;
  long long ret = do_rpc(&r, &err);
  if (ret < 0)
    errno = err;
  return (ssize_t)ret;
}

int __wrap_close(int fd) {
  if (on_io_thread())
    return __real_close(fd);
  struct io_request r = {.op = IO_CLOSE, .fd = fd};
  int err = 0;
  long long ret = do_rpc(&r, &err);
  if (ret < 0)
    errno = err;
  return (int)ret;
}

// fdopen() (which fopen() calls) runs fcntl()/__isatty() on the fd it just
// opened to decide the stream's buffering mode -- both need routing too,
// or they silently resolve the (now server-owned) fd against the calling
// thread's own table instead. Only F_GETFL/F_SETFL-style commands with a
// plain int (or no) 3rd argument are meaningfully supported here: a
// command whose 3rd argument is itself a pointer into this thread's own
// memory (e.g. F_GETLK/F_SETLK's `struct flock *`) is still forwarded as
// a bare word and dereferenced correctly regardless of which thread
// dereferences it, since all threads share one linear memory -- so this
// isn't actually a limitation for wasm, just calling out that the
// request struct's field is untyped on purpose.
int __wrap_fcntl(int fd, int cmd, ...) {
  // Only pull the variadic argument for commands that actually pass one
  // (F_GETFD/F_GETFL do not) -- reading a va_arg that was never supplied
  // is undefined behavior, not just a wrong value, and F_GETFL is exactly
  // what fdopen() calls on every fopen().
  long arg = 0;
  switch (cmd) {
  case F_DUPFD:
  case F_SETFD:
  case F_SETFL:
  case F_GETLK:
  case F_SETLK:
  case F_SETLKW: {
    va_list ap;
    va_start(ap, cmd);
    arg = va_arg(ap, long);
    va_end(ap);
    break;
  }
  default:
    break; // e.g. F_GETFD, F_GETFL: no 3rd argument.
  }
  if (on_io_thread())
    return __real_fcntl(fd, cmd, arg);
  struct io_request r = {
      .op = IO_FCNTL, .fd = fd, .oflags = cmd, .fcntl_arg = arg};
  int err = 0;
  long long ret = do_rpc(&r, &err);
  if (ret < 0)
    errno = err;
  return (int)ret;
}

int __wrap___isatty(int fd) {
  if (on_io_thread())
    return __real___isatty(fd);
  struct io_request r = {.op = IO_ISATTY, .fd = fd};
  int err = 0;
  long long ret = do_rpc(&r, &err);
  if (ret < 0)
    errno = err;
  return (int)ret;
}

off_t __wrap___lseek(int fd, off_t offset, int whence) {
  if (on_io_thread())
    return __real___lseek(fd, offset, whence);
  struct io_request r = {
      .op = IO_LSEEK, .fd = fd, .offset = offset, .whence = whence};
  int err = 0;
  long long ret = do_rpc(&r, &err);
  if (ret < 0)
    errno = err;
  return (off_t)ret;
}

#endif // defined(__wasi__) && defined(__wasm_atomics__)
