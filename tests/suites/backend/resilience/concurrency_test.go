package resilience_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/fakeprovider"
)

// Concurrency. The phase document's row is:
//
//	20 simultaneous turns on one backend; the same thread from two clients;
//	parallel MCP calls
//
// The failure these guard against is not a crash but a MIX-UP: turn A's
// answer arriving on turn B's stream, two writers to one thread producing a
// row that is half of each, a JSON-RPC reply matched to the wrong request.
// Every assertion here is therefore about identity -- each caller gets
// back the thing it asked for, and nothing else -- rather than about
// throughput. A test that only counted successes would pass while every
// answer went to the wrong person.
//
// All three run under -race in the reported verification, which is the
// other half: a data race in the backend is not visible from the outside,
// but a race in the HARNESS would make these tests lie.

// TestResilience_TwentySimultaneousTurns runs twenty turns at once against
// one backend, each on its own thread, each expecting its own answer.
//
// The marker embedded in every prompt is echoed back by the fake in that
// turn's text, so a crossed stream is not a subtle statistical signal --
// turn 7 receiving turn 12's sentence fails turn 7 by name.
func TestResilience_TwentySimultaneousTurns(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	const turns = 20
	for i := 0; i < turns; i++ {
		marker := fmt.Sprintf("resilience-parallel-%02d", i)
		h.Fake().OnPrompt(fakeprovider.Contains(marker)).StreamText("answer for " + marker)
	}

	type result struct {
		index int
		text  string
		err   error
	}
	results := make([]result, turns)

	runBounded(t, h, "twenty simultaneous turns on one backend", 3*time.Minute, func(ctx context.Context) {
		var wg sync.WaitGroup
		wg.Add(turns)
		for i := 0; i < turns; i++ {
			go func(i int) {
				defer wg.Done()
				marker := fmt.Sprintf("resilience-parallel-%02d", i)
				turn, err := user.ChatTurn(ctx, apiclient.ChatRequest{
					ID:      fmt.Sprintf("thread-resilience-parallel-%02d", i),
					Message: apiclient.TextMessage(fmt.Sprintf("msg-parallel-%02d", i), marker+" please"),
				})
				results[i] = result{index: i, text: turn.Text, err: err}
			}(i)
		}
		wg.Wait()
	})

	failures := 0
	for i, r := range results {
		want := fmt.Sprintf("answer for resilience-parallel-%02d", i)
		switch {
		case r.err != nil:
			failures++
			t.Errorf("turn %02d of %d failed under concurrency: %v", i, turns, r.err)
		case !strings.Contains(r.text, want):
			failures++
			t.Errorf("turn %02d received %q, want it to contain %q -- an answer was delivered to the wrong stream",
				i, r.text, want)
		}
	}
	if failures == 0 {
		t.Logf("all %d simultaneous turns completed with their own answers", turns)
	}

	// Every thread must exist, separately, with its own turn in it. Twenty
	// concurrent writers merging into one thread, or losing one, would be
	// invisible to the stream assertions above.
	var threads []apiclient.Thread
	var err error
	runBounded(t, h, "listing threads after twenty simultaneous turns", 60*time.Second, func(ctx context.Context) {
		threads, err = user.ListThreads(ctx)
	})
	if err != nil {
		t.Fatalf("listing threads after twenty simultaneous turns: %v", err)
	}
	present := map[string]bool{}
	for _, th := range threads {
		present[th.ID] = true
	}
	for i := 0; i < turns; i++ {
		id := fmt.Sprintf("thread-resilience-parallel-%02d", i)
		if !present[id] {
			t.Errorf("thread %s is missing after twenty simultaneous turns; a concurrent create was lost", id)
		}
	}

	// The backend has to survive its own concurrency, and the harness's
	// teardown (backend.Stop -> AssertStopped + AssertPortFree) has to find
	// it clean afterwards. That teardown assertion is the one the phase
	// document's risk section names as what keeps chaos from degrading
	// later tests, and it runs automatically for this test because the
	// backend is harness-owned.
	assertBackendHealthy(t, h, user, "twenty simultaneous turns")
}

