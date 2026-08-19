// Package smoke_test holds the three tests that prove the harness
// foundation works. Nothing here asserts anything interesting about Amiro;
// everything here asserts that the machinery every later suite stands on is
// real.
//
// If these three pass, then: the backend builds and starts from source, the
// PORT= handoff is trustworthy, seeding through the real API works and
// produces the permission model the plan assumes, and a run leaves a
// complete artifact trail. Every Phase 2 test can then be about Amiro
// rather than about whether the harness is lying.
package smoke_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/backend"
	"amiro/tests/harness/logging"
	"amiro/tests/harness/run"
)

// TestBackend_BuildsStartsAndAnswersHealth is the first test in the suite,
// and deliberately the simplest thing that can fail.
//
// It covers the whole startup chain end to end: `go build ./cmd/server`
// from source, a spawned process with an isolated environment, the PORT=
// line parsed off stdout, and GET /health returning 200 behind the
// shared-secret header. A failure anywhere in that chain shows up here
// rather than as a confusing timeout in a test about threads.
func TestBackend_BuildsStartsAndAnswersHealth(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	be := h.Backend()

	if be.Port == 0 {
		t.Fatal("the backend reported port 0; the PORT= line was not parsed")
	}
	if be.URL == "" {
		t.Fatal("the backend has no URL")
	}
	if err := h.Client().Health(t.Context()); err != nil {
		t.Fatalf("GET /health: %v", err)
	}

	// The database, the workspace and the app-data directory must all be
	// inside the run tree. A backend writing anywhere else is a backend
	// that can reach the developer's real data -- the exact failure this
	// isolation exists to prevent, and one that is invisible unless
	// asserted.
	for name, path := range map[string]string{
		"app-data directory": be.AppDataDir,
		"workspace":          be.WorkspaceRoot,
		"HOME":               be.Home,
	} {
		if !isInside(path, h.RunDir()) {
			t.Errorf("the %s is outside the run directory:\n  %s\n  not under %s", name, path, h.RunDir())
		}
	}

	// The workspace is a COPY of the fixture, not the fixture itself.
	if _, err := os.Stat(filepath.Join(be.WorkspaceRoot, "src", "greeting.txt")); err != nil {
		t.Errorf("the workspace fixture was not copied: %v", err)
	}

	// The discovery lock is what `amiro` reads to attach to a running
	// backend instead of starting a second one against the same database.
	// It is also this suite's guard against harness/backend.Lock drifting
	// from internal/appwiring.Lock, which the module boundary forces us to
	// transcribe rather than import.
	lock, ok, err := backend.ReadLock(be.AppDataDir)
	if err != nil {
		t.Fatalf("reading the discovery lock: %v", err)
	}
	if !ok {
		t.Fatal("the server did not write sidecar.lock.json into its app-data directory")
	}
	if lock.Port != be.Port {
		t.Errorf("the discovery lock says port %d, the server printed %d", lock.Port, be.Port)
	}
	if lock.Token != be.Token {
		t.Error("the discovery lock's token does not match the one the harness generated")
	}
	if lock.PID != be.Process().Pid() {
		t.Errorf("the discovery lock says pid %d, the spawned process is %d", lock.PID, be.Process().Pid())
	}
}

// TestSeed_MakesTheFirstAccountAdminAndTheOthersPlainUsers pins the
// ordering rule every permission test downstream depends on.
//
// backend-go/internal/auth makes the FIRST registered account the admin.
// That is an implicit, order-dependent rule, and it is exactly the kind
// that produces baffling flakes when a suite shares a database. Asserting
// it here means a change to that rule breaks one obvious test instead of
// thirty subtle ones.
func TestSeed_MakesTheFirstAccountAdminAndTheOthersPlainUsers(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))

	admin := h.Identity("admin")
	user := h.Identity("user")
	other := h.Identity("other")

	if admin.Role != "admin" {
		t.Errorf("the first registered account has role %q, want \"admin\"", admin.Role)
	}
	for _, id := range []string{user.Role, other.Role} {
		if id == "admin" {
			t.Errorf("a later-registered account got role \"admin\"; the first-user rule is not holding")
		}
	}
	if user.UserID == other.UserID {
		t.Error("`user` and `other` are the same account; every isolation test would silently pass")
	}

	// The identities are usable, not merely recorded.
	me, err := h.As("user").Me(t.Context())
	if err != nil {
		t.Fatalf("GET /api/auth/session as user: %v", err)
	}
	if me.Email != user.Email {
		t.Errorf("signed in as %q, expected %q", me.Email, user.Email)
	}

	// And the admin route actually distinguishes them. This is the smallest
	// end-to-end proof that seeding produced a real permission model rather
	// than three interchangeable accounts.
	page, err := h.As("admin").ListUsers(t.Context())
	if err != nil {
		t.Errorf("the admin cannot list users: %v", err)
	} else if page.Total != 3 {
		t.Errorf("the admin sees %d users, expected the 3 that were seeded", page.Total)
	}
	if _, err := h.As("user").ListUsers(t.Context()); err == nil {
		t.Error("a non-admin listed users successfully; the admin guard is not working")
	} else if got := apiclient.StatusOf(err); got != 403 {
		// 403 and 404 mean different things: forbidden says the route
		// exists and refused, not-found says it never matched. A guard that
		// silently became a routing change would pass a looser assertion.
		t.Errorf("a non-admin got status %d listing users, expected 403", got)
	}
}

