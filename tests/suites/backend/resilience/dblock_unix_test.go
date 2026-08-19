//go:build unix

package resilience_test

import (
	"fmt"
	"os"
	"syscall"
)

// lockDatabaseFile takes an exclusive POSIX advisory lock over the whole of
// a sqlite database file and returns a function that releases it.
//
// fcntl, not flock: SQLite's own locking is built out of fcntl byte-range
// locks on the pages at PENDING_BYTE and above, and the two mechanisms do
// not see each other. A whole-file F_WRLCK with Len 0 -- "to the end of the
// file and beyond" -- covers those bytes, so a sqlite connection opening
// the file afterwards genuinely cannot take the shared lock it needs.
//
// This is what makes "a locked sqlite file" a real fault rather than a
// simulated one: nothing about the file's contents or permissions changes,
// and the process under test fails for exactly the reason a second Amiro
// instance, a backup tool or an editor holding the file would make it fail.
func lockDatabaseFile(path string) (release func(), err error) {
	f, err := os.OpenFile(path, os.O_RDWR, 0o644)
	if err != nil {
		return nil, fmt.Errorf("opening %s to lock it: %w", path, err)
	}
	lk := syscall.Flock_t{Type: syscall.F_WRLCK, Whence: 0, Start: 0, Len: 0}
	// F_SETLK, not F_SETLKW: if something already holds this we want to be
	// told now, not to block the test forever waiting for it.
	if err := syscall.FcntlFlock(f.Fd(), syscall.F_SETLK, &lk); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("taking an exclusive fcntl lock on %s: %w", path, err)
	}
	return func() {
		unlock := syscall.Flock_t{Type: syscall.F_UNLCK, Whence: 0, Start: 0, Len: 0}
		_ = syscall.FcntlFlock(f.Fd(), syscall.F_SETLK, &unlock)
		_ = f.Close()
	}, nil
}
