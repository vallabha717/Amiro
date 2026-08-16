package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"amiro/backend/internal/agent/permission"
	"amiro/backend/internal/agent/session"
	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/ai/tools"
	"amiro/backend/internal/ai/uimessage"
	"amiro/backend/internal/db/models"
)

// loopBudget bounds how far one agent turn may run.
//
// This replaces route.ts's `stopWhen: stepCountIs(10)`. Ten steps is a
// chat ceiling, not an agent one: locating a file, reading it, editing it
// and re-running a test is already four steps before any real work starts,
// so a fixed ten silently truncates every non-trivial task. The budget is
// two independent limits because they fail differently -- MaxSteps catches
// a model looping on a tool it can't get right, Wall catches a turn that
// is progressing but will never finish inside a request the user is
// actually waiting on.
type loopBudget struct {
	MaxSteps int
	Wall     time.Duration
}

// defaultLoopBudget is deliberately generous on steps. The real ceiling on
// a long turn is the context window, and until auto-compaction lands
// (docs/agentic-loop-implementation-plan.md, Phase 4) a turn that runs
// this long will hit the model's limit before it hits MaxSteps -- Wall is
// what genuinely bounds it today.
func defaultLoopBudget() loopBudget {
	return loopBudget{MaxSteps: 150, Wall: 15 * time.Minute}
}

// modelStepTimeout bounds a single StreamStep call (one full model turn,
// including every streamed chunk). bifrost/core deliberately imposes no
// deadline of its own here (schemas.NoDeadline -- see stream_step.go's
// bctx construction), trusting the caller's ctx alone, and this app's ctx
// otherwise has no deadline either: an httpserver request context only
// gets canceled by client disconnect, never by a timeout. Found live: a
// tool-augmented follow-up turn (model + tool history round-tripped back
// to the provider) against a custom OpenAI-compatible endpoint hung with
// no data ever arriving and no way to recover -- not an MCP problem at
// all, since a plain single-step chat against the same model completed
// normally. Generous on purpose: this bounds total call duration, not
// idle time between chunks, so it must comfortably exceed a real slow-but-
// actively-streaming response.
// A var, not a const, so tests can shrink it instead of waiting out the
// real duration.
var modelStepTimeout = 120 * time.Second

// toolLoopResult is what running the multi-step tool loop produced, ready
// for route.go to fold into an assistant models.ChatMessage the same way a
// tool-free reply already is.
type toolLoopResult struct {
	Text  string          // every step's text, in order, joined like textOf
	Parts json.RawMessage // the full ordered parts array to persist
	Usage *bifrostai.Usage

	// Steps is how many model turns the loop actually ran. Only the
	// subagent tool reads it, to report "explored auth flow · 12 steps" and
	// to notice that a child hit its cap rather than finished.
	Steps int

	// Log is the structured record of what the turn did -- actions and
	// their observations, in call order (internal/agent/session). Nothing
	// in the request path reads it today; the evaluation harness does, and
	// it is the seed of the projection Phase 1 deferred.
	Log *session.Log
}

// runToolLoop ports route.ts's `streamText({tools, stopWhen:
// stepCountIs(10)})` multi-step tool-calling loop over Bifrost's real
// network stream (StreamStep): call the model, forwarding its text deltas
// to the client as they arrive, and if it made tool calls, resolve every
// one that has a server-side Execute (visualization, http, web search) and
// loop again with the result appended to history.
//
// Tool calls are *dispatched* during the stream, as each one's arguments
// finish arriving (StepHooks.OnToolCallReady), not in a batch after the
// step completes. A turn that asks for four charts therefore renders them
// one at a time as the model writes them, instead of showing nothing for
// several seconds and then painting all four at once.
//
// Dispatch is not the same as execution. toolScheduler runs side-effect-free
// tools (tools.Parallel) concurrently and everything else strictly in call
// order, then merges every result back in the order the model emitted the
// calls -- so four reads cost one round trip's latency instead of four,
// while the history the next step sees stays byte-identical run to run.
//
// A tool call whose Definition has a nil Execute (JS/Python execution --
// internal/ai/tools/code.go) is a client tool: its call is written to the
// stream and the loop stops immediately, same as the TS route, where a tool
// with no `execute` pauses generation until the frontend resubmits with a
// result (chat-bot.tsx's sendAutomaticallyWhen). Any other tool calls in
// that same batch are left unresolved and dropped -- matching how the
// underlying step can't complete with only some of its tool calls answered.
func runToolLoop(
	ctx context.Context,
	engine Engine,
	sw *uimessage.Writer,
	resolved bifrostai.ResolvedModel,
	system string,
	messages []bifrostai.Message,
	activeTools []tools.Definition,
	perms *permission.Engine,
) (toolLoopResult, error) {
	return runToolLoopWithBudget(ctx, engine, sw, resolved, system, messages, activeTools, perms, defaultLoopBudget())
}