// TestRun_ProducesACompleteArtifactTree is the artifact contract.
//
// Everything about debugging a failure later depends on these files
// existing and being interpretable. Asserting on them is what stops the log
// tree quietly becoming empty six phases from now, when nobody is looking
// at it because nothing has failed yet.
func TestRun_ProducesACompleteArtifactTree(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	be := h.Backend()

	// Make sure there is at least one exchange to find in http.ndjson.
	if _, err := h.Client().AuthStatus(t.Context()); err != nil {
		t.Fatalf("GET /api/auth/status: %v", err)
	}

	runDir := h.RunDir()
	testDir := filepath.Join(runDir, "backend", h.TestID)

	for _, rel := range []string{
		run.ManifestName,
		logging.EventsFile,
		run.ResultsFile,
		filepath.Join("backend", h.TestID, "server.stdout.log"),
		filepath.Join("backend", h.TestID, "http.ndjson"),
	} {
		path := filepath.Join(runDir, rel)
		info, err := os.Stat(path)
		if err != nil {
			t.Errorf("missing artifact %s: %v", rel, err)
			continue
		}
		if info.Size() == 0 {
			t.Errorf("artifact %s exists but is empty", rel)
		}
	}

	// run.json is written BEFORE anything is spawned, so it must be
	// readable and must describe this run rather than a previous one.
	manifest, err := run.ReadManifest(runDir)
	if err != nil {
		t.Fatalf("reading run.json: %v", err)
	}
	if manifest.ID != h.Run.ID {
		t.Errorf("run.json says run %q, this run is %q", manifest.ID, h.Run.ID)
	}
	if manifest.Host.OS == "" {
		t.Error("run.json records no host information")
	}

	// The server's own stdout must contain the PORT= line the harness read.
	// This is the assertion that would catch the harness inventing a port
	// from somewhere else.
	stdout, err := os.ReadFile(filepath.Join(testDir, "server.stdout.log"))
	if err != nil {
		t.Fatalf("reading server.stdout.log: %v", err)
	}
	if !containsLine(string(stdout), "PORT=") {
		t.Errorf("server.stdout.log has no PORT= line; the harness read the port from somewhere else\n%s", stdout)
	}

	// http.ndjson must be one JSON object per line, decodable.
	raw, err := os.ReadFile(filepath.Join(testDir, "http.ndjson"))
	if err != nil {
		t.Fatalf("reading http.ndjson: %v", err)
	}
	lines := splitLines(string(raw))
	if len(lines) == 0 {
		t.Fatal("http.ndjson is empty; no exchange was recorded")
	}
	for i, line := range lines {
		var exchange map[string]any
		if err := json.Unmarshal([]byte(line), &exchange); err != nil {
			t.Fatalf("http.ndjson line %d is not JSON: %v\n%s", i+1, err, line)
		}
		if exchange["path"] == nil || exchange["method"] == nil {
			t.Errorf("http.ndjson line %d records no method or path: %s", i+1, line)
		}
	}

	// The auth token must not appear IN THE LOGS in the clear. The full
	// sweep lives in suites/meta; this is the cheap version that runs on
	// every smoke run.
	//
	// Captured application state is excluded, and the reason matters:
	// appdata/ holds sidecar.lock.json, which the SERVER writes at 0600 and
	// which is SUPPOSED to contain the token -- that is how `amiro`
	// discovers a running backend. Redacting it would break the thing being
	// tested. The rule is that nothing the HARNESS writes may leak, not
	// that the application may not hold its own secrets in its own state
	// directory.
	if leaked := grepLogs(t, runDir, be.Token); leaked != "" {
		t.Errorf("the backend auth token appears in the clear in %s", leaked)
	}
}

func isInside(path, root string) bool {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}
	return rel != ".." && !filepathHasDotDotPrefix(rel)
}

func filepathHasDotDotPrefix(rel string) bool {
	return len(rel) >= 2 && rel[0] == '.' && rel[1] == '.'
}

func containsLine(s, prefix string) bool {
	for _, line := range splitLines(s) {
		if len(line) >= len(prefix) && line[:len(prefix)] == prefix {
			return true
		}
	}
	return false
}

func splitLines(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			if line := trimCR(s[start:i]); line != "" {
				out = append(out, line)
			}
			start = i + 1
		}
	}
	if line := trimCR(s[start:]); line != "" {
		out = append(out, line)
	}
	return out
}

func trimCR(s string) string {
	if len(s) > 0 && s[len(s)-1] == '\r' {
		return s[:len(s)-1]
	}
	return s
}

// stateDirs are per-test directories holding the APPLICATION's own files
// rather than the harness's records of them. They are preserved for
// debugging and are excluded from secret sweeps -- see the comment at the
// call site.
var stateDirs = map[string]bool{"appdata": true, "workspace": true, "db": true, "home": true}

// grepLogs returns the first log file containing needle, or "".
func grepLogs(t *testing.T, root, needle string) string {
	t.Helper()
	if needle == "" {
		return ""
	}
	var found string
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || found != "" {
			return nil
		}
		if d.IsDir() {
			if stateDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		if contains(string(data), needle) {
			found = path
		}
		return nil
	})
	return found
}

func contains(haystack, needle string) bool {
	return len(needle) > 0 && len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
