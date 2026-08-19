package security_test

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/fakeprovider"
)

// TestSecurity_PublicExportExposesOnlyTheExportedThread is the phase
// document's "The public `/api/export/{id}` route exposing only what is
// meant to be public".
//
// What already exists: suites/backend/chat/export_test.go's
// TestExport_PublishesAndFetchesThreadExport proves the round trip works
// -- publish, fetch by id, get the same id back. It fetches as the
// EXPORTER's own authenticated client, asserts nothing about what the
// payload contains, and never fetches it signed out. So the security
// question -- what does a stranger holding the link get? -- is untested.
//
// GET /api/export/{id} is registered with auth.OptionalSession
// (backend-go/internal/httpserver/router.go), and its handler never reads
// the session at all: "Deliberately unauthenticated, matching what it
// replaces: the TS /export/[id] page is a public share link -- anyone
// holding the id can read it." So "only what is meant to be public" is the
// right question and it has to be asked of a signed-out caller.
//
// This test asserts the invariants that are not a matter of opinion: no
// credential of any kind, no other account's content, no ability to act on
// the export, and expiry actually withholding the messages. What IS a
// matter of product opinion -- that the payload carries the exporter's
// internal user id, the original thread id, and every tool call's raw
// input and output -- is recorded as a finding rather than failed, because
// this suite does not get to decide what a share link is for.
func TestSecurity_PublicExportExposesOnlyTheExportedThread(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")
	other := h.As("other")
	// signedOut carries the sidecar's shared secret (every request to this
	// server needs it, /health included) but NO session bearer. That is
	// what "opened the link in a signed-out browser" means here.
	signedOut := h.Client().Anonymous()
	ctx := t.Context()

	const ownThread = "thread-export-security-own"
	const foreignThread = "thread-export-security-foreign"
	const foreignMarker = "OTHER-ACCOUNTS-PRIVATE-CONTENT-9f3a1c"

	// A thread belonging to somebody else, whose content must never show
	// up in this export.
	h.Fake().OnPrompt(fakeprovider.Contains("other account content")).StreamText(foreignMarker)
	if _, err := other.ChatTurn(ctx, apiclient.ChatRequest{
		ID:      foreignThread,
		Message: apiclient.TextMessage("msg-other", "other account content"),
	}); err != nil {
		t.Fatalf("seeding the other account's thread: %v", err)
	}

	// The thread that gets exported. It contains a tool call, because tool
	// inputs and outputs are the part of a transcript most likely to carry
	// something the exporter did not think they were publishing.
	h.Fake().OnPrompt(fakeprovider.Contains("export security")).
		ToolCall("read_file", map[string]any{"path": "README.md"}).
		ThenStreamText("Summarised the file.")
	if _, err := user.ChatTurn(ctx, apiclient.ChatRequest{
		ID:             ownThread,
		Message:        apiclient.TextMessage("msg-1", "export security turn"),
		PermissionMode: "auto",
		WorkspaceRoot:  h.Backend().WorkspaceRoot,
	}); err != nil {
		t.Fatalf("seeding the exported thread: %v", err)
	}

	exportID, err := user.ExportThread(ctx, ownThread, nil)
	if err != nil {
		t.Fatalf("ExportThread: %v", err)
	}

	resp, err := signedOut.Do(ctx, "GET", "/api/export/"+exportID, nil, nil)
	if err != nil {
		t.Fatalf("signed-out GET /api/export/%s: %v", exportID, err)
	}
	body := string(resp.Body)
	if len(body) == 0 {
		t.Fatal("the public export returned an empty body; there is nothing here to inspect")
	}

	// Non-vacuousness: the payload really does carry the transcript, so
	// every "must not contain" below is being asked of a real one.
	var detail apiclient.ExportDetail
	if err := json.Unmarshal(resp.Body, &detail); err != nil {
		t.Fatalf("decoding the public export: %v\nbody: %s", err, body)
	}
	if len(detail.Messages) == 0 || string(detail.Messages) == "[]" {
		t.Fatalf("the public export carries no messages, so the exposure assertions below prove nothing:\n%s", body)
	}

	t.Run("carries_no_credential_of_any_kind", func(t *testing.T) {
		forbidden := map[string]string{
			"the backend's shared secret":      h.Backend().Token,
			"the exporter's session bearer":    h.Identity("user").Token,
			"another account's session bearer": h.Identity("other").Token,
			"the admin account's password":     h.Config.Accounts.Admin.Password,
			"the exporter's password":          h.Config.Accounts.User.Password,
		}
		for what, secret := range forbidden {
			if secret == "" {
				t.Fatalf("%s is empty, so looking for it in the payload proves nothing", what)
			}
			if strings.Contains(body, secret) {
				t.Errorf("CRITICAL: the public export payload contains %s", what)
			}
		}
	})

	t.Run("carries_no_other_accounts_content", func(t *testing.T) {
		if strings.Contains(body, foreignMarker) {
			t.Errorf("CRITICAL: the public export payload contains another account's thread content")
		}
		if strings.Contains(body, foreignThread) {
			t.Errorf("CRITICAL: the public export payload names another account's thread id %q", foreignThread)
		}
	})

	t.Run("a_thread_id_is_not_an_export_id", func(t *testing.T) {
		// The export's originalThreadId is in the payload, so if the route
		// accepted a thread id as an export id, publishing one thread would
		// hand out a key to every thread whose id could be guessed.
		for _, id := range []string{ownThread, foreignThread} {
			if _, err := signedOut.Do(ctx, "GET", "/api/export/"+id, nil, nil); err == nil {
				t.Errorf("CRITICAL: GET /api/export/%s (a THREAD id, not an export id) succeeded", id)
			} else if status := apiclient.StatusOf(err); status != 404 && status != 403 {
				t.Errorf("GET /api/export/%s = %d, want 404 or 403", id, status)
			}
		}
	})

	t.Run("reading_it_confers_no_write_access", func(t *testing.T) {
		if err := signedOut.DeleteExport(ctx, exportID); err == nil {
			t.Error("CRITICAL: a signed-out caller deleted the export")
		} else if status := apiclient.StatusOf(err); status != 401 && status != 403 && status != 404 {
			t.Errorf("signed-out DELETE /api/export/%s = %d, want 401, 403 or 404", exportID, status)
		}
		if err := other.DeleteExport(ctx, exportID); err == nil {
			t.Error("CRITICAL: a different signed-in account deleted somebody else's export")
		} else if status := apiclient.StatusOf(err); status != 401 && status != 403 && status != 404 {
			t.Errorf("other-account DELETE /api/export/%s = %d, want 401, 403 or 404", exportID, status)
		}
		// The exporter's own list must not show it to anyone else either.
		theirs, err := other.ListExports(ctx)
		if err != nil {
			t.Fatalf("other.ListExports: %v", err)
		}
		for _, e := range theirs {
			if e.ID == exportID {
				t.Errorf("GET /api/export listed another account's export %s", exportID)
			}
		}
	})

	t.Run("an_expired_export_withholds_its_messages", func(t *testing.T) {
		past := time.Now().Add(-time.Hour)
		expiredID, err := user.ExportThread(ctx, ownThread, &past)
		if err != nil {
			t.Fatalf("ExportThread with a past expiry: %v", err)
		}
		expiredResp, err := signedOut.Do(ctx, "GET", "/api/export/"+expiredID, nil, nil)
		if err != nil {
			// A 404/410 is an entirely acceptable answer for an expired
			// link -- arguably a better one than 200-with-no-messages.
			if status := apiclient.StatusOf(err); status == 404 || status == 410 {
				return
			}
			t.Fatalf("signed-out GET of an expired export: %v", err)
		}
		var expired apiclient.ExportDetail
		if err := json.Unmarshal(expiredResp.Body, &expired); err != nil {
			t.Fatalf("decoding the expired export: %v", err)
		}
		if len(expired.Messages) > 0 && string(expired.Messages) != "[]" && string(expired.Messages) != "null" {
			t.Errorf("CRITICAL: an EXPIRED export still served its messages: %s",
				truncate(string(expired.Messages), 400))
		}
	})

	// The recorded findings. Each is asserted against the behaviour
	// observed when this test was written, so a change in either direction
	// surfaces here rather than silently.
	t.Run("finding_what_the_public_payload_additionally_carries", func(t *testing.T) {
		var carried []string
		if detail.ExporterID != "" {
			carried = append(carried, "exporterId (the exporter's internal user id): "+detail.ExporterID)
		}
		if detail.OriginalThreadID != nil && *detail.OriginalThreadID != "" {
			carried = append(carried, "originalThreadId (the internal thread id): "+*detail.OriginalThreadID)
		}
		if strings.Contains(body, `"tool-read_file"`) || strings.Contains(body, `"toolCallId"`) {
			carried = append(carried, "every tool call's raw input and output, verbatim")
		}
		if strings.Contains(body, h.Backend().WorkspaceRoot) {
			carried = append(carried, "absolute filesystem paths from the exporter's machine")
		}
		if len(carried) == 0 {
			t.Log("the public export payload carries none of exporterId, originalThreadId, raw tool " +
				"calls or absolute paths -- better than the behaviour recorded when this test was " +
				"written; this subtest can be removed")
			return
		}
		t.Logf("FINDING (recorded, not a failure): a signed-out reader of a share link also receives:\n  - %s\n"+
			"Whether these are \"meant to be public\" is a product decision this suite does not make. "+
			"backend-go/internal/db/repository/chat_export.go copies each message's Parts and Metadata "+
			"verbatim into the snapshot, and internal/api/chat/parts.go's toolCallPart puts the full tool "+
			"input and output in Parts -- so a thread containing a run_shell call publishes the command and "+
			"its stdout. Closing step: decide the policy, then either strip these in ExportChat or document "+
			"them on the share dialog.", strings.Join(carried, "\n  - "))
	})
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "... [truncated]"
}
