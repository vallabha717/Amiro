// Package attachembed_test proves Phase 7 Exit Criterion 2's first half:
// "Attach-or-embed is proven in both directions ... with a server running,
// amiro attaches -- the second backend never starts. Without one, it
// embeds and works standalone" (docs/testing/phases/phase-07-cross-surface.md).
//
// This is black-box, through two real `amiro` binaries under real PTYs --
// not a call into cmd/amiro's internals (which backend-go/cmd/amiro's own
// unit tests, e.g. connect_test.go, already cover at the function level).
// The thing only a black-box test can prove is that the CLI's actual
// os.Args wiring (main.go -> tui.go -> serve.go's resolveTransport) reaches
// the same behaviour real users get, and that the on-disk discovery
// artifact (appwiring's sidecar.lock.json) is what a second real process
// actually reads.
//
// The proof that "the second backend never starts": appwiring.WriteLock
// records os.Getpid() of whichever process calls it (lock.go). If a second
// `amiro` pointed at the same AppDataDir had embedded its own backend
// instead of attaching, it would have called WriteLock itself and
// overwritten the file with its own PID and a new port. So reading the
// lock file before and after the second process starts, and asserting it
// is byte-for-byte unchanged, is a direct, non-vacuous proof -- not an
// inference from timing or process count.
package attachembed_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"amiro/tests/harness"
)

type lockFile struct {
	PID   int    `json:"pid"`
	Port  int    `json:"port"`
	Token string `json:"token"`
}

func readLock(t *testing.T, appDataDir string) lockFile {
	t.Helper()
	path := filepath.Join(appDataDir, "sidecar.lock.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading discovery lock %s: %v", path, err)
	}
	var lock lockFile
	if err := json.Unmarshal(data, &lock); err != nil {
		t.Fatalf("parsing discovery lock %s: %v", path, err)
	}
	return lock
}

func TestAttachOrEmbed_SecondProcessAttachesAndNeverStartsASecondBackend(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	appDataDir := filepath.Join(h.Dir(), "shared-appdata")
	if err := os.MkdirAll(appDataDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// Process 1: nothing is running yet at this AppDataDir, so it must
	// embed its own backend, auto-provision a desktop-default user (no
	// seeded session exists), and reach the chat prompt standalone.
	first := h.PTY(harness.PTYAppDataDir(appDataDir))
	defer first.Close()
	if err := first.WaitForText("Ask Amiro", 15*time.Second); err != nil {
		t.Fatalf("first amiro (embedding) did not reach its prompt: %v\nframe:\n%s", err, first.Frame())
	}

	lockAfterEmbed := readLock(t, appDataDir)
	if lockAfterEmbed.Port == 0 {
		t.Fatalf("embedding process wrote no usable port in its discovery lock: %+v", lockAfterEmbed)
	}

	// Process 2: a server is now running at this AppDataDir. It must
	// attach to it over HTTP, reuse the session process 1 already
	// provisioned (same "amiro:session" key, same keys.json), and -- the
	// property under test -- never call appwiring.WriteLock itself.
	second := h.PTY(harness.PTYAppDataDir(appDataDir))
	defer second.Close()
	if err := second.WaitForText("Ask Amiro", 15*time.Second); err != nil {
		t.Fatalf("second amiro (attaching) did not reach its prompt: %v\nframe:\n%s", err, second.Frame())
	}

	lockAfterAttach := readLock(t, appDataDir)
	if lockAfterAttach != lockAfterEmbed {
		t.Fatalf("discovery lock changed after the second process started -- it started its own backend "+
			"instead of attaching\nbefore: %+v\nafter:  %+v", lockAfterEmbed, lockAfterAttach)
	}
}
