package resilience_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/fakeprovider"
)

// Filesystem faults. The phase document's row is:
//
//	A read-only workspace; a file deleted between read and write; a
//	permission error; a symlink loop
//
// All four are driven through the real agent loop -- the fake provider
// emits a tool call, the backend's file tools execute it against a real
// directory that has been broken on purpose -- rather than by calling a
// file API directly, because the failure mode being guarded against is what
// the MODEL is told. A tool that fails silently and returns an empty string
// hands the model "the file is empty" instead of "the file is unreadable",
// and the model then confidently rewrites it from nothing.
//
// Every case therefore asserts on the tool's own outcome as it appears in
// the stream, not merely on the turn completing.

// toolTurnResult is what a fault-injected tool call produced.
type toolTurnResult struct {
	Turn  apiclient.Turn
	Calls []apiclient.ToolCall
	Err   error
}

func (r toolTurnResult) String() string {
	var b strings.Builder
	b.WriteString("turnErr=")
	if r.Err == nil {
		b.WriteString("<nil>")
	} else {
		b.WriteString(r.Err.Error())
	}
	for _, c := range r.Calls {
		b.WriteString(" | call " + c.Name + " output=" + truncateForLog(string(c.Output)) + " error=" + c.Error)
	}
	if len(r.Calls) == 0 {
		b.WriteString(" | no tool calls observed")
	}
	return b.String()
}

// failed reports whether any tool call in the turn reported an error.
func (r toolTurnResult) failed() bool {
	for _, c := range r.Calls {
		if c.Error != "" {
			return true
		}
	}
	return false
}

// runToolTurn scripts one tool call and runs a turn that makes it happen.
//
// The marker is minted here, with a unique counter FIRST, rather than taken
// from the caller. Rules accumulate on the fake and findMatchingRule
// returns the first whose Contains matcher accepts, so two hand-written
// markers where one is a prefix of the other -- "...-root" and
// "...-root-read" -- silently make the second turn re-run the first rule.
// That is not hypothetical: it is what the first run of this file did, and
// the symptom was a list_dir assertion failing with a write_file error.
func runToolTurn(t *testing.T, h *harness.Harness, c *apiclient.Client,
	threadID, msgID, label, toolName string, args any) toolTurnResult {
	t.Helper()
	marker := fmt.Sprintf("tp%d-%s", probeCounter.Add(1), label)
	h.Fake().OnPrompt(fakeprovider.Contains(marker)).
		ToolCall(toolName, args).
		ThenStreamText("finished " + marker)

	var res toolTurnResult
	runBounded(t, h, "a turn calling "+toolName+" ("+marker+")", 90*time.Second, func(ctx context.Context) {
		turn, err := c.ChatTurn(ctx, apiclient.ChatRequest{
			ID:             threadID,
			Message:        apiclient.TextMessage(msgID, marker+" please"),
			PermissionMode: "auto",
			WorkspaceRoot:  h.Backend().WorkspaceRoot,
		})
		res.Turn, res.Calls, res.Err = turn, turn.ToolCalls, err
	})
	t.Logf("%s -> %s", marker, res)
	return res
}

// TestResilience_ReadOnlyWorkspaceRejectsWritesCleanly makes a directory
// inside the workspace unwritable and asserts a write into it is refused
// with a reason, and that the refusal is the whole of the consequence.
func TestResilience_ReadOnlyWorkspaceRejectsWritesCleanly(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	ws := h.Backend().WorkspaceRoot

	locked := filepath.Join(ws, "readonly")
	if err := os.MkdirAll(locked, 0o755); err != nil {
		t.Fatalf("creating %s: %v", locked, err)
	}
	if err := os.Chmod(locked, 0o555); err != nil {
		t.Fatalf("making %s read-only: %v", locked, err)
	}
	// Restored before the harness tears down: a directory the run cannot
	// delete would leak into every later run's disk usage, and the failure
	// would surface as a confusing cleanup error in an unrelated test.
	t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })

	const threadID = "thread-resilience-readonly"
	res := runToolTurn(t, h, user, threadID, "msg-ro", "resilience-readonly-write", "write_file",
		map[string]any{"path": "readonly/should-not-exist.txt", "content": "this must not be written\n"})

	if !res.failed() {
		t.Errorf("writing into a read-only directory reported no tool error: %s", res)
	}
	if _, err := os.Stat(filepath.Join(locked, "should-not-exist.txt")); err == nil {
		t.Errorf("a write into a directory with mode 0555 created the file anyway")
	}

	assertBackendHealthy(t, h, user, "a write into a read-only workspace directory")
	assertRecoversOnSameThread(t, h, user, threadID)
}

