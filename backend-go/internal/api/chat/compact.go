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
	sw *uimessage.Writer,
	resolved bifrostai.ResolvedModel,
	messages []bifrostai.Message,
) ([]bifrostai.Message, map[string]any) {
	res, err := compaction.Compact(ctx, messages, compaction.DefaultPolicy(), summarizerFor(engine, resolved))
	if err != nil || !res.Compacted {
		return messages, nil
	}

	data := map[string]any{
		"replaced":     res.Replaced,
		"tokensBefore": res.TokensBefore,
		"tokensAfter":  res.TokensAfter,
	}
	_ = sw.Data(compactionDataPart, "", data)

	// Persisted as a part too, so the marker is still there on reload. A
	// user scrolling back through a long turn needs to see where the agent
	// stopped being able to remember the beginning of it.
	return res.Messages, map[string]any{
		"type": "data-" + compactionDataPart,
		"data": data,
	}
}
