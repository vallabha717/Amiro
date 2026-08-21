package security_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/fakeprovider"
)

// TestSecurity_WorkspaceEscapeIsRefusedThroughTheDashboard is the phase
// document's "Workspace escape via every path shape (re-asserted here at
// the cross-surface level, including through the dashboard)".
//
// The vector list is taken from
// suites/backend/chat/workspace_escape_test.go's
// TestWorkspaceEscape_RefusesAllEscapeVectors, which already covers these
// seven shapes at the plain backend-API level. It is duplicated rather
// than called into because suites/meta's TestSuitesDoNotImportEachOther
// forbids one suite importing another, and the list is the credited
// original's.
//
// What is NEW here is the client. The existing test drives
// harness/apiclient.Client, which puts X-Amiro-Token on every request and
// is therefore admitted by middleware.RequireToken. This one drives an
// embedui backend through middleware.RequireTokenOrBrowser's BROWSER
// branch, with no shared secret at all -- the guard the served dashboard
// is actually behind. That is a genuinely different admission path into
// the same handlers, and "the file tools still cannot escape when the
// caller got in that way" is a claim the existing test does not make.
//
// assertBrowserGuardIsTheOneInPlay runs first, so a build that quietly
// fell back to RequireToken fails loudly instead of turning this into a
// second copy of a test that already exists.
func TestSecurity_WorkspaceEscapeIsRefusedThroughTheDashboard(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"), harness.BuildTags("embedui"))
	be := h.Backend()
	user := h.Identity("user")

	assertBrowserGuardIsTheOneInPlay(t, t.Context(), be.URL, user.Token)
	dash := newDashboardClient(be.URL, user.Token)

	wsRoot := be.WorkspaceRoot

	// A file outside the workspace that must never be readable, and a
	// symlink inside the workspace pointing at its directory.
	outsideDir := t.TempDir()
	outsideSecret := filepath.Join(outsideDir, "secret_outside.txt")
	if err := os.WriteFile(outsideSecret, []byte("SUPER_CONFIDENTIAL_OUTSIDE_DATA\n"), 0o644); err != nil {
		t.Fatalf("writing the external file: %v", err)
	}
	_ = os.Symlink(outsideDir, filepath.Join(wsRoot, "leak_symlink"))

	vectors := []struct {
		name string
		tool string
		args map[string]any
	}{
		{"relative_parent_traversal", "read_file", map[string]any{"path": "../../appdata/sidecar.lock.json"}},
		{"absolute_path_outside_root", "read_file", map[string]any{"path": outsideSecret}},
		{"symlink_pointing_outside", "read_file", map[string]any{"path": "leak_symlink/secret_outside.txt"}},
		{"encoded_dot_dot_traversal", "read_file", map[string]any{"path": "%2e%2e%2f%2e%2e%2fsecret.txt"}},
		{"null_byte_traversal", "read_file", map[string]any{"path": "valid.txt\x00/../../etc/passwd"}},
		{"write_escape_relative", "write_file", map[string]any{"path": "../escaped_write.txt", "content": "MALICIOUS"}},
		{"write_escape_absolute", "write_file", map[string]any{"path": filepath.Join(outsideDir, "escaped_write.txt"), "content": "MALICIOUS"}},
	}

	for _, tc := range vectors {
		t.Run(tc.name, func(t *testing.T) {
			h.Fake().OnPrompt(fakeprovider.Contains(tc.name)).
				ToolCall(tc.tool, tc.args).
				ThenStreamText("Processed tool outcome.")

			turn, err := dash.chatTurn(t.Context(), apiclient.ChatRequest{
				ID:             "thread-dash-escape-" + tc.name,
				Message:        apiclient.TextMessage("msg-dash-escape", "dashboard escape: "+tc.name),
				PermissionMode: "auto",
				WorkspaceRoot:  wsRoot,
			})
			if err != nil {
				t.Fatalf("chat turn through the dashboard: %v", err)
			}

			if len(turn.ToolCalls) == 0 {
				t.Fatalf("no tool call reached the backend, so nothing about workspace containment was tested")
			}

			refused := false
			for _, call := range turn.ToolCalls {
				if call.Error != "" {
					refused = true
					break
				}
				out := string(call.Output)
				if strings.Contains(out, "outside the workspace") ||
					strings.Contains(out, "resolves to") ||
					strings.Contains(out, "workspace:") ||
					strings.Contains(out, "is outside") {
					refused = true
					break
				}
			}
			if !refused {
				t.Fatalf("vector %s was NOT refused when the caller came in through the dashboard's "+
					"browser-auth guard. Tool calls: %+v", tc.name, turn.ToolCalls)
			}

			// The strongest form of the assertion, independent of any
			// message the tool happened to return: the escape did not
			// happen on disk.
			if _, err := os.Stat(filepath.Join(outsideDir, "escaped_write.txt")); err == nil {
				t.Fatalf("CRITICAL: %s created a file outside the workspace root", tc.name)
			}
			for _, call := range turn.ToolCalls {
				if strings.Contains(string(call.Output), "SUPER_CONFIDENTIAL_OUTSIDE_DATA") {
					t.Fatalf("CRITICAL: %s read the contents of a file outside the workspace root", tc.name)
				}
			}
		})
	}
}

