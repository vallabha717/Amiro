package resilience_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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

// Resource limits. The phase document's row is:
//
//	A very large file read; a 10k-line grep result; a thread with 500
//	messages; a 50MB upload
//
// These are the cases where the wrong outcome is not a crash but a LIE.
// Every one of them can plausibly be handled by returning less than was
// asked for, and doing that quietly is worse than refusing: a model handed
// the first 2000 lines of a 200,000-line file, with nothing saying so,
// answers questions about the file it was not shown.
//
// So each case here asserts the same shape. Either the whole thing came
// back, or the response SAYS it did not. A response that is short and
// claims to be complete fails.
//
// Nothing in this file contains anything resembling a credential. The
// fixtures are counted lines and a repeating byte pattern, both obviously
// synthetic, because these payloads are large enough that they end up in
// artifacts and logs where a real secret would then live forever.

// truncationFlag pulls the `truncated` field out of a file tool's JSON
// result. Present on read_file, grep and list_dir, and it is the whole
// contract this file leans on: it is how a tool says "there was more".
func truncationFlag(t *testing.T, raw json.RawMessage) (truncated bool, present bool) {
	t.Helper()
	var out struct {
		Truncated *bool `json:"truncated"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return false, false
	}
	if out.Truncated == nil {
		return false, false
	}
	return *out.Truncated, true
}

// TestResilience_VeryLargeFileReadIsCompleteOrSaysItIsNot reads a file far
// larger than any window a tool would default to.
func TestResilience_VeryLargeFileReadIsCompleteOrSaysItIsNot(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	ws := h.Backend().WorkspaceRoot

	const (
		lines       = 200_000
		firstMarker = "FIRST-LINE-OF-THE-BIG-FILE"
		lastMarker  = "LAST-LINE-OF-THE-BIG-FILE"
	)
	path := filepath.Join(ws, "very-large.txt")
	var body strings.Builder
	body.Grow(lines * 48)
	body.WriteString(firstMarker + "\n")
	for i := 1; i < lines-1; i++ {
		fmt.Fprintf(&body, "line %06d padding-padding-padding-padding\n", i)
	}
	body.WriteString(lastMarker + "\n")
	if err := os.WriteFile(path, []byte(body.String()), 0o644); err != nil {
		t.Fatalf("writing the large fixture file: %v", err)
	}
	info, _ := os.Stat(path)
	t.Logf("reading a %d-line, %.1f MiB file through read_file", lines, float64(info.Size())/(1<<20))

	const threadID = "thread-resilience-large-read"
	res := runToolTurn(t, h, user, threadID, "msg-large-read", "resilience-large-file-read", "read_file",
		map[string]any{"path": "very-large.txt"})

	if len(res.Calls) != 1 {
		t.Fatalf("expected exactly one read_file call, got %d: %s", len(res.Calls), res)
	}
	call := res.Calls[0]
	if call.Error != "" {
		// A refusal is fine. An unexplained one is not, and a tool that
		// errors must not also claim to have returned content.
		t.Logf("read_file refused the large file: %s", call.Error)
		if len(call.Output) > 0 {
			t.Errorf("read_file reported an error AND returned output: %s", truncateForLog(string(call.Output)))
		}
	} else {
		out := string(call.Output)
		truncated, present := truncationFlag(t, call.Output)
		if !present {
			t.Fatalf("read_file's result on a %d-line file carries no `truncated` field, so a caller "+
				"cannot tell a whole file from a prefix: %s", lines, truncateForLog(out))
		}
		hasFirst := strings.Contains(out, firstMarker)
		hasLast := strings.Contains(out, lastMarker)
		t.Logf("read_file returned %d bytes, truncated=%t, sawFirstLine=%t, sawLastLine=%t",
			len(out), truncated, hasFirst, hasLast)
		if !truncated && !hasLast {
			t.Errorf("read_file returned a prefix of a %d-line file and reported truncated=false; "+
				"a model given this believes it has seen the whole file", lines)
		}
		if !hasFirst {
			t.Errorf("read_file returned neither an error nor the first line of the file it was asked for")
		}
	}

	assertBackendHealthy(t, h, user, "a very large file read")
	assertRecoversOnSameThread(t, h, user, threadID)
}

// TestResilience_TenThousandLineGrepIsCompleteOrSaysItIsNot runs a search
// with ten thousand hits.
//
// Spread over many files rather than concentrated in one, because a limit
// applied per file and a limit applied per search fail differently, and the
// per-search one is the one that silently drops whole files.
func TestResilience_TenThousandLineGrepIsCompleteOrSaysItIsNot(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	ws := h.Backend().WorkspaceRoot

	const (
		files          = 20
		linesPerFile   = 500
		expectedHits   = files * linesPerFile // 10,000
		needle         = "GREPNEEDLE"
		hitsPerLineFmt = "%s %04d filler filler filler\n"
	)
	dir := filepath.Join(ws, "grepfield")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("creating %s: %v", dir, err)
	}
	for f := 0; f < files; f++ {
		var b strings.Builder
		for l := 0; l < linesPerFile; l++ {
			fmt.Fprintf(&b, hitsPerLineFmt, needle, l)
		}
		if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("hits%02d.txt", f)), []byte(b.String()), 0o644); err != nil {
			t.Fatalf("writing grep fixture: %v", err)
		}
	}

	const threadID = "thread-resilience-big-grep"
	res := runToolTurn(t, h, user, threadID, "msg-big-grep", "resilience-ten-thousand-grep", "grep",
		map[string]any{"pattern": needle, "path": "grepfield"})

	if len(res.Calls) != 1 {
		t.Fatalf("expected exactly one grep call, got %d: %s", len(res.Calls), res)
	}
	call := res.Calls[0]
	if call.Error != "" {
		t.Logf("grep refused a %d-hit search: %s", expectedHits, call.Error)
	} else {
		var out struct {
			Count     int  `json:"count"`
			FileCount int  `json:"file_count"`
			Truncated bool `json:"truncated"`
			Hits      []struct {
				Path string `json:"path"`
			} `json:"hits"`
		}
		if err := json.Unmarshal(call.Output, &out); err != nil {
			t.Fatalf("grep's result did not decode: %v\n%s", err, truncateForLog(string(call.Output)))
		}
		t.Logf("grep over %d hits returned count=%d file_count=%d hits=%d truncated=%t",
			expectedHits, out.Count, out.FileCount, len(out.Hits), out.Truncated)
		if !out.Truncated && out.Count != expectedHits {
			t.Errorf("grep reported %d hits with truncated=false, but the fixture contains exactly %d; "+
				"a search that drops results without saying so makes 'no other matches' a false answer",
				out.Count, expectedHits)
		}
		if out.Truncated && len(out.Hits) == 0 {
			t.Errorf("grep reported truncated=true and returned no hits at all")
		}
	}

	assertBackendHealthy(t, h, user, "a ten-thousand-hit grep")
	assertRecoversOnSameThread(t, h, user, threadID)
}

// TestResilience_ThreadWith500MessagesStaysUsable builds a thread with 500
// persisted messages, one turn at a time, and asserts it is still readable
// and still extendable at the end.
//
// Turn by turn rather than by writing rows, because the property under test
// is what the REAL path does at that size -- history assembly, the prompt
// the provider is handed, the thread detail response -- and a thread
// fabricated in the database exercises none of it.
func TestResilience_ThreadWith500MessagesStaysUsable(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	const (
		threadID = "thread-resilience-500-messages"
		turns    = 250 // one user + one assistant message each.
		want     = turns * 2
	)
	h.Fake().OnPrompt(fakeprovider.Contains("resilience-bulk-turn")).StreamText("ack")

	started := time.Now()
	runBounded(t, h, fmt.Sprintf("building a %d-message thread", want), 5*time.Minute, func(ctx context.Context) {
		for i := 0; i < turns; i++ {
			_, err := user.ChatTurn(ctx, apiclient.ChatRequest{
				ID:      threadID,
				Message: apiclient.TextMessage(fmt.Sprintf("bulk-%03d", i), fmt.Sprintf("resilience-bulk-turn %03d", i)),
			})
			if err != nil {
				t.Errorf("turn %d of %d failed while growing the thread: %v", i, turns, err)
				return
			}
		}
	})
	t.Logf("built %d turns in %s", turns, time.Since(started).Round(time.Millisecond))

	detail := readThread(t, h, user, threadID, fmt.Sprintf("after %d turns", turns))
	if len(detail.Messages) != want {
		t.Errorf("a thread built from %d turns holds %d messages, want %d; "+
			"messages were dropped or merged somewhere in the loop", turns, len(detail.Messages), want)
	}

	// Every message must be distinct and decodable. A thread that grew into
	// duplicate ids reads back the same length and is still corrupt.
	seen := map[string]bool{}
	for _, m := range detail.Messages {
		if seen[m.ID] {
			t.Errorf("message id %q appears more than once in the thread", m.ID)
		}
		seen[m.ID] = true
		if !json.Valid(m.Parts) {
			t.Errorf("message %s has a parts blob that is not valid JSON: %s", m.ID, truncateForLog(string(m.Parts)))
		}
	}

	// The thread list must still be able to include it.
	var threads []apiclient.Thread
	var err error
	runBounded(t, h, "listing threads with a 500-message thread present", 60*time.Second, func(ctx context.Context) {
		threads, err = user.ListThreads(ctx)
	})
	if err != nil {
		t.Fatalf("listing threads with a %d-message thread present: %v", want, err)
	}
	found := false
	for _, th := range threads {
		if th.ID == threadID {
			found = true
		}
	}
	if !found {
		t.Errorf("the %d-message thread is missing from GET /api/thread", want)
	}

	assertBackendHealthy(t, h, user, "building a 500-message thread")
	assertRecoversOnSameThread(t, h, user, threadID)
}

// TestResilience_FiftyMegabyteUploadSucceedsOrIsRefusedCleanly pushes 50 MiB
// through the multipart upload route.
//
// The content is a repeating, verifiable pattern and its digest is checked
// on the way back out where the storage backend allows it, because "the
// upload returned 200" and "the bytes are intact" are different claims and
// a size limit implemented as a truncating read satisfies only the first.
func TestResilience_FiftyMegabyteUploadSucceedsOrIsRefusedCleanly(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	const size = 50 << 20
	payload := make([]byte, size)
	for i := range payload {
		// Synthetic and obviously non-secret: a repeating byte ramp.
		payload[i] = byte(i % 251)
	}
	sum := sha256.Sum256(payload)
	wantDigest := hex.EncodeToString(sum[:])

	var result apiclient.UploadResult
	var err error
	runBounded(t, h, "a 50 MiB multipart upload", 4*time.Minute, func(ctx context.Context) {
		result, err = user.Upload(ctx, "resilience-50mib.bin", payload, "application/octet-stream")
	})

	if err != nil {
		status := apiclient.StatusOf(err)
		t.Logf("the 50 MiB upload was refused with HTTP %d: %v", status, err)
		if status >= 500 {
			t.Errorf("a 50 MiB upload was refused with HTTP %d. A size the server will not accept is a "+
				"client error with a limit in the message, not a server failure with none.", status)
		}
		if status == 0 {
			t.Errorf("the 50 MiB upload failed without ever producing an HTTP status: %v", err)
		}
		assertBackendHealthy(t, h, user, "a refused 50 MiB upload")
		return
	}

	t.Logf("50 MiB upload accepted: key=%s size=%d", result.Key, result.Metadata.Size)
	if result.Metadata.Size != size {
		t.Errorf("a 50 MiB upload was accepted but recorded as %d bytes; the server kept less than it was "+
			"sent and said nothing", result.Metadata.Size)
	}

	// Read it back where the route allows, and compare digests rather than
	// lengths: a stream that dropped a chunk in the middle and padded the
	// end has the right size and the wrong bytes.
	if result.URL != "" {
		var got []byte
		var readErr error
		runBounded(t, h, "reading the 50 MiB upload back", 4*time.Minute, func(ctx context.Context) {
			got, _, readErr = user.GetPresignedDownload(ctx, absoluteURL(h, result.URL))
		})
		switch {
		case readErr != nil:
			t.Logf("the stored object could not be read back through %s: %v", result.URL, readErr)
		case len(got) == 0:
			t.Logf("the stored object read back empty through %s; nothing to compare", result.URL)
		default:
			gotSum := sha256.Sum256(got)
			t.Logf("read the upload back: %d bytes, digest %s (sent %d bytes, digest %s)",
				len(got), hex.EncodeToString(gotSum[:])[:16], size, wantDigest[:16])
			if hex.EncodeToString(gotSum[:]) != wantDigest {
				t.Errorf("50 MiB round-tripped to different bytes: sent %d bytes with digest %s, "+
					"read back %d bytes with digest %s", size, wantDigest[:16], len(got), hex.EncodeToString(gotSum[:])[:16])
			}
		}
	}

	assertBackendHealthy(t, h, user, "a 50 MiB upload")
}

// absoluteURL turns a storage URL that may be site-relative into one an
// HTTP client can dial.
func absoluteURL(h *harness.Harness, raw string) string {
	if strings.HasPrefix(raw, "http://") || strings.HasPrefix(raw, "https://") {
		return raw
	}
	return strings.TrimSuffix(h.Backend().URL, "/") + "/" + strings.TrimPrefix(raw, "/")
}
