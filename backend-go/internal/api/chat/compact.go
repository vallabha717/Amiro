package chat

import (
	"context"
	"strings"

	"amiro/backend/internal/agent/compaction"
	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/ai/uimessage"
)

// compactionDataPart names the data part carrying a compaction marker. The
// frontend keys off `data-` + this.
const compactionDataPart = "context-compacted"

// summarizerFor builds a compaction.Summarizer over the same engine and
// model the turn is already using.
//
// The same model, deliberately, rather than a cheap one: the summary
// becomes the agent's only memory of the first half of its own run, and a
// weaker model's version of "what was learned about this codebase" is where
// a long turn silently goes wrong. This is the one call in the loop whose
// output the model will trust unconditionally.
func summarizerFor(engine Engine, resolved bifrostai.ResolvedModel) compaction.Summarizer {
	return func(ctx context.Context, messages []bifrostai.Message) (string, error) {
		// The instruction rides as a final user turn rather than as the
		// system prompt, so the history being summarized keeps its own
		// roles intact -- flattening it into one blob loses who said what,
		// which is most of what makes a transcript summarizable.
		input := make([]bifrostai.Message, 0, len(messages)+1)
		input = append(input, messages...)
		input = append(input, bifrostai.Message{Role: bifrostai.RoleUser, Text: compaction.SummaryPrompt})

		result, err := engine.StreamStep(ctx, resolved, "", input, nil, bifrostai.StepHooks{})
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(result.Text), nil
	}
}

// compactIfNeeded shrinks the outbound history when it has grown past the
// budget, emitting a visible marker when it does.
//
// Called at the top of every step rather than once per turn: a turn that
// reads thirty files does most of its growing *inside* itself, so a
// per-turn check would measure the history before the growth that caused
// the problem.
//
// Failure is not fatal. A summarizer that errors leaves the history
// untouched and the turn continues -- the request may well still fit,
// since the budget is a deliberately cautious reading of a heuristic
// estimate, and failing the turn over a failed optimization would be worse
// than the problem.
func compactIfNeeded(
	ctx context.Context,
	engine Engine,
	sw uimessage.Emitter,
	resolved bifrostai.ResolvedModel,
	messages []bifrostai.Message,
) ([]bifrostai.Message, map[string]any) {
	policy := compaction.DefaultPolicy()
	if consumeForceCompact(ctx) {
		// A budget of 1 token clears Compact's own "under budget" check
		// unconditionally -- its other guard (nothing to compact once
		// everything is within KeepRecent) still applies, which is the
		// right behavior for a manual /compact on a short thread: there is
		// nothing to summarize yet, and saying so beats compacting the
		// summary of a summary.
		policy.MaxTokens = 1
	}
	res, err := compaction.Compact(ctx, messages, policy, summarizerFor(engine, resolved))
	if err != nil || !res.Compacted {
		return messages, nil
	}

	data := map[string]any{
		"replaced":     res.Replaced,
		"tokensBefore": res.TokensBefore,
		"tokensAfter":  res.TokensAfter,
	}
	_ = sw.Data(compactionDataPart, "", data)

	// Returned as the marker's *data*, not as a finished part. The caller
	// records it on the compaction event and the parts projection wraps it
	// (parts.go) -- so the marker still survives a reload, and this function
	// no longer knows the persisted format. A user scrolling back through a
	// long turn needs to see where the agent stopped being able to remember
	// the beginning of it.
	return res.Messages, data
}

// forceCompactKey types the context value below -- the same pattern
// approver.go uses for the same reason: request-scoped, optional, with a
// correct zero behavior (unset means "only compact when actually over
// budget," the existing rule).
//
// A ctx value rather than a parameter on compactIfNeeded/runToolLoop
// specifically to avoid touching either signature: runToolLoop alone has
// upwards of a dozen call sites across this package's own test suite, and
// none of them have any reason to know a manual compact was requested. The
// alternative -- a new parameter threaded through runToolLoop,
// runToolLoopWithBudget, and every test call site -- is a wide, purely
// mechanical diff for a feature (the TUI's /compact) that only ever needs
// to reach the one place a step's history gets checked.
type forceCompactKey struct{}

// WithForceCompact marks ctx's turn to compact its history on the very next
// check regardless of size -- the TUI's `/compact` (component/editor's
// slash commands), sent as TurnRequest.CompactNow.
//
// The flag is consumed by the first call to compactIfNeeded and cleared
// immediately after, via the pointer this stores rather than a plain bool
// value -- ctx itself is immutable, but what it points to isn't. Without
// that, a multi-step turn would force-compact every step, not just the
// first, repeatedly summarizing history that was just summarized.
func WithForceCompact(ctx context.Context, force bool) context.Context {
	flag := force
	return context.WithValue(ctx, forceCompactKey{}, &flag)
}

// consumeForceCompact reports whether ctx was still carrying an unconsumed
// force request, and clears it either way.
func consumeForceCompact(ctx context.Context) bool {
	ptr, ok := ctx.Value(forceCompactKey{}).(*bool)
	if !ok || !*ptr {
		return false
	}
	*ptr = false
	return true
}
