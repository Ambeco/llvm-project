//===--- Shutdown.cpp - Unclean exit scenarios ----------------------------===//
//
// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
//
//===----------------------------------------------------------------------===//

#include "support/Shutdown.h"

#include "llvm/Config/llvm-config.h"
#include <atomic>
#include <cstdlib>
#include <thread>

namespace clang {
namespace clangd {

void abortAfterTimeout(std::chrono::seconds Timeout) {
#if LLVM_ENABLE_THREADS
  // This is more portable than sys::WatchDog, and yields a stack trace.
  std::thread([Timeout] {
    std::this_thread::sleep_for(Timeout);
    std::abort();
  }).detach();
#endif // Without threads there is nothing to run the watchdog on.
}

static std::atomic<bool> ShutdownRequested = {false};

void requestShutdown() {
  if (ShutdownRequested.exchange(true))
    // This is the second shutdown request. Exit hard.
    std::abort();
}

bool shutdownRequested() { return ShutdownRequested; }

} // namespace clangd
} // namespace clang