// TestResilience_FileDeletedBetweenReadAndWriteFailsCleanly is the
// read-then-write race made deterministic.
//
// The agent reads a file in one turn and edits it in the next; between the
// two, the file is deleted out from under it. edit_file is anchored on the
// text it read, so this is precisely the state a lost race leaves: a plan
// built from content that no longer exists anywhere.
//
// The dangerous outcome is not the edit failing. It is the edit
// SUCCEEDING -- recreating the file from the anchor and quietly discarding
// whatever deleted it. That is a silent partial write in the most literal
// sense, so it gets its own assertion.
func TestResilience_FileDeletedBetweenReadAndWriteFailsCleanly(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	ws := h.Backend().WorkspaceRoot

	target := filepath.Join(ws, "raced.txt")
	const original = "line one\nline two\nline three\n"
	if err := os.WriteFile(target, []byte(original), 0o644); err != nil {
		t.Fatalf("creating %s: %v", target, err)
	}

	const threadID = "thread-resilience-deleted-file"
	read := runToolTurn(t, h, user, threadID, "msg-read", "resilience-race-read", "read_file",
		map[string]any{"path": "raced.txt"})
	if read.failed() {
		t.Fatalf("the initial read failed, so there is no race to lose: %s", read)
	}

	if err := os.Remove(target); err != nil {
		t.Fatalf("deleting %s between the read and the write: %v", target, err)
	}

	write := runToolTurn(t, h, user, threadID, "msg-edit", "resilience-race-edit", "edit_file",
		map[string]any{"path": "raced.txt", "old_string": "line two", "new_string": "line two, edited"})

	if !write.failed() {
		t.Errorf("editing a file that was deleted after it was read reported no tool error: %s", write)
	}
	if _, err := os.Stat(target); err == nil {
		body, _ := os.ReadFile(target)
		t.Errorf("editing a deleted file RECREATED it, discarding the deletion. "+
			"The file is back with content %q -- a silent partial write built out of stale reads.",
			truncateForLog(string(body)))
	}

	assertBackendHealthy(t, h, user, "an edit to a file deleted after it was read")
	assertRecoversOnSameThread(t, h, user, threadID)
}

// TestResilience_UnreadableFileFailsCleanly asserts a permission error
// reaches the model as an error and not as an empty file.
func TestResilience_UnreadableFileFailsCleanly(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	ws := h.Backend().WorkspaceRoot

	secret := filepath.Join(ws, "unreadable.txt")
	// Synthetic and obviously fake. Nothing resembling a credential goes
	// into a file this suite writes, precisely because a tool that leaked
	// the content would then have leaked it into the run's artifacts too.
	const contents = "NOT-A-SECRET-just-fixture-bytes\n"
	if err := os.WriteFile(secret, []byte(contents), 0o600); err != nil {
		t.Fatalf("creating %s: %v", secret, err)
	}
	if err := os.Chmod(secret, 0o000); err != nil {
		t.Fatalf("making %s unreadable: %v", secret, err)
	}
	t.Cleanup(func() { _ = os.Chmod(secret, 0o644) })

	if _, err := os.ReadFile(secret); err == nil {
		h.Skip("this process can read a mode-0000 file (running as root, or on a filesystem that " +
			"ignores permission bits), so there is no permission error to inject")
		return
	}

	const threadID = "thread-resilience-permission"
	res := runToolTurn(t, h, user, threadID, "msg-perm", "resilience-permission-read", "read_file",
		map[string]any{"path": "unreadable.txt"})

	if !res.failed() {
		t.Errorf("reading a mode-0000 file reported no tool error: %s\n"+
			"  a read that fails silently hands the model an empty file, and the model then "+
			"rewrites it from nothing", res)
	}
	for _, c := range res.Calls {
		if strings.Contains(string(c.Output), strings.TrimSpace(contents)) {
			t.Errorf("read_file returned the contents of a file the process cannot open")
		}
	}

	assertBackendHealthy(t, h, user, "a permission error on read")
	assertRecoversOnSameThread(t, h, user, threadID)
}

