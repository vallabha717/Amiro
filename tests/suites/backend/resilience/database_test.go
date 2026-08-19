package resilience_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/backend"
	"amiro/tests/harness/config"
)

// Database faults. The phase document's row is:
//
//	A locked sqlite file; a corrupt file; a full disk on write; a postgres
//	connection dropped mid-transaction
//
// The first two are here and are real: the file is genuinely locked by
// another process holding an fcntl lock, and genuinely corrupt because its
// bytes were overwritten. The last two are NOT MET in this environment and
// are recorded as such rather than faked:
//
//   - Full disk on write. Producing ENOSPC needs a filesystem small enough
//     to fill, which means a loopback image or a size-capped tmpfs, which
//     means mount privileges this suite does not have (it runs unprivileged;
//     `id -u` is not 0 on the reference runner). Writing a huge file to fill
//     the real disk is not an acceptable substitute -- it would be a
//     destructive test of the developer's machine, not of Amiro. Closing it
//     needs a harness-level fixture that mounts a small filesystem under a
//     privileged CI step and exports its path; that fixture does not exist.
//   - Postgres connection dropped mid-transaction. There is no postgres
//     instance available here. harness/backend/db.go already supports the
//     postgres driver (one schema per test), so the test itself is small
//     once an instance exists; what is missing is docs/testing's postgres
//     fixture -- a container the run brings up and a DSN it configures --
//     which has not been built. Every test in this file runs on the sqlite
//     driver the suite defaults to.
//
// Both faults below are asserted the same way, because both are startup
// faults and a startup fault has exactly one honest success condition: the
// server REFUSES TO START, fast, saying why. The alternative -- a server
// that starts anyway and serves an empty or half-migrated database -- is
// the silent data loss the bar's "never a corrupt thread, never a silent
// partial write" exists to forbid, and it would look like a pass to any
// test that only checked /health.

// databaseFaultHarness builds a harness with NO backend of its own, and
// with the per-test database configured to survive a Stop.
//
// Both are needed. These tests start and stop several servers by hand
// against ONE database file, which is not something harness.Backend()'s
// single lazily-started instance can express; and harness/backend.Stop
// drops the database on the way out, which would delete the very file the
// next step is meant to find locked or corrupt.
func databaseFaultHarness(t *testing.T) *harness.Harness {
	t.Helper()
	return harness.New(t,
		harness.NoBackend(),
		harness.Tags("destructive"),
		harness.With(func(c *config.Config) { c.Backend.Database.KeepOnSuccess = true }),
	)
}

// startBackendForFault starts a server the same way harness.Backend() does,
// but under the caller's control, so several can share one database
// directory across one test.
func startBackendForFault(t *testing.T, h *harness.Harness, what string) (*backend.Backend, error) {
	t.Helper()
	var be *backend.Backend
	var err error
	runBounded(t, h, what, 90*time.Second, func(ctx context.Context) {
		be, err = backend.Start(ctx, backend.Options{
			RepoRoot: h.RepoRoot,
			BaseDir:  h.BaseDir,
			Config:   h.Config,
			Log:      h.Log,
			TestID:   h.TestID,
			Surface:  h.Surface,
			Address:  h.Address,
		})
	})
	return be, err
}

// stopBackendCleanly stops a server and fails the test if teardown was not
// clean -- the process still running, or its port still held.
// harness/backend.Stop asserts both and returns them, which is what the
// phase document's risk section means by "harness/process's teardown
// assertions are what keep this from silently degrading later tests".
func stopBackendCleanly(t *testing.T, be *backend.Backend, what string) {
	t.Helper()
	if be == nil {
		return
	}
	if err := be.Stop(context.Background()); err != nil {
		t.Fatalf("stopping the backend %s did not tear down cleanly: %v", what, err)
	}
}

// serverStderr reads the log the failed server wrote, which is where its
// reason for refusing to start ends up.
func serverStderr(t *testing.T, h *harness.Harness) string {
	t.Helper()
	path := h.Log.Path(filepath.Join("backend", h.TestID, "server.stderr.log"))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading the failed server's stderr at %s: %v", path, err)
	}
	return string(raw)
}

// TestResilience_LockedSQLiteFileRefusesToStartAndRecovers holds an
// exclusive lock on the database from outside and asserts the server says
// so and gives up, then starts normally once the lock is released.
func TestResilience_LockedSQLiteFileRefusesToStartAndRecovers(t *testing.T) {
	h := databaseFaultHarness(t)

	first, err := startBackendForFault(t, h, "the first backend, to create the database")
	if err != nil {
		t.Fatalf("starting a backend against a fresh database: %v", err)
	}
	dbPath := first.DB.DSN
	stopBackendCleanly(t, first, "that created the database")

	if _, statErr := os.Stat(dbPath); statErr != nil {
		t.Fatalf("the database file %s is not where harness/backend said it was: %v", dbPath, statErr)
	}

	release, lockErr := lockDatabaseFile(dbPath)
	if lockErr != nil {
		h.Skip("cannot hold an exclusive lock on the sqlite file here: " + lockErr.Error())
		return
	}
	releaseOnce := func() {
		if release != nil {
			release()
			release = nil
		}
	}
	defer releaseOnce()

	locked, lockedErr := startBackendForFault(t, h, "a backend against a locked database")
	if lockedErr == nil {
		stopBackendCleanly(t, locked, "that should not have started against a locked database")
		t.Fatalf("the backend started and reported healthy against a database file another process holds "+
			"an exclusive lock on (%s).\n"+
			"  Either the lock was not taken, or the server is serving a database it does not actually own -- "+
			"which is how two processes silently diverge and one of them loses writes.", dbPath)
	}
	t.Logf("locked-database startup failed as it should: %v", lockedErr)

	stderr := serverStderr(t, h)
	if !strings.Contains(stderr, "database is locked") {
		t.Errorf("the server refused to start against a locked database but never said why.\n"+
			"  want its stderr to mention \"database is locked\"; got:\n%s", truncateForLog(stderr))
	}

	// Recoverable state: the lock is the whole of the problem, and removing
	// it is the whole of the fix. Nothing has to be repaired by hand.
	releaseOnce()
	recovered, recoverErr := startBackendForFault(t, h, "a backend after the lock was released")
	if recoverErr != nil {
		t.Fatalf("the database was still unusable after the lock was released: %v\n"+
			"  a lock is a transient condition; a server that cannot recover from it has done "+
			"something to the file it should not have", recoverErr)
	}
	t.Cleanup(func() { stopBackendCleanly(t, recovered, "started after the lock was released") })
	assertBackendHealthy(t, h, apiClientFor(h, recovered), "releasing an exclusive lock on the database")
}

