//===-- Platform.h ----------------------------------------------*- C++ -*-===//
//
// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
//
//===----------------------------------------------------------------------===//

#ifndef LLDB_TOOLS_DRIVER_PLATFORM_H
#define LLDB_TOOLS_DRIVER_PLATFORM_H

#if defined(_WIN32)

#include <io.h>
#if defined(_MSC_VER)
#include <csignal>
#endif

#include "lldb/Host/windows/windows.h"
#include <cinttypes>
#include <sys/types.h>

struct winsize {
  long ws_col;
};

typedef unsigned char cc_t;
typedef unsigned int speed_t;
typedef unsigned int tcflag_t;

// ioctls.h
#define TIOCGWINSZ 0x5413

// signal.h
#define SIGPIPE 13
#define SIGCONT 18
#define SIGTSTP 20
#define SIGWINCH 28

// tcsetattr arguments
#define TCSANOW 0

#define NCCS 32
struct termios {
  tcflag_t c_iflag; // input mode flags
  tcflag_t c_oflag; // output mode flags
  tcflag_t c_cflag; // control mode flags
  tcflag_t c_lflag; // local mode flags
  cc_t c_line;      // line discipline
  cc_t c_cc[NCCS];  // control characters
  speed_t c_ispeed; // input speed
  speed_t c_ospeed; // output speed
};

#ifdef _MSC_VER
struct timeval {
  long tv_sec;
  long tv_usec;
};
#include "lldb/Host/PosixApi.h"
#endif

#define STDIN_FILENO 0

extern int ioctl(int d, int request, ...);
extern int kill(pid_t pid, int sig);
extern int tcsetattr(int fd, int optional_actions,
                     const struct termios *termios_p);
extern int tcgetattr(int fildes, struct termios *termios_p);

#elif defined(__wasi__)
// WASI has no termios/real terminal at all (no <termios.h>, and
// TIOCGWINSZ/struct winsize aren't declared by <sys/ioctl.h> either -- see
// lldb/source/Host/posix/FilePosix.cpp's identical finding). This driver
// only runs headless/MI-mode on this target, so these just need to exist and
// report "no terminal" rather than actually work, the same shape as the
// _WIN32 shim above.
#include <cinttypes>

#include <libgen.h>
#include <pthread.h>
#include <sys/ioctl.h>
#include <sys/time.h>
#include <unistd.h>

struct winsize {
  unsigned short ws_row;
  unsigned short ws_col;
};
#ifndef TIOCGWINSZ
#define TIOCGWINSZ 0x5413
#endif

typedef unsigned char cc_t;
typedef unsigned int speed_t;
typedef unsigned int tcflag_t;

#define TCSANOW 0
#define NCCS 32
struct termios {
  tcflag_t c_iflag;
  tcflag_t c_oflag;
  tcflag_t c_cflag;
  tcflag_t c_lflag;
  cc_t c_line;
  cc_t c_cc[NCCS];
  speed_t c_ispeed;
  speed_t c_ospeed;
};

inline int tcsetattr(int, int, const struct termios *) { return -1; }
inline int tcgetattr(int, struct termios *) { return -1; }

#else
#include <cinttypes>

#include <libgen.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>

#include <pthread.h>
#include <sys/time.h>
#endif

#endif // LLDB_TOOLS_DRIVER_PLATFORM_H
