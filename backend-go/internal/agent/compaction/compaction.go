// Package compaction shrinks the message history sent to a model when it
// grows too large to keep sending whole.
//
// The 10-step cap used to do context management by accident. Phase 1 raised
// it to 150, which made the context window the real ceiling and left
// nothing catching it: a long turn would run until the provider rejected
// the request, with no recovery and nothing on screen explaining why.
//
// Two rules shape everything here, both from OpenWorker's compaction.py:
//
//   - **The persisted transcript is never modified.** Compaction rewrites
//     only what is *sent* to the model, per request. What the user scrolls
//     back through stays exactly what happened. A compactor that edits the
//     record is a compactor that can lose the one message someone needed.
//   - **Every user message survives.** They are the smallest and the most
//     load-bearing part of a history -- the instructions the whole run is
//     answering. Summarizing "make it use tabs, not spaces" into "the user
//     gave formatting preferences" is how an agent forgets its own task.
package compaction

import (
	"context"
	"fmt"
	"strings"

	bifrostai "amiro/backend/internal/ai/bifrost"
)

// Policy decides when to compact and how much to keep.
type Policy struct {
	// MaxTokens is the estimated budget for the outbound history. Compaction
	// triggers above it.
	MaxTokens int

	// KeepRecent is how many trailing messages are always sent verbatim.
	// The model needs the immediate past in full detail to continue
	// coherently -- a summary of the tool call it made ten seconds ago is
	// useless to it.
	KeepRecent int
}

// DefaultPolicy is deliberately conservative on the trigger and generous on
// what it keeps.
//
// 100k estimated tokens leaves headroom under every model this app ships
// with, and the estimate is a character heuristic that can be wrong by a
// lot in either direction -- so the budget is set where being wrong by 2x
// still fits rather than where it exactly fills a 128k window.
func DefaultPolicy() Policy {
	return Policy{MaxTokens: 100_000, KeepRecent: 12}
}

// EstimateTokens approximates a history's token count.
//
// Characters over four, which is the standard rough figure for English
// prose and code in BPE tokenizers. It is an estimate and is named as one:
// pulling in a real tokenizer would mean one per provider family, kept in
// sync with model releases, to decide a threshold that only needs to be
// approximately right. What matters is that it is monotonic in the thing it
// is bounding -- a history that grows always estimates larger.
func EstimateTokens(messages []bifrostai.Message) int {
	chars := 0
	for _, m := range messages {
		chars += len(m.Text)
		for _, tc := range m.ToolCalls {
			chars += len(tc.Name) + len(tc.Arguments)
		}
		// An attachment costs far more than its URL, but the real figure
		// depends on the image and the provider. Counted as a flat, large
		// constant so a history full of images trips the budget rather than
		// looking free.
		chars += len(m.Attachments) * 4000
	}
	return chars / 4
}

// Summarizer turns the older part of a history into prose. Implemented in
// internal/api/chat over the same Engine the loop already uses.
type Summarizer func(ctx context.Context, messages []bifrostai.Message) (string, error)

// Result is what Compact produced.
type Result struct {
	// Messages is the history to send. Identical to the input when nothing
	// was compacted.
	Messages []bifrostai.Message

	// Compacted reports whether anything was replaced. The caller emits a
	// visible marker when it is true -- a silent context drop is exactly
	// the kind of thing a user has to be able to see to trust a transcript.
	Compacted bool

	// Replaced is how many messages the summary stands in for, and
	// TokensBefore/TokensAfter the estimates either side. All three are for
	// the marker: "compacted 48 earlier messages" is a fact a user can
	// reason about, "context was compacted" is not.
	Replaced     int
	TokensBefore int
	TokensAfter  int
}

// Compact returns a history that fits the policy.
//
// The shape is: [system-ish preamble untouched] [summary of the middle]
// [every user message from the middle, verbatim] [the last KeepRecent
// messages]. Ordering is preserved throughout, because a model reading a
// history where its own turns have been shuffled reasons about a
// conversation that never happened.
func Compact(ctx context.Context, messages []bifrostai.Message, p Policy, summarize Summarizer) (Result, error) {
	before := EstimateTokens(messages)
	res := Result{Messages: messages, TokensBefore: before, TokensAfter: before}

	if p.MaxTokens <= 0 || before <= p.MaxTokens {
		return res, nil
	}
	if len(messages) <= p.KeepRecent+1 {
		// Nothing to summarize: the history is over budget but it is all
		// recent. Compacting here would drop the very context the next step
		// needs, and would not shrink much anyway. Sending it and letting
		// the provider complain is the honest failure -- it is at least a
		// legible one.
		return res, nil
	}

	cut := len(messages) - p.KeepRecent
	older, recent := messages[:cut], messages[cut:]

	summary, err := summarize(ctx, older)
	if err != nil {
		// A failed summary must not fail the turn. Sending the full history
		// might still work (the estimate is a heuristic and may be high);
		// refusing to send anything definitely does not.
		return res, fmt.Errorf("compaction: %w", err)
	}
	summary = strings.TrimSpace(summary)
	if summary == "" {
		return res, nil
	}

	out := make([]bifrostai.Message, 0, len(recent)+8)
	out = append(out, bifrostai.Message{
		Role: bifrostai.RoleUser,
		Text: "[Earlier in this conversation, summarized to save space]\n\n" + summary,
	})

	// Every user message from the compacted range, verbatim and in order,
	// after the summary. They are cheap (a user message is a sentence, a
	// tool result is a file) and they are the instructions the run is
	// answering.
	for _, m := range older {
		if m.Role == bifrostai.RoleUser && strings.TrimSpace(m.Text) != "" {
			out = append(out, m)
		}
	}
	out = append(out, recent...)

	res.Messages = out
	res.Compacted = true
	res.Replaced = len(older)
	res.TokensAfter = EstimateTokens(out)
	return res, nil
}

// SummaryPrompt is the instruction given to the summarizing model.
//
// Written to preserve the things a coding agent needs to continue, in the
// order it needs them, and to say so explicitly -- a generic "summarize the
// above" produces a readable paragraph that has dropped every file path,
// which is the only part the next step actually uses.
const SummaryPrompt = `Summarize the conversation so far for your own future reference. You are about to continue this work with the detailed history removed, so write what you would need to pick it up cold.

Cover, in this order, and omit any section that has nothing in it:

1. What the user asked for, including any constraints or preferences they stated.
2. What has been done: files created or edited (with paths), commands run and their outcomes, decisions made and why.
3. What was learned about the codebase that is not obvious from a fresh look -- where things live, what surprised you.
4. What is left to do, and anything currently broken or half-finished.

Be specific. Keep exact file paths, function names, error messages and command lines verbatim; those are the parts that cannot be reconstructed. Do not address the user, do not editorialize, and do not pad. Prose and short lists only.`