// TestSkills_Authoring_TraversalAndSymlinkEscapeRejected verifies that Create, Update,
// and Delete via the authoring API strictly enforce containment within ~/.agents/skills/
// and never modify, create, or delete directories/files outside the writable root.
func TestSkills_Authoring_TraversalAndSymlinkEscapeRejected(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	be := h.Backend()
	user := h.As("user")

	outsideDir := t.TempDir()
	outsideSecret := filepath.Join(outsideDir, "external_skill")
	if err := os.MkdirAll(outsideSecret, 0o755); err != nil {
		t.Fatalf("mkdir outside: %v", err)
	}
	outsideSKILL := filepath.Join(outsideSecret, "SKILL.md")
	originalContent := []byte("---\nname: external-skill\ndescription: External secret\n---\n# Secret instructions\n")
	if err := os.WriteFile(outsideSKILL, originalContent, 0o644); err != nil {
		t.Fatalf("write outside SKILL.md: %v", err)
	}

	// 1. Create with traversal name is rejected with 400 and creates nothing outside
	_, err := user.CreateSkill(t.Context(), apiclient.SkillWriteRequest{
		Name:        "../escaped-skill",
		Description: "Should be rejected",
		Body:        "malicious body",
	})
	if err == nil {
		t.Fatal("expected CreateSkill with traversal name to fail, got nil")
	}
	if apiclient.StatusOf(err) != 400 {
		t.Errorf("traversal create status = %d, want 400", apiclient.StatusOf(err))
	}
	if _, statErr := os.Stat(filepath.Join(be.Home, "escaped-skill")); statErr == nil {
		t.Fatal("CRITICAL: CreateSkill with ../ name created directory outside writable root")
	}

	// 2. Plant a symlink inside ~/.agents/skills/ pointing to outside directory
	writableRoot := filepath.Join(be.Home, ".agents", "skills")
	if err := os.MkdirAll(writableRoot, 0o755); err != nil {
		t.Fatalf("mkdir writable root: %v", err)
	}
	symlinkPath := filepath.Join(writableRoot, "symlink-target")
	_ = os.Symlink(outsideSecret, symlinkPath)

	// Attempt Create with the colliding symlink name -> 409 Conflict, outside file untouched
	_, err = user.CreateSkill(t.Context(), apiclient.SkillWriteRequest{
		Name:        "symlink-target",
		Description: "Overwrite attempt",
		Body:        "overwritten content",
	})
	if err == nil {
		t.Fatal("expected CreateSkill with existing symlink name to fail 409, got nil")
	}
	if apiclient.StatusOf(err) != 409 {
		t.Errorf("symlink collision create status = %d, want 409", apiclient.StatusOf(err))
	}
	afterContent, _ := os.ReadFile(outsideSKILL)
	if string(afterContent) != string(originalContent) {
		t.Fatal("CRITICAL: CreateSkill modified content of external symlinked target")
	}

	// 3. Update on a read-only skill outside ~/.agents/skills/ is refused (409) and file unchanged
	claudeDir := filepath.Join(be.Home, ".claude", "skills", "ro-skill")
	if err := os.MkdirAll(claudeDir, 0o755); err != nil {
		t.Fatalf("mkdir claude dir: %v", err)
	}
	roSKILL := filepath.Join(claudeDir, "SKILL.md")
	roContent := []byte("---\nname: ro-skill\ndescription: Read-only skill\n---\n# Original\n")
	if err := os.WriteFile(roSKILL, roContent, 0o644); err != nil {
		t.Fatalf("write ro SKILL.md: %v", err)
	}

	_, err = user.UpdateSkill(t.Context(), "ro-skill", apiclient.SkillWriteRequest{
		Name:        "ro-skill",
		Description: "Malicious update",
		Body:        "modified body",
	})
	if err == nil {
		t.Fatal("expected UpdateSkill on non-writable skill to fail, got nil")
	}
	if apiclient.StatusOf(err) != 409 {
		t.Errorf("update read-only skill status = %d, want 409", apiclient.StatusOf(err))
	}
	roAfter, _ := os.ReadFile(roSKILL)
	if string(roAfter) != string(roContent) {
		t.Fatal("CRITICAL: UpdateSkill modified read-only skill outside writable root")
	}

	// 4. Delete on a read-only skill outside ~/.agents/skills/ is refused (409) and directory preserved
	err = user.DeleteSkill(t.Context(), "ro-skill", true)
	if err == nil {
		t.Fatal("expected DeleteSkill on read-only skill to fail, got nil")
	}
	if apiclient.StatusOf(err) != 409 {
		t.Errorf("delete read-only skill status = %d, want 409", apiclient.StatusOf(err))
	}
	if _, statErr := os.Stat(claudeDir); statErr != nil {
		t.Fatal("CRITICAL: DeleteSkill removed read-only directory outside writable root")
	}
}
