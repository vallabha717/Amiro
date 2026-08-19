package security_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/fakeprovider"
)

// TestSecurity_OwnershipHoldsWhileTheAgentLoopIsActive is the phase
// document's "Ownership boundaries on every resource (the Phase 2 matrix,
// re-run with a real agent loop active)".
//
// Phase 2's matrix (suites/backend/matrix/matrix_test.go's
// TestMatrix_OwnershipCrossCutting) covers the same resources against a
// QUIESCENT server: it makes REST calls only, and contains no chat turn,
// no fakeprovider and no agent loop anywhere. Re-running it unchanged here
// would prove nothing new, so this test changes the one variable the phase
// document names: a real turn is IN FLIGHT, mid-stream, on the very thread
// the other user is probing, for the whole duration of every probe.
//
// That is the interesting case because a turn is when the server is
// writing: creating the thread row, appending messages, updating
// lastMessageAt. An ownership check that is correct on a settled database
// and wrong during a write is exactly the bug this arrangement looks for,
// and it is invisible to a quiescent matrix.
//
// Holding the turn open without a sleep: the fakeprovider rule installs a
// custom handler that streams a first chunk, signals `streaming`, and then
// blocks on `release` until the test closes it. So the turn is provably
// mid-stream -- the client has received bytes and the server has not
// finished -- for exactly as long as the probes take, with no timing
// assumption anywhere.
func TestSecurity_OwnershipHoldsWhileTheAgentLoopIsActive(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")
	other := h.As("other")
	ctx := t.Context()

	// Resources owned by `user`, created before the loop starts, so the
	// probes below have something of every shape to reach for.
	agent, err := user.CreateAgent(ctx, apiclient.AgentInput{Name: "Loop Agent", Visibility: "private"})
	if err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}
	vis := "private"
	wf, err := user.SaveWorkflow(ctx, apiclient.WorkflowInput{Name: "Loop Workflow", Visibility: &vis})
	if err != nil {
		t.Fatalf("SaveWorkflow: %v", err)
	}
	desc := "loop archive"
	arch, err := user.CreateArchive(ctx, "Loop Archive", &desc)
	if err != nil {
		t.Fatalf("CreateArchive: %v", err)
	}
	details, err := user.UserDetails(ctx)
	if err != nil {
		t.Fatalf("UserDetails: %v", err)
	}

	const threadID = "thread-ownership-under-load"

	streaming := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once

	h.Fake().OnPrompt(fakeprovider.Contains("hold the agent loop open")).
		Handle(func(w http.ResponseWriter, _ *http.Request) bool {
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("Cache-Control", "no-cache")
			w.WriteHeader(http.StatusOK)
			flusher, _ := w.(http.Flusher)
			writeDelta := func(text string) {
				payload, _ := json.Marshal(map[string]any{
					"id": "chatcmpl-hold", "object": "chat.completion.chunk", "created": 1700000000,
					"model": "gpt-4.1",
					"choices": []map[string]any{
						{"index": 0, "delta": map[string]any{"content": text}},
					},
				})
				fmt.Fprintf(w, "data: %s\n\n", payload)
				if flusher != nil {
					flusher.Flush()
				}
			}
			writeDelta("holding ")
			// The turn is now provably in flight: bytes are on the wire and
			// the handler has not returned.
			once.Do(func() { close(streaming) })
			<-release
			writeDelta("released")
			fmt.Fprint(w, "data: [DONE]\n\n")
			if flusher != nil {
				flusher.Flush()
			}
			return true
		})

	type turnResult struct {
		turn apiclient.Turn
		err  error
	}
	done := make(chan turnResult, 1)
	go func() {
		turn, err := user.ChatTurn(h.Ctx, apiclient.ChatRequest{
			ID:      threadID,
			Message: apiclient.TextMessage("msg-1", "please hold the agent loop open"),
		})
		done <- turnResult{turn, err}
	}()

	select {
	case <-streaming:
	case res := <-done:
		t.Fatalf("the turn finished before it ever started streaming, so nothing was probed under load: %+v", res)
	case <-ctx.Done():
		t.Fatalf("context cancelled waiting for the turn to start streaming: %v", ctx.Err())
	}

	// Everything from here to close(release) happens while the agent loop
	// is mid-stream on `user`'s thread.
	probe := func(name string, fn func() error) {
		t.Helper()
		err := fn()
		if err == nil {
			t.Errorf("%s SUCCEEDED for the other user while the owner's agent loop was mid-turn", name)
			return
		}
		if status := apiclient.StatusOf(err); status != http.StatusUnauthorized &&
			status != http.StatusForbidden && status != http.StatusNotFound {
			t.Errorf("%s returned %d for the other user while the owner's agent loop was mid-turn; "+
				"want 401, 403 or 404 (error: %v)", name, status, err)
		}
	}

	// The thread being written to right now -- the sharpest case.
	probe("GET /api/thread/{id}", func() error { _, err := other.GetThread(ctx, threadID); return err })
	probe("PUT /api/thread/{id}", func() error { return other.RenameThread(ctx, threadID, "hijacked") })
	probe("DELETE /api/thread/{id}", func() error { return other.DeleteThread(ctx, threadID) })

	// The rest of the Phase 2 matrix's resource shapes, same assertion
	// style as TestMatrix_OwnershipCrossCutting, now under load.
	probe("GET /api/agent/{id}", func() error { _, err := other.GetAgent(ctx, agent.ID); return err })
	probe("PUT /api/agent/{id}", func() error {
		_, err := other.UpdateAgent(ctx, agent.ID, apiclient.AgentInput{Name: "Hijacked"})
		return err
	})
	probe("DELETE /api/agent/{id}", func() error { return other.DeleteAgent(ctx, agent.ID) })
	probe("GET /api/workflow/{id}", func() error { _, err := other.GetWorkflow(ctx, wf.ID); return err })
	probe("DELETE /api/workflow/{id}", func() error { return other.DeleteWorkflow(ctx, wf.ID) })
	probe("GET /api/archive/{id}", func() error { _, err := other.GetArchive(ctx, arch.ID); return err })
	probe("PUT /api/archive/{id}", func() error {
		_, err := other.UpdateArchive(ctx, arch.ID, map[string]any{"name": "Hijacked"})
		return err
	})
	probe("DELETE /api/archive/{id}", func() error { return other.DeleteArchive(ctx, arch.ID) })
	probe("GET /api/user/details/{id}", func() error { _, err := other.UserDetailsByID(ctx, details.ID); return err })

	// The listing routes must not leak the owner's thread either, and a
	// list is the easy place for a filter to be missing.
	otherThreads, err := other.ListThreads(ctx)
	if err != nil {
		t.Errorf("the other user's GET /api/thread failed while the owner was mid-turn: %v", err)
	}
	for _, th := range otherThreads {
		if th.ID == threadID {
			t.Errorf("GET /api/thread listed the OWNER's in-flight thread %s to the other user", threadID)
		}
	}

	close(release)

	res := <-done
	if res.err != nil {
		t.Fatalf("the held turn failed: %v", res.err)
	}
	if !res.turn.Finished {
		t.Errorf("the held turn did not finish cleanly; the probes above ran against a broken turn")
	}
	if res.turn.Text == "" {
		t.Errorf("the held turn produced no text, so it was not a real agent loop")
	}

	// And once the loop is done: still the other user's business, and
	// still the owner's thread, intact.
	probe("GET /api/thread/{id} (after the turn)", func() error { _, err := other.GetThread(ctx, threadID); return err })

	detail, err := user.GetThread(ctx, threadID)
	if err != nil {
		t.Fatalf("the owner cannot read their own thread after the turn: %v", err)
	}
	if len(detail.Messages) == 0 {
		t.Errorf("the owner's thread has no messages after a completed turn; the probes may have damaged it")
	}
}