// TestResilience_CorruptSQLiteFileRefusesToStartAndRecovers overwrites the
// database with bytes that are not a database and asserts the server says
// so rather than starting on top of it.
//
// The recovery half is different from the locked case on purpose. A lock
// goes away on its own; corruption does not, and pretending otherwise would
// be the wrong claim. What is asserted instead is that the damage is
// CONTAINED: removing the corrupt file is enough, the server rebuilds from
// migrations, and nothing outside that file needed repairing.
func TestResilience_CorruptSQLiteFileRefusesToStartAndRecovers(t *testing.T) {
	h := databaseFaultHarness(t)

	first, err := startBackendForFault(t, h, "the first backend, to create the database")
	if err != nil {
		t.Fatalf("starting a backend against a fresh database: %v", err)
	}
	dbPath := first.DB.DSN
	dbDir := filepath.Dir(dbPath)
	stopBackendCleanly(t, first, "that created the database")

	// Not truncation and not deletion: a file of the right size full of the
	// wrong bytes. A zero-length file is indistinguishable from a database
	// that has not been created yet, and sqlite will happily create one --
	// so a test using truncation would prove nothing about corruption.
	garbage := make([]byte, 32<<10)
	for i := range garbage {
		garbage[i] = byte(i%251) ^ 0x5a
	}
	if writeErr := os.WriteFile(dbPath, garbage, 0o600); writeErr != nil {
		t.Fatalf("corrupting %s: %v", dbPath, writeErr)
	}
	// The WAL and shm sidecars describe the database that used to be there.
	// Leaving them would be a different, less pointed fault.
	for _, sidecar := range []string{dbPath + "-wal", dbPath + "-shm"} {
		_ = os.Remove(sidecar)
	}

	corrupt, corruptErr := startBackendForFault(t, h, "a backend against a corrupt database")
	if corruptErr == nil {
		stopBackendCleanly(t, corrupt, "that should not have started against a corrupt database")
		t.Fatalf("the backend started and reported healthy against a database file that is 32 KiB of random bytes (%s).\n"+
			"  A server that starts here is a server that has decided the user's data does not exist, "+
			"which is the silent data loss this suite's bar forbids.", dbPath)
	}
	t.Logf("corrupt-database startup failed as it should: %v", corruptErr)

	stderr := serverStderr(t, h)
	if !strings.Contains(stderr, "not a database") {
		t.Errorf("the server refused to start against a corrupt database but never said why.\n"+
			"  want its stderr to mention \"not a database\"; got:\n%s", truncateForLog(stderr))
	}

	// Containment: the corrupt file is the whole of the damage.
	if removeErr := os.Remove(dbPath); removeErr != nil {
		t.Fatalf("removing the corrupt database: %v", removeErr)
	}
	if _, statErr := os.Stat(dbDir); statErr != nil {
		t.Fatalf("the database directory did not survive the corrupt file: %v", statErr)
	}
	recovered, recoverErr := startBackendForFault(t, h, "a backend after the corrupt file was removed")
	if recoverErr != nil {
		t.Fatalf("the backend could not rebuild after the corrupt database was removed: %v\n"+
			"  the damage was not contained to the one file", recoverErr)
	}
	t.Cleanup(func() { stopBackendCleanly(t, recovered, "started after the corrupt file was removed") })
	assertBackendHealthy(t, h, apiClientFor(h, recovered), "removing a corrupt database file")
}

// TestResilience_DatabaseFaultsNotCoveredHere records, in the run summary
// rather than only in a comment, the two rows of the phase document's
// Database class this environment cannot honestly exercise.
//
// A skip with a recorded reason is the harness's designed way to say "this
// did not run, and here is why" -- see harness.Skip's own doc comment on
// why a bare t.Skip is not acceptable. Deleting the case instead would let
// the phase look complete while two of its four database faults were never
// considered.
func TestResilience_DatabaseFaultsNotCoveredHere(t *testing.T) {
	h := harness.New(t, harness.NoBackend())
	h.Skip("NOT MET, two rows of the phase document's Database class: " +
		"(1) a full disk on write needs a size-capped filesystem, which needs mount privileges this " +
		"unprivileged runner does not have -- closing it needs a harness fixture that mounts a small " +
		"filesystem in a privileged CI step and exports its path; " +
		"(2) a postgres connection dropped mid-transaction needs a postgres instance, and there is none " +
		"here -- harness/backend/db.go already provisions one schema per test on the postgres driver, so " +
		"what is missing is the postgres fixture (a container the run brings up and a DSN it configures), " +
		"which does not exist yet. The locked-file and corrupt-file rows are proven by the two tests above.")
}
