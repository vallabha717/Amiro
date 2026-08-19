package perf_test

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/config"
	"amiro/tests/harness/fakeprovider"
)

// TestPerf_FirstStreamedTokenAfterSubmit is "First streamed token after
// submit (replay) | < 500ms".
//
// WHAT THIS DOES NOT MEASURE, stated plainly: a real provider's
// time-to-first-token. The provider here is harness/fakeprovider behind
// the cassette proxy -- an in-process httptest.Server on loopback that
// writes its first SSE chunk with no model to run and no network to
// cross. Its own contribution to this number is effectively zero.
//
// What it does measure is everything Amiro adds between a client pressing
// enter and the first text-delta reaching that client: request decode,
// session lookup, thread creation, system-prompt and tool-schema
// assembly, the provider round trip, and the UI-message-stream framing on
// the way back. That is exactly the "regression alarm" the phase document
// asks for -- if this doubles, Amiro got slower, because nothing else in
// the path can have. It is not a claim about what a user sees against
// Anthropic.
func TestPerf_FirstStreamedTokenAfterSubmit(t *testing.T) {
	h := harness.New(t, harness.Tags("slow"))
	user := h.As("user")

	h.Fake().OnPrompt(fakeprovider.Contains("first token budget")).
		StreamText("Streaming a reply for the first-token budget, in several chunks.",
			fakeprovider.PerChunk(8))

	// One turn first, so the number is steady state rather than
	// first-request costs: lazily built provider clients, prepared
	// statements, and the sqlite page cache all warm here.
	warmReq := apiclient.ChatRequest{
		ID:      "thread-perf-first-token-warm",
		Message: apiclient.TextMessage("msg-warm", "first token budget warm-up"),
	}
	if _, err := user.ChatTurn(t.Context(), warmReq); err != nil {
		t.Fatalf("warm-up ChatTurn: %v", err)
	}

	req := apiclient.ChatRequest{
		ID:      "thread-perf-first-token",
		Message: apiclient.TextMessage("msg-1", "first token budget measured turn"),
	}

	began := time.Now()
	stream, err := user.Chat(t.Context(), req)
	if err != nil {
		t.Fatalf("POST /api/chat: %v", err)
	}
	defer stream.Close()

	var firstToken time.Duration
	var delta string
	for stream.Next() {
		f := stream.Frame()
		if f.Type == apiclient.FrameTextDelta && f.Delta != "" {
			firstToken = time.Since(began)
			delta = f.Delta
			break
		}
	}
	if err := stream.Err(); err != nil {
		t.Fatalf("reading the stream: %v", err)
	}
	if delta == "" {
		t.Fatal("no text-delta frame ever arrived, so no first token was timed; this test proved nothing")
	}

	recordDuration(h, budgetFirstToken, firstToken, limitFirstToken,
		"clock starts before POST /api/chat and stops on the first non-empty text-delta frame. "+
			"The provider is fakeprovider on loopback, so this is Amiro's own overhead, not a real model's TTFT.")
}

// TestPerf_ThreadListWith500Threads is "Thread list with 500 threads |
// < 300ms".
//
// SETUP COST, stated honestly: there is no bulk-seed path for threads and
// no route that creates one. backend-go/internal/httpserver/router.go
// registers GET/DELETE /api/thread and GET/PUT/DELETE /api/thread/{id} --
// and no POST. internal/api/chat's runner creates the thread on first use
// of a thread id, so the ONLY way to have 500 threads is 500 chat turns.
// harness/seed has Agents(n) and Archives(n) but nothing for threads.
//
// So the setup here is 500 real turns through the real agent loop, run
// concurrently over a bounded pool because they are independent and
// sequential would be needlessly slow. This is why the test is slow-tagged
// beyond the phase document's reason -- the measurement is milliseconds,
// the setup is the expensive part, and it belongs nightly for that reason
// as well.
func TestPerf_ThreadListWith500Threads(t *testing.T) {
	const threadCount = 500
	const workers = 8

	h := harness.New(t, harness.Tags("slow"))
	user := h.As("user")

	h.Fake().OnAny().StreamText("ok", fakeprovider.PerChunk(64))

	seedBegan := time.Now()
	ids := make(chan int, threadCount)
	for i := range threadCount {
		ids <- i
	}
	close(ids)

	var mu sync.Mutex
	var failures []string
	var wg sync.WaitGroup
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range ids {
				req := apiclient.ChatRequest{
					ID:      fmt.Sprintf("thread-perf-list-%04d", i),
					Message: apiclient.TextMessage(fmt.Sprintf("msg-%04d", i), "seed turn"),
				}
				if _, err := user.ChatTurn(h.Ctx, req); err != nil {
					mu.Lock()
					if len(failures) < 5 {
						failures = append(failures, fmt.Sprintf("thread %d: %v", i, err))
					}
					mu.Unlock()
				}
			}
		}()
	}
	wg.Wait()
	if len(failures) > 0 {
		t.Fatalf("seeding threads failed (first %d):\n  %s", len(failures), strings.Join(failures, "\n  "))
	}
	t.Logf("seeded %d threads via real chat turns in %s (%d workers)", threadCount, time.Since(seedBegan), workers)

	// One warm list, so the measured one is not paying for a cold query
	// plan or a cold page cache.
	if _, err := user.ListThreads(t.Context()); err != nil {
		t.Fatalf("warm-up ListThreads: %v", err)
	}

	began := time.Now()
	threads, err := user.ListThreads(t.Context())
	elapsed := time.Since(began)
	if err != nil {
		t.Fatalf("ListThreads: %v", err)
	}

	// Without this the budget could be met by a route that returned an
	// empty list, which is the fastest possible wrong answer.
	if len(threads) < threadCount {
		t.Fatalf("GET /api/thread returned %d threads, want at least %d -- the number below "+
			"would be a budget for listing something else", len(threads), threadCount)
	}

	recordDuration(h, budgetThreadList, elapsed, limitThreadList,
		fmt.Sprintf("GET /api/thread returning %d threads, measured after one warm-up call", len(threads)))
}

