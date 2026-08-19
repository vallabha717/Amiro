package backend

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Lock mirrors backend-go/internal/appwiring.Lock -- the discovery file a
// running server writes so that `amiro` launched in a terminal attaches to
// it instead of starting a second backend against the same database.
//
// TRANSCRIBED, not imported. Go forbids importing amiro/backend/internal/...
// from this module, which is the language enforcing the boundary
// docs/testing/01-architecture.md wanted anyway: the test system asserts on
// what the app puts on disk, not on the type it used to put it there.
//
// The cost of transcription is drift, and it is covered rather than
// accepted: suites/backend/smoke reads a real lock file written by a real
// server and fails if these fields no longer decode.
type Lock struct {
	PID   int    `json:"pid"`
	Port  int    `json:"port"`
	Token string `json:"token"`
}

// LockFileName is the file appwiring.WriteLock creates inside the app-data
// directory.
const LockFileName = "sidecar.lock.json"

// ReadLock loads the discovery lock from an app-data directory.
func ReadLock(appDataDir string) (Lock, bool, error) {
	path := filepath.Join(appDataDir, LockFileName)
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Lock{}, false, nil
		}
		return Lock{}, false, err
	}
	var l Lock
	if err := json.Unmarshal(raw, &l); err != nil {
		return Lock{}, false, fmt.Errorf("%s: %w", path, err)
	}
	return l, true, nil
}
