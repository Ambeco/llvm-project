//===--- Unix/Watchdog.inc - Unix Watchdog Implementation -------*- C++ -*-===//
//
// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
//
//===----------------------------------------------------------------------===//
//
// This file provides the generic Unix implementation of the Watchdog class.
//
//===----------------------------------------------------------------------===//

#include "llvm/Config/config.h"

#ifdef HAVE_UNISTD_H
#include <unistd.h>
#endif

namespace llvm {
namespace sys {
Watchdog::Watchdog(unsigned int seconds) {
#if defined(HAVE_UNISTD_H) && !defined(__wasi__)
  alarm(seconds);
#endif
  // WASI has no alarm()/signals at all (see CrashRecoveryContext.cpp): this
  // is a silent no-op there rather than an error, matching the same
  // reasoning as Signals.inc's handler registration -- nothing checks
  // whether the watchdog armed successfully. Real hard-timeout enforcement
  // for a long-running compile belongs on the JS side (terminating the
  // Worker it's running in), not an in-module alarm.
}

Watchdog::~Watchdog() {
#if defined(HAVE_UNISTD_H) && !defined(__wasi__)
  alarm(0);
#endif
}
} // namespace sys
} // namespace llvm