// TestPerf_RepomapOverLargeWorkspace is "Repomap over
// fixtures/workspaces/large | < 5s".
//
// Measured the way an agent actually reaches repo_map: a real HTTP chat
// turn whose scripted provider response is a repo_map tool call, executed
// by the real tool against a workspace copied from
// fixtures/workspaces/large (600 Go files across 25 packages). The
// alternative -- calling amiro/backend/internal/agent/repomap directly --
// is forbidden by suites/meta's TestNoTestImportsTheApplicationModule, and
// would in any case measure a function rather than a feature.
//
// The consequence is that this number is COARSER than the repomap build
// alone: it carries the HTTP round trip, the turn setup, the tool
// dispatch and two provider round trips (the tool call, then the
// follow-up text). That is fine and expected against a 5s budget for
// something whose core work is tens of milliseconds -- the phase document
// asks for "coarse, generous... not a benchmark suite". If this number
// ever approaches 5s, something real broke.
//
// The workspace override is the load-bearing part. harness/backend.Start
// copies config.Resolve(BaseDir, cfg.Backend.WorkspaceRoot) into the run
// directory and points AMIRO_WORKSPACE_ROOT at the copy, so overriding the
// config key is what puts 600 files under the agent's tools. The leading
// underscore on the fixture's _pkg000/ ... _pkg024/ directories is
// deliberate and must not be renamed: it is what makes `go build ./...`
// and `go vet ./...` in this module skip them.
func TestPerf_RepomapOverLargeWorkspace(t *testing.T) {
	h := harness.New(t, harness.Tags("slow"), harness.With(func(c *config.Config) {
		c.Backend.WorkspaceRoot = "fixtures/workspaces/large"
	}))
	user := h.As("user")
	be := h.Backend()

	// Guard the override: a typo in the path would silently fall back to
	// fixtures/workspaces/basic (backend.ResolveWorkspaceFixture's default)
	// and this would become a budget for mapping a handful of files.
	if got := countGoFiles(t, be.WorkspaceRoot); got < 500 {
		t.Fatalf("the workspace under test holds %d .go files, want the ~600 of "+
			"fixtures/workspaces/large; the workspaceRoot override did not take effect", got)
	}

	h.Fake().OnPrompt(fakeprovider.Contains("map this repository")).
		ToolCall("repo_map", map[string]any{"path": "."}).
		ThenStreamText("Mapped the repository.")

	req := apiclient.ChatRequest{
		ID:             "thread-perf-repomap",
		Message:        apiclient.TextMessage("msg-1", "please map this repository"),
		PermissionMode: "auto",
		WorkspaceRoot:  be.WorkspaceRoot,
	}

	began := time.Now()
	turn, err := user.ChatTurn(t.Context(), req)
	elapsed := time.Since(began)
	if err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}

	// The tool has to have actually run and returned a map. A refused or
	// errored tool call returns fast, and a budget met that way is a lie.
	var mapped *apiclient.ToolCall
	for i := range turn.ToolCalls {
		if turn.ToolCalls[i].Name == "repo_map" {
			mapped = &turn.ToolCalls[i]
			break
		}
	}
	if mapped == nil {
		t.Fatalf("no repo_map tool call in the turn; nothing was mapped and this timed the wrong thing.\ntool calls: %+v\ntext: %q",
			turn.ToolCalls, turn.Text)
	}
	if mapped.Error != "" {
		t.Fatalf("repo_map failed: %s", mapped.Error)
	}
	out := string(mapped.Output)
	if len(out) < 500 {
		t.Fatalf("repo_map returned %d bytes, which is too little to be a map of 600 files: %s", len(out), out)
	}
	// The output names the fixture's packages, so this is a map of the
	// large workspace and not of an empty directory that happened to exist.
	if !strings.Contains(out, "_pkg0") {
		t.Fatalf("repo_map output does not mention any of the fixture's _pkgNNN packages, so it did not map "+
			"fixtures/workspaces/large:\n%s", truncateForLog(out))
	}

	t.Logf("repo_map output: %d bytes", len(out))
	recordDuration(h, budgetRepomap, elapsed, limitRepomap,
		"whole POST /api/chat turn: HTTP + turn setup + two fakeprovider round trips + the real repo_map "+
			"tool over a copy of fixtures/workspaces/large. Coarser than the repomap build alone, deliberately.")
}

func truncateForLog(s string) string {
	if len(s) <= 800 {
		return s
	}
	return s[:800] + "... [truncated]"
}