// TestResilience_SameThreadFromTwoClientsStaysConsistent has two
// independently authenticated clients for the SAME account post to the same
// thread at the same time.
//
// Two sessions rather than one shared client, because that is the real
// shape: the TUI and the dashboard each hold their own bearer, and nothing
// in the backend can assume the two requests came from one process.
func TestResilience_SameThreadFromTwoClientsStaysConsistent(t *testing.T) {
	h := harness.New(t)
	identity := h.Identity("user")

	clientA := signInAgain(t, h, identity.Email, identity.Password)
	clientB := signInAgain(t, h, identity.Email, identity.Password)

	const threadID = "thread-resilience-two-clients"
	h.Fake().OnPrompt(fakeprovider.Contains("resilience-client-a")).StreamText("answer for client A")
	h.Fake().OnPrompt(fakeprovider.Contains("resilience-client-b")).StreamText("answer for client B")

	var textA, textB string
	var errA, errB error
	runBounded(t, h, "two clients writing one thread at once", 2*time.Minute, func(ctx context.Context) {
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			turn, err := clientA.ChatTurn(ctx, apiclient.ChatRequest{
				ID:      threadID,
				Message: apiclient.TextMessage("msg-client-a", "resilience-client-a please"),
			})
			textA, errA = turn.Text, err
		}()
		go func() {
			defer wg.Done()
			turn, err := clientB.ChatTurn(ctx, apiclient.ChatRequest{
				ID:      threadID,
				Message: apiclient.TextMessage("msg-client-b", "resilience-client-b please"),
			})
			textB, errB = turn.Text, err
		}()
		wg.Wait()
	})
	t.Logf("client A: err=%v text=%q", errA, textA)
	t.Logf("client B: err=%v text=%q", errB, textB)

	// A losing writer is allowed -- one of the two may legitimately be
	// refused. What is not allowed is a client being told it succeeded and
	// then finding its turn absent, or the two answers being swapped.
	if errA == nil && textA != "" && !strings.Contains(textA, "client A") {
		t.Errorf("client A received client B's answer: %q", textA)
	}
	if errB == nil && textB != "" && !strings.Contains(textB, "client B") {
		t.Errorf("client B received client A's answer: %q", textB)
	}
	if errA != nil && errB != nil {
		t.Errorf("both clients failed writing the same thread concurrently: A=%v B=%v", errA, errB)
	}

	detail := readThread(t, h, clientA, threadID, "after two clients wrote it at once")
	seen := map[string]bool{}
	for _, m := range detail.Messages {
		if seen[m.ID] {
			t.Errorf("message id %q appears twice after two concurrent writers", m.ID)
		}
		seen[m.ID] = true
		if !json.Valid(m.Parts) {
			t.Errorf("message %s has an invalid parts blob after concurrent writes: %s",
				m.ID, truncateForLog(string(m.Parts)))
		}
	}
	// Whichever client was told it succeeded must find its message there.
	if errA == nil && !seen["msg-client-a"] {
		t.Errorf("client A's turn reported success but msg-client-a is not in the thread: %s",
			describeMessages(detail))
	}
	if errB == nil && !seen["msg-client-b"] {
		t.Errorf("client B's turn reported success but msg-client-b is not in the thread: %s",
			describeMessages(detail))
	}

	// Neither client is left showing stale state: both read the same thread
	// back and see the same thing.
	fromB := readThread(t, h, clientB, threadID, "read back by the second client")
	if len(fromB.Messages) != len(detail.Messages) {
		t.Errorf("the two clients disagree about the thread: A sees %d messages, B sees %d",
			len(detail.Messages), len(fromB.Messages))
	}

	assertBackendHealthy(t, h, clientA, "two clients writing one thread")
}

// TestResilience_ParallelMCPCallsDoNotCrossReplies fires many tool calls at
// one MCP server at once and asserts every reply lands on its own request.
//
// The echo tool is chosen precisely because its reply contains its
// argument: JSON-RPC correlates replies to requests by id, and a transport
// that got that wrong under concurrency would return well-formed, entirely
// wrong answers. Counting successes would not notice; comparing each
// answer to its own question does.
func TestResilience_ParallelMCPCallsDoNotCrossReplies(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	server := saveMCPServer(t, h, user, "resilience-mcp-parallel", mcpFixtureCommand(t, h))

	const calls = 16
	type mcpResult struct {
		raw json.RawMessage
		err error
	}
	results := make([]mcpResult, calls)

	runBounded(t, h, "sixteen parallel MCP tool calls", 3*time.Minute, func(ctx context.Context) {
		var wg sync.WaitGroup
		wg.Add(calls)
		for i := 0; i < calls; i++ {
			go func(i int) {
				defer wg.Done()
				raw, err := user.CallMCPTool(ctx, server.ID, "echo",
					map[string]any{"message": fmt.Sprintf("parallel-%02d", i)})
				results[i] = mcpResult{raw: raw, err: err}
			}(i)
		}
		wg.Wait()
	})

	crossed := 0
	for i, r := range results {
		want := fmt.Sprintf("echo: parallel-%02d", i)
		switch {
		case r.err != nil:
			t.Errorf("parallel MCP call %02d failed: %v", i, r.err)
		case !strings.Contains(string(r.raw), want):
			crossed++
			t.Errorf("parallel MCP call %02d got %s, want it to contain %q -- a JSON-RPC reply was "+
				"matched to the wrong request", i, truncateForLog(string(r.raw)), want)
		}
	}
	if crossed == 0 {
		t.Logf("all %d parallel MCP calls received their own reply", calls)
	}

	assertMCPStillWorks(t, h, user, server.ID, "after sixteen parallel calls")
	assertBackendHealthy(t, h, user, "parallel MCP calls")
}
