package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"amiro/backend/internal/agent/permission"
	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/ai/tools"
	"amiro/backend/internal/ai/uimessage"
)

// subagentBudget is deliberately smaller than the parent's.
//
// A subagent exists to answer one bounded question. One that needs 150
// steps has been given a task that should have been the parent's, and
// letting it run that long spends the parent's wall-clock budget on work
// the parent cannot see or steer. Hitting the cap is a signal the task was
// too broad, and the tool says so in its result rather than failing
// silently.
var subagentBudget = loopBudget{MaxSteps: 30, Wall: 5 * time.Minute}

// subagentToolNames is the subset a child may use: read-only, plus the
// plan tools it needs to keep itself straight.
//
// Read-only is the whole design. A subagent's work is invisible to the user
// -- no cards, no approval prompts, nothing in the transcript but a
// paragraph at the end -- and giving write or exec access to a loop nobody
// is watching is exactly the thing Phase 3 spent itself preventing. The
// child explores and reports; the parent, whose every consequential call
// the user sees and approves, is what acts on the report.
var subagentToolNames = map[string]bool{
	tools.NameReadFile:   true,
	tools.NameListDir:    true,
	tools.NameGlob:       true,
	tools.NameGrep:       true,
	tools.NameWebSearch:  true,
	tools.NameWebContent: true,
	tools.NameSkill:      true,
}

type subagentInput struct {
	Description string `json:"description"`
	Prompt      string `json:"prompt"`
}

// SubagentOutput is what the parent (and the presenter) sees. The child's
// own steps are not here, by design -- see subagentTool.
type SubagentOutput struct {
	Description string `json:"description"`
	Result      string `json:"result"`
	Steps       int    `json:"steps"`
	DurationMS  int64  `json:"duration_ms"`
	Truncated   bool   `json:"truncated"`
	Notice      string `json:"notice,omitempty"`
}

const subagentSystemPrompt = `You are a subagent investigating one specific question for another agent. You cannot ask follow-up questions and nobody will read your intermediate steps -- only your final message is returned.

So: do the work, then write a single self-contained answer. Quote exact file paths, symbol names and line numbers; the agent reading this cannot see anything you looked at. If you could not determine something, say so plainly rather than guessing -- a confident wrong answer here becomes the parent's premise for everything after.

You have read-only tools. You cannot edit files or run commands; do not plan to.`

// subagentTool builds the `task` tool: a child agent loop with its own
// context window that returns only its final text.
//
// This is the context-management primitive, not just a parallelism one
// (§2.4). Exploring a codebase costs tens of thousands of tokens of file
// contents to produce one paragraph of conclusion, and the parent needs the
// paragraph. Running that exploration in a child whose history is discarded
// is what lets a long turn survive: the parent's context grows by the
// answer, not by the search.
//
// Built here rather than in internal/ai/tools because it needs the engine,
// the resolved model and the permission engine -- the same reason the MCP
// and workflow tools are built in this package.
func subagentTool(
	engine Engine,
	resolved bifrostai.ResolvedModel,
	parentTools []tools.Definition,
	perms *permission.Engine,
) (tools.Definition, bool) {
	childTools := make([]tools.Definition, 0, len(subagentToolNames))
	for _, d := range parentTools {
		if subagentToolNames[d.Name] {
			childTools = append(childTools, d)
		}
	}
	// Nothing to explore with: a `task` tool whose child has no tools is a
	// slower, more confusing way to ask the model a question directly.
	if len(childTools) == 0 {
		return tools.Definition{}, false
	}

	return tools.Definition{
		Name:    tools.NameTask,
		Toolkit: tools.ToolkitTask,
		// Read: the child's tools are all reads, so the call as a whole has
		// no side effects, and two investigations of different questions
		// are safe to run at once -- which is most of the point.
		Risk: tools.RiskRead,
		Description: "Delegate an open-ended investigation to a subagent with its own context. " +
			"Use this when answering something would mean reading many files whose contents you " +
			"do not need to keep -- 'where is auth handled', 'what calls this'. The subagent has " +
			"read-only tools and returns a single summary; its intermediate reads never enter your " +
			"context. Give it a self-contained prompt: it cannot see this conversation. " +
			"Do not use it for work you already know the target of -- read the file yourself.",
		ParametersSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"description": {"type": "string", "description": "3-6 words naming the investigation, for the UI."},
				"prompt": {"type": "string", "description": "The full, self-contained task. State what to find and what to report back."}
			},
			"required": ["description", "prompt"],
			"additionalProperties": false
		}`),
		Execute: func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in subagentInput
			if err := json.Unmarshal(raw, &in); err != nil {
				return nil, fmt.Errorf("task: %w", err)
			}
			if strings.TrimSpace(in.Prompt) == "" {
				return nil, fmt.Errorf("task: prompt is required -- the subagent cannot see this conversation")
			}

			started := time.Now()
			// The child writes to a discard stream: its steps must not appear
			// in the parent's transcript.
			child, err := runToolLoopWithBudget(
				ctx,
				engine,
				uimessage.NewDiscardWriter(),
				resolved,
				subagentSystemPrompt,
				[]bifrostai.Message{{Role: bifrostai.RoleUser, Text: in.Prompt}},
				childTools,
				perms,
				nil, // the child's tool subset is read-only (subagentToolNames); nothing to checkpoint
				subagentBudget,
			)
			if err != nil {
				return nil, fmt.Errorf("task %q: %w", in.Description, err)
			}

			out := SubagentOutput{
				Description: in.Description,
				Result:      strings.TrimSpace(child.Text),
				Steps:       child.Steps,
				DurationMS:  time.Since(started).Milliseconds(),
				Truncated:   child.Steps >= subagentBudget.MaxSteps,
			}
			if out.Result == "" {
				// A child that used its whole budget on tools and never wrote
				// a conclusion has produced nothing, and the parent must not
				// read an empty string as "no findings".
				out.Notice = "the subagent finished without writing a summary; treat this as no answer, not as an empty result"
			} else if out.Truncated {
				out.Notice = fmt.Sprintf("the subagent hit its %d-step limit, so this answer may be incomplete", subagentBudget.MaxSteps)
			}
			return out, nil
		},
	}, true
}
