//go:build !windows

package logging

import (
	"os"
	"syscall"
)

// lockFile takes an exclusive advisory lock so that two processes appending
// to events.ndjson cannot interleave. Returns the unlock function.
//
// A failure to lock is deliberately not fatal: the write still happens, in
// O_APPEND mode, and the worst case is reordering rather than a torn line.
// A test run should not die because a filesystem does not support flock.
func lockFile(f *os.File) func() {
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		return func() {}
	}
	return func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN) }
}