// runToolLoopWithBudget is runToolLoop with the budget as a parameter, for
// the subagent tool -- a child agent gets a smaller one (subagent.go).
func runToolLoopWithBudget(
	ctx context.Context,
	engine Engine,
	sw *uimessage.Writer,
	resolved bifrostai.ResolvedModel,
	system string,
	messages []bifrostai.Message,
	activeTools []tools.Definition,
	perms *permission.Engine,
	budget loopBudget,
) (toolLoopResult, error) {
	specs := make([]bifrostai.ToolSpec, len(activeTools))
	for i, d := range activeTools {
		specs[i] = bifrostai.ToolSpec{Name: d.Name, Description: d.Description, ParametersSchema: d.ParametersSchema}
	}

	var fullText string
	parts := []map[string]any{}
	var usage *bifrostai.Usage
	log := session.NewLog()

	deadline := time.Now().Add(budget.Wall)

	steps := 0
	for step := 0; step < budget.MaxSteps; step++ {
		steps = step + 1
		if time.Now().After(deadline) {
			break
		}

		// Before the model call, not after: the check has to happen where
		// the history is about to be *sent*, and a turn does most of its
		// growing inside itself.
		var compactionPart map[string]any
		messages, compactionPart = compactIfNeeded(ctx, engine, sw, resolved, messages)

		_ = sw.StartStep()
		if compactionPart != nil {
			parts = append(parts, compactionPart)
			log.Record(
				session.Action{Kind: session.ActionCompact, Step: step},
				session.Observation{Status: session.StatusOK, Summary: compactionSummary(compactionPart)},
			)
		}

		textID := models.NewID()
		textOpen := false
		openText := func() {
			if !textOpen {
				_ = sw.TextStart(textID)
				textOpen = true
			}
		}
		// Providers deliver text in uneven bursts; the smoother re-spaces it
		// into whole words so the reply reads as if it were being written
		// rather than pasted in lurches. See uimessage.Smoother.
		textSmoother := uimessage.NewSmoother(func(frag string) error {
			return sw.TextDelta(textID, frag)
		})
		closeText := func() {
			if textOpen {
				textSmoother.Flush()
				_ = sw.TextEnd(textID)
				textOpen = false
				textID = models.NewID()
			}
		}

		// Reasoning arrives before any content or tool call, so this part is
		// what puts something on screen during the seconds a reasoning model
		// spends thinking.
		reasoningID := models.NewID()
		reasoningOpen := false
		reasoningSmoother := uimessage.NewSmoother(func(frag string) error {
			return sw.ReasoningDelta(reasoningID, frag)
		})
		closeReasoning := func() {
			if reasoningOpen {
				reasoningSmoother.Flush()
				_ = sw.ReasoningEnd(reasoningID)
				reasoningOpen = false
			}
		}

		// The scheduler owns dedupe (the hook covers every call a provider
		// streams incrementally, the post-step sweep covers anything it
		// didn't) and decides which calls may overlap.
		sched := newToolScheduler(sw, activeTools, perms).withLog(log, step)

		offerToolCall := func(tc bifrostai.ToolCall) {
			// Close the open reasoning/text parts first so the client renders
			// them and the tool cards in the order the model produced them.
			closeReasoning()
			closeText()

			sched.Offer(ctx, tc)
		}

		hooks := bifrostai.StepHooks{
			OnReasoningDelta: func(delta string) {
				if !reasoningOpen {
					_ = sw.ReasoningStart(reasoningID)
					reasoningOpen = true
				}
				reasoningSmoother.Write(delta)
			},
			OnTextDelta: func(delta string) {
				// Thinking is over the moment real content starts.
				closeReasoning()
				openText()
				textSmoother.Write(delta)
			},
			OnToolCallStart: func(id, name string) { _ = sw.ToolInputStart(id, name) },
			OnToolCallDelta: func(id, argsDelta string) { _ = sw.ToolInputDelta(id, argsDelta) },
			OnToolCallReady: offerToolCall,
		}

		stepCtx, cancel := context.WithTimeout(ctx, modelStepTimeout)
		result, err := engine.StreamStep(stepCtx, resolved, system, messages, specs, hooks)
		cancel()
		if err != nil {
			closeReasoning()
			closeText()
			// Calls the hook already dispatched are still running against
			// the parent ctx. Drain them before unwinding, or they outlive
			// the request and write into a stream nobody is reading.
			sched.Finish(ctx)
			_ = sw.FinishStep()
			if stepCtx.Err() == context.DeadlineExceeded {
				return toolLoopResult{}, fmt.Errorf("model call timed out after %s: %w", modelStepTimeout, err)
			}
			return toolLoopResult{}, err
		}
		closeReasoning()
		closeText()

		if result.Usage != nil {
			usage = addUsage(usage, result.Usage)
		}

		// Record the step's text once, ahead of this step's tool parts.
		//
		// Tool parts used to be appended here mid-stream, which put them
		// *before* the text in the persisted array even though the client
		// had already been shown the text first (closeText runs before the
		// first tool frame). Reloading a thread therefore reordered it.
		// Draining tools after the step lines the persisted order up with
		// the streamed one. Text a model interleaves *between* two tool
		// calls still collapses into one part -- StepResult carries the
		// step's text as a single string -- which is unchanged from before.
		if result.Reasoning != "" {
			parts = append(parts, map[string]any{"type": "reasoning", "text": result.Reasoning})
			log.Record(
				session.Action{Kind: session.ActionThink, Step: step, Text: clip(result.Reasoning)},
				session.Observation{Status: session.StatusOK},
			)
		}
		if result.Text != "" {
			if fullText != "" {
				fullText += "\n\n"
			}
			fullText += result.Text
			parts = append(parts, map[string]any{"type": "text", "text": result.Text})
			log.Record(
				session.Action{Kind: session.ActionMessage, Step: step, Text: clip(result.Text)},
				session.Observation{Status: session.StatusOK},
			)
		}

		if len(result.ToolCalls) == 0 {
			_ = sw.FinishStep()
			break
		}

		// Sweep anything the hook could not finalize mid-stream (a provider
		// that only produced complete tool calls at the end). Offer is a
		// no-op for calls the hook already took.
		for _, tc := range result.ToolCalls {
			offerToolCall(tc)
		}

		// Drain: sequential calls run here in order, parallel ones are
		// joined. Outcomes come back in the model's original call order
		// regardless of which finished first.
		for _, out := range sched.Finish(ctx) {
			parts = append(parts, out.part)
			messages = append(messages, out.messages...)
		}

		// Approval requests are persisted alongside the tool parts they
		// describe, after them, so a reloaded thread can still find the
		// pending call and re-render its card.
		parts = append(parts, sched.Approvals()...)

		_ = sw.FinishStep()
		if sched.Paused() {
			break
		}
	}

	partsJSON, err := json.Marshal(parts)
	if err != nil {
		return toolLoopResult{}, err
	}
	return toolLoopResult{Text: fullText, Parts: partsJSON, Usage: usage, Steps: steps, Log: log}, nil
}

// clip bounds the text an event carries. The log measures a run; the
// transcript is what holds the prose, and duplicating it here would make
// the log as expensive to keep as the thing it summarizes.
func clip(s string) string {
	const max = 400
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}

func compactionSummary(part map[string]any) string {
	data, _ := part["data"].(map[string]any)
	if data == nil {
		return ""
	}
	return fmt.Sprintf("replaced %v messages, %v -> %v estimated tokens",
		data["replaced"], data["tokensBefore"], data["tokensAfter"])
}
