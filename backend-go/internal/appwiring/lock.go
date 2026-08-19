package appwiring

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
)

// lockFileName is the discovery file a running server drops in its
// AppDataDir so a second process started against the same data directory
// (the terminal client's attach-or-embed transport, docs/tui-implementation-
// plan.md §2.2) can find it instead of blindly starting a second one.
//
// It carries exactly what an HTTP client needs to talk to that server, and
// nothing a config file should hold instead -- the shared-secret token
// included here is per-process and dies with it, unlike a provider API key.
const lockFileName = "sidecar.lock.json"

// Lock is the discovery file's contents.
type Lock struct {
	PID   int    `json:"pid"`
	Port  int    `json:"port"`
	Token string `json:"token"`
}

// LockPath returns where the discovery file for appDataDir lives.
func LockPath(appDataDir string) string {
	return filepath.Join(appDataDir, lockFileName)
}

// WriteLock records this process as the live server for appDataDir. Callers
// bind their listener first and pass the real port -- never the 0 a caller
// asked for.
func WriteLock(appDataDir string, port int, token string) error {
	b, err := json.Marshal(Lock{PID: os.Getpid(), Port: port, Token: token})
	if err != nil {
		return err
	}
	return os.WriteFile(LockPath(appDataDir), b, 0o600)
}

// RemoveLock deletes the discovery file. Safe to call even if it was never
// written or was already removed.
func RemoveLock(appDataDir string) error {
	err := os.Remove(LockPath(appDataDir))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// ReadLock reads the discovery file, if any. A missing file is not an
// error -- ok reports whether one was found.
func ReadLock(appDataDir string) (lock Lock, ok bool, err error) {
	b, err := os.ReadFile(LockPath(appDataDir))
	if errors.Is(err, os.ErrNotExist) {
		return Lock{}, false, nil
	}
	if err != nil {
		return Lock{}, false, err
	}
	if err := json.Unmarshal(b, &lock); err != nil {
		return Lock{}, false, err
	}
	return lock, true, nil
}

// LoopbackURL builds the base URL for a server bound to 127.0.0.1 on port.
//
// A lock file's server is not necessarily still alive -- it may have been
// SIGKILLed without a chance to RemoveLock. Proving liveness needs a real
// HTTP round trip (with the lock's own token), which is what a Client built
// from this URL gives a caller for free; this package stays a leaf with no
// HTTP dependency of its own.
func LoopbackURL(port int) string {
	return "http://127.0.0.1:" + strconv.Itoa(port)
}
