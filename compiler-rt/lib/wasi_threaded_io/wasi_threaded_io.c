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
// always safe to add to a build) and pass these extra linker flags:
//
//   -Wl,--wrap=open -Wl,--wrap=openat -Wl,--wrap=read -Wl,--wrap=write \
//   -Wl,--wrap=pread -Wl,--wrap=pwrite -Wl,--wrap=readv -Wl,--wrap=writev \
//   -Wl,--wrap=close
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
int __real_open(const char *, int, ...);
int __real_openat(int, const char *, int, ...);
ssize_t __real_read(int, void *, size_t);
ssize_t __real_write(int, const void *, size_t);
ssize_t __real_pread(int, void *, size_t, off_t);
ssize_t __real_pwrite(int, const void *, size_t, off_t);
ssize_t __real_readv(int, const struct iovec *, int);
ssize_t __real_writev(int, const struct iovec *, int);
int __real_close(int);

enum io_op {
  IO_OPEN,
  IO_OPENAT,
  IO_READ,
  IO_WRITE,
  IO_PREAD,
  IO_PWRITE,
  IO_READV,
  IO_WRITEV,
  IO_CLOSE,
};

// All threads share one linear memory, so pointers (path, buf, iov) can be
// handed across as-is -- no serialization needed, just a plain struct copy.
struct io_request {
  enum io_op op;
  int fd;
  int dirfd;
  const char *path;
  int oflags;
  mode_t mode;
  void *buf;
  size_t count;
  const struct iovec *iov;
  int iovcnt;
  off_t offset;
};

struct io_response {
  long ret;
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
static pthread_t g_io_thread;
static _Atomic int g_io_thread_ready = 0;

static long do_real_io(struct io_request *r, int *out_err) {
  long ret;
  switch (r->op) {
  case IO_OPEN:
    ret = __real_open(r->path, r->oflags, r->mode);
    break;
  case IO_OPENAT:
    ret = __real_openat(r->dirfd, r->path, r->oflags, r->mode);
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
  default:
    *out_err = EINVAL;
    return -1;
  }
  *out_err = (ret < 0) ? errno : 0;
  return ret;
}

static void *io_server_main(void *arg) {
  (void)arg;
  atomic_store_explicit(&g_io_thread_ready, 1, memory_order_release);
  for (;;) {
    // Plain atomic-load spin, deliberately not memory.atomic.wait32/notify32:
    // see the matching comment in do_rpc() below for why every waiter in
    // this file (including this one) uses the same strategy.
    while (atomic_load_explicit(&g_mbox.state, memory_order_acquire) !=
           MBOX_REQUEST)
      sched_yield();
    int err = 0;
    long ret = do_real_io(&g_mbox.req, &err);
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
  pthread_create(&g_io_thread, &attr, io_server_main, NULL);
  pthread_attr_destroy(&attr);
  while (!atomic_load_explicit(&g_io_thread_ready, memory_order_acquire))
    sched_yield();
}

// True only for the I/O server thread itself -- lets its own incidental
// I/O (if any) call straight through instead of RPCing to itself and
// deadlocking.
static int on_io_thread(void) {
  return atomic_load_explicit(&g_io_thread_ready, memory_order_acquire) &&
         pthread_equal(pthread_self(), g_io_thread);
}

static long do_rpc(struct io_request *r, int *out_err) {
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

  long ret = g_mbox.resp.ret;
  *out_err = g_mbox.resp.err;
  atomic_store_explicit(&g_mbox.state, MBOX_IDLE, memory_order_release);
  atomic_store_explicit(&g_mbox.submit_lock, 0, memory_order_release);
  return ret;
}

// ---- wrapped entry points (need -Wl,--wrap=<name> at link time each) ----

int __wrap_open(const char *path, int oflags, ...) {
  mode_t mode = 0;
  if (oflags & O_CREAT) {
    va_list ap;
    va_start(ap, oflags);
    mode = va_arg(ap, mode_t);
    va_end(ap);
  }
  if (on_io_thread())
    return __real_open(path, oflags, mode);
  struct io_request r = {
      .op = IO_OPEN, .path = path, .oflags = oflags, .mode = mode};
  int err = 0;
  long ret = do_rpc(&r, &err);
  if (ret < 0)
    errno = err;
  return (int)ret;
}

int __wrap_openat(int dirfd, const char *path, int oflags, ...) {
  mode_t mode = 0;
  if (oflags & O_CREAT) {
    va_list ap;
    va_start(ap, oflags);
    mode = va_arg(ap, mode_t);
    va_end(ap);
  }
  if (on_io_thread())
    return __real_openat(dirfd, path, oflags, mode);
  struct io_request r = {.op = IO_OPENAT,
                          .dirfd = dirfd,
                          .path = path,
                          .oflags = oflags,
                          .mode = mode};
  int err = 0;
  long ret = do_rpc(&r, &err);
  if (ret < 0)
    errno = err;
  return (int)ret;
}

ssize_t __wrap_read(int fd, void *buf, size_t count) {
  if (on_io_thread())
    return __real_read(fd, buf, count);
  struct io_request r = {.op = IO_READ, .fd = fd, .buf = buf, .count = count};
  int err = 0;
  long ret = do_rpc(&r, &err);
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
  long ret = do_rpc(&r, &err);
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
  long ret = do_rpc(&r, &err);
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
  long ret = do_rpc(&r, &err);
  if (ret < 0)
    errno = err;
  return (ssize_t)ret;
}

ssize_t __wrap_readv(int fd, const struct iovec *iov, int iovcnt) {
  if (on_io_thread())
    return __real_readv(fd, iov, iovcnt);
  struct io_request r = {.op = IO_READV, .fd = fd, .iov = iov, .iovcnt = iovcnt};
  int err = 0;
  long ret = do_rpc(&r, &err);
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
  long ret = do_rpc(&r, &err);
  if (ret < 0)
    errno = err;
  return (ssize_t)ret;
}

int __wrap_close(int fd) {
  if (on_io_thread())
    return __real_close(fd);
  struct io_request r = {.op = IO_CLOSE, .fd = fd};
  int err = 0;
  long ret = do_rpc(&r, &err);
  if (ret < 0)
    errno = err;
  return (int)ret;
}

#endif // defined(__wasi__) && defined(__wasm_atomics__)