// TestResilience_SymlinkLoopTerminates walks a directory tree containing a
// cycle and asserts the walk ends.
//
// grep, not read_file: a loop only matters to something that RECURSES, and
// a naive walker meeting `loop/self -> loop` descends
// loop/self/self/self/... until it runs out of path or out of patience.
// Either outcome is a hang or a crash rather than an error, which is why
// this is the one case in this file whose primary assertion is simply that
// the turn came back at all -- runBounded's deadline IS the assertion, and
// its diagnostic says so.
func TestResilience_SymlinkLoopTerminates(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	ws := h.Backend().WorkspaceRoot

	loopDir := filepath.Join(ws, "loopdir")
	if err := os.MkdirAll(loopDir, 0o755); err != nil {
		t.Fatalf("creating %s: %v", loopDir, err)
	}
	if err := os.WriteFile(filepath.Join(loopDir, "bait.txt"), []byte("NEEDLE-IN-THE-LOOP\n"), 0o644); err != nil {
		t.Fatalf("seeding the loop directory: %v", err)
	}
	// The cycle. Also a mutual pair, because a walker that special-cases
	// "a link to its own parent" still follows a -> b -> a.
	if err := os.Symlink(loopDir, filepath.Join(loopDir, "self")); err != nil {
		h.Skip("cannot create symlinks here, so a symlink loop cannot be built: " + err.Error())
		return
	}
	pairA := filepath.Join(ws, "loop-a")
	pairB := filepath.Join(ws, "loop-b")
	if err := os.Symlink(pairB, pairA); err != nil {
		t.Fatalf("creating %s: %v", pairA, err)
	}
	if err := os.Symlink(pairA, pairB); err != nil {
		t.Fatalf("creating %s: %v", pairB, err)
	}

	const threadID = "thread-resilience-symlink-loop"
	res := runToolTurn(t, h, user, threadID, "msg-loop", "resilience-symlink-loop", "grep",
		map[string]any{"pattern": "NEEDLE-IN-THE-LOOP"})

	// Reaching here at all is the result: runBounded would have failed the
	// test with a hang diagnostic otherwise. What is left to check is that
	// the walk produced an answer rather than an unexplained blank.
	if len(res.Calls) == 0 {
		t.Fatalf("grep over a workspace containing symlink loops produced no tool call at all: %s", res)
	}
	for _, c := range res.Calls {
		if c.Error == "" && len(c.Output) == 0 {
			t.Errorf("grep over a workspace containing symlink loops returned neither output nor an error; "+
				"the walk ended but said nothing about what it found or why it stopped: %s", res)
		}
	}

	// list_dir straight into the cycle, on the same thread, for the shallow
	// case a recursive walker might handle differently from the deep one.
	listed := runToolTurn(t, h, user, threadID, "msg-loop-list", "resilience-symlink-loop-list", "list_dir",
		map[string]any{"path": "loopdir/self/self/self"})
	if len(listed.Calls) == 0 {
		t.Errorf("list_dir three levels into a symlink cycle produced no tool call: %s", listed)
	}

	assertBackendHealthy(t, h, user, "a symlink loop in the workspace")
	assertRecoversOnSameThread(t, h, user, threadID)
}

// TestResilience_ReadOnlyWorkspaceRootRefusesCleanly is the whole-workspace
// variant of the read-only case: not one directory inside the workspace but
// the workspace root itself.
//
// Worth separating because the two fail in different places -- one inside
// the tool, one potentially at workspace resolution -- and a backend that
// handles the first can still panic on the second.
func TestResilience_ReadOnlyWorkspaceRootRefusesCleanly(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	ws := h.Backend().WorkspaceRoot

	if err := os.Chmod(ws, 0o555); err != nil {
		t.Fatalf("making the workspace root read-only: %v", err)
	}
	restored := false
	restore := func() {
		if !restored {
			restored = true
			_ = os.Chmod(ws, 0o755)
		}
	}
	t.Cleanup(restore)

	const threadID = "thread-resilience-readonly-root"
	res := runToolTurn(t, h, user, threadID, "msg-ro-root", "resilience-readonly-root", "write_file",
		map[string]any{"path": "top-level-should-not-exist.txt", "content": "nope\n"})

	if !res.failed() {
		t.Errorf("writing into a read-only workspace root reported no tool error: %s", res)
	}
	if _, err := os.Stat(filepath.Join(ws, "top-level-should-not-exist.txt")); err == nil {
		t.Errorf("a write into a workspace root with mode 0555 created the file anyway")
	}

	// Reads must still work: the workspace is read-only, not unusable, and
	// a backend that degraded the whole file toolkit would be over-reacting.
	read := runToolTurn(t, h, user, threadID, "msg-ro-root-read", "resilience-readonly-root-read", "list_dir",
		map[string]any{"path": "."})
	if read.failed() {
		t.Errorf("listing a read-only workspace failed; read-only is not unreadable: %s", read)
	}

	restore()
	assertBackendHealthy(t, h, user, "a read-only workspace root")
	assertRecoversOnSameThread(t, h, user, threadID)
}
