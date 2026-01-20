# A 40-Line Fix Eliminated a 400x Performance Gap

**Source:** https://questdb.com/blog/jvm-current-thread-user-time/

## Overview

Jaromir Hamala from QuestDB analyzed an OpenJDK commit that dramatically improved the performance of `ThreadMXBean.getCurrentThreadUserTime()` by replacing inefficient `/proc` file parsing with a single system call.

## The Problem

### Original Implementation

The old code in `os_linux.cpp` retrieved thread CPU time by:

1. Opening `/proc/self/task/<tid>/stat`
2. Reading the file into a buffer
3. Parsing through a complex format where command names could contain parentheses
4. Using `sscanf()` to extract fields 13 and 14
5. Converting clock ticks to nanoseconds

The original bug report from 2018 stated: *"getCurrentThreadUserTime is 30x-400x slower than getCurrentThreadCpuTime"*

### Why the Performance Gap?

The `/proc` approach involved multiple syscalls, VFS machinery, kernel-side string formatting, and userspace parsing. In contrast, `getCurrentThreadCpuTime()` used a single `clock_gettime()` call with minimal overhead.

## The Linux Kernel Bit Hack

The fix exploited a stable but undocumented Linux kernel feature. Since kernel 2.6.12, `clockid_t` values encode clock type information in specific bits:

- **Bit 2**: Thread vs. process clock
- **Bits 1-0**: Clock type (00=PROF, 01=VIRT for user-time-only, 10=SCHED for total)

By obtaining a `clockid` via `pthread_getcpuclockid()` and flipping bits to `01` (VIRT), the code requests user-time-only measurements rather than total CPU time.

## The Solution

The new implementation:

```cpp
static bool get_thread_clockid(Thread* thread, clockid_t* clockid, bool total) {
  int rc = pthread_getcpuclockid(thread->osthread()->pthread_id(), clockid);
  if (rc != 0) return false;

  if (!total) {
    *clockid = (*clockid & ~CLOCK_TYPE_MASK) | CPUCLOCK_VIRT;
  }
  return true;
}
```

Replaced approximately 40 lines of `/proc` parsing with a direct kernel call, requiring no file I/O or complex parsing.

## Performance Results

### Before Fix
- Average: 11.186 microseconds per operation
- Median: ~10.27 microseconds

### After Fix
- Average: 0.279 microseconds per operation
- Median: ~0.31 microseconds

This represents a **40x improvement** in latency. CPU profiling showed syscalls were eliminated in favor of direct kernel function calls.

## Further Optimization

Analysis revealed the kernel has a fast-path when PID=0 is encoded in the `clockid`, skipping radix tree lookups. By manually constructing the entire `clockid` rather than using `pthread_getcpuclockid()`, an additional **13% improvement** was achieved, reducing average time to 70.8 nanoseconds.

## Key Insights

- **Read kernel source**: POSIX defines portability; kernel internals reveal optimization opportunities
- **Revisit assumptions**: The `/proc` approach made sense historically but became suboptimal
- **Stability matters**: The Linux bit encoding remained unchanged for 20+ years, making it safe to rely upon

## Impact

The change landed December 3, 2025, just before JDK 26's feature freeze. Users of `ThreadMXBean.getCurrentThreadUserTime()` in JDK 26 (releasing March 2026) gain a free 30-400x performance improvement.

---

**Note:** Screenshots would show the blog post layout, code examples, and performance graphs from the original article. These are captured during the actual browser navigation process.
