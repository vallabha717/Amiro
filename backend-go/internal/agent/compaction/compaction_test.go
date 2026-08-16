package compaction

import (
	"context"
	"errors"
	"strings"
	"testing"

	bifrostai "amiro/backend/internal/ai/bifrost"
)

func msg(role bifrostai.MessageRole, text string) bifrostai.Message {
	return bifrostai.Message{Role: role, Text: text}
}

// history builds n assistant/tool messages with a user message every k, so
// tests can assert what survives.
func history(n int, big bool) []bifrostai.Message {
	body := "x"
	if big {
		body = strings.Repeat("x", 5000)
	}
	out := make([]bifrostai.Message, 0, n)
	for i := 0; i < n; i++ {
		if i%10 == 0 {
			out = append(out, msg(bifrostai.RoleUser, "user instruction "+string(rune('A'+i/10))))
			continue
		}
		out = append(out, msg(bifrostai.RoleAssistant, body))
	}
	return out
}

func stubSummary(text string) Summarizer {
	return func(ctx context.Context, _ []bifrostai.Message) (string, error) { return text, nil }
}

func TestCompact_LeavesASmallHistoryAlone(t *testing.T) {
	in := history(20, false)
	res, err := Compact(context.Background(), in, DefaultPolicy(), stubSummary("should not be called"))
	if err != nil {
		t.Fatalf("Compact: %v", err)
	}
	if res.Compacted {
		t.Fatalf("compacted a history of %d estimated tokens under a %d budget",
			res.TokensBefore, DefaultPolicy().MaxTokens)
	}
	if len(res.Messages) != len(in) {
		t.Fatalf("messages = %d, want %d untouched", len(res.Messages), len(in))
	}
}

// The rule that matters most. User messages are the instructions the whole
// run is answering -- summarizing "use tabs, not spaces" into "the user gave
// formatting preferences" is how an agent forgets its own task.
func TestCompact_KeepsEveryUserMessageVerbatim(t *testing.T) {
	in := history(200, true)
	p := Policy{MaxTokens: 1000, KeepRecent: 5}

	res, err := Compact(context.Background(), in, p, stubSummary("a summary"))
	if err != nil {
		t.Fatalf("Compact: %v", err)
	}
	if !res.Compacted {
		t.Fatal("expected compaction")
	}

	want := map[string]bool{}
	for _, m := range in {
		if m.Role == bifrostai.RoleUser {
			want[m.Text] = true
		}
	}
	got := map[string]bool{}
	for _, m := range res.Messages {
		if m.Role == bifrostai.RoleUser {
			got[m.Text] = true
		}
	}
	for text := range want {
		if !got[text] {
			t.Fatalf("user message %q was dropped by compaction", text)
		}
	}
}

func TestCompact_KeepsTheRecentTailIntactAndInOrder(t *testing.T) {
	in := history(200, true)
	p := Policy{MaxTokens: 1000, KeepRecent: 7}

	res, err := Compact(context.Background(), in, p, stubSummary("a summary"))
	if err != nil {
		t.Fatalf("Compact: %v", err)
	}
	tail := res.Messages[len(res.Messages)-p.KeepRecent:]
	original := in[len(in)-p.KeepRecent:]
	for i := range tail {
		if tail[i].Text != original[i].Text || tail[i].Role != original[i].Role {
			t.Fatalf("tail[%d] = %v/%q, want %v/%q -- the recent window must survive verbatim and in order",
				i, tail[i].Role, truncate(tail[i].Text), original[i].Role, truncate(original[i].Text))
		}
	}
}

func TestCompact_ActuallyShrinksAndReportsWhatItReplaced(t *testing.T) {
	in := history(200, true)
	p := Policy{MaxTokens: 1000, KeepRecent: 5}

	res, err := Compact(context.Background(), in, p, stubSummary("a short summary"))
	if err != nil {
		t.Fatalf("Compact: %v", err)
	}
	if res.TokensAfter >= res.TokensBefore {
		t.Fatalf("tokens %d -> %d: compaction did not shrink anything", res.TokensBefore, res.TokensAfter)
	}
	if res.Replaced != len(in)-p.KeepRecent {
		t.Fatalf("Replaced = %d, want %d -- the marker's count has to be true", res.Replaced, len(in)-p.KeepRecent)
	}
	if !strings.Contains(res.Messages[0].Text, "a short summary") {
		t.Fatalf("first message = %q, want it to carry the summary", truncate(res.Messages[0].Text))
	}
}

// A failed summary must degrade to "send the whole thing", never to a
// failed turn: the estimate is a heuristic and the request may well fit.
func TestCompact_SummarizerFailureLeavesTheHistoryUsable(t *testing.T) {
	in := history(200, true)
	p := Policy{MaxTokens: 1000, KeepRecent: 5}

	res, err := Compact(context.Background(), in, p, func(context.Context, []bifrostai.Message) (string, error) {
		return "", errors.New("provider is down")
	})
	if err == nil {
		t.Fatal("expected the error to be reported to the caller")
	}
	if res.Compacted {
		t.Fatal("a failed summary must not report success")
	}
	if len(res.Messages) != len(in) {
		t.Fatalf("messages = %d, want the original %d back", len(res.Messages), len(in))
	}
}

// An over-budget history that is *all* recent has nothing safe to drop.
// Compacting anyway would throw away the context the next step needs.
func TestCompact_DoesNothingWhenEverythingIsRecent(t *testing.T) {
	in := history(6, true)
	p := Policy{MaxTokens: 10, KeepRecent: 12}

	res, err := Compact(context.Background(), in, p, stubSummary("nope"))
	if err != nil {
		t.Fatalf("Compact: %v", err)
	}
	if res.Compacted {
		t.Fatal("compacted a history shorter than the keep-recent window")
	}
}

func TestEstimateTokens_GrowsWithTheHistory(t *testing.T) {
	small := EstimateTokens(history(10, false))
	large := EstimateTokens(history(100, true))
	if large <= small {
		t.Fatalf("estimate %d for a large history is not above %d for a small one", large, small)
	}
	// Attachments must not read as free, or a history of images looks tiny
	// and never trips the budget.
	withImage := EstimateTokens([]bifrostai.Message{
		{Role: bifrostai.RoleUser, Text: "look", Attachments: []bifrostai.Attachment{{URL: "u"}}},
	})
	if withImage < 500 {
		t.Fatalf("an attachment estimated at %d tokens is close enough to free that images would never trip the budget", withImage)
	}
}

func truncate(s string) string {
	if len(s) > 40 {
		return s[:40] + "…"
	}
	return s
}
