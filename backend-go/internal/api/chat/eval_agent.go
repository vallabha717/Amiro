package chat

import (
	"context"
	"fmt"

	"amiro/backend/internal/agent/eval"
	"amiro/backend/internal/agent/lsp"
	"amiro/backend/internal/agent/permission"
	"amiro/backend/internal/agent/session"
	"amiro/backend/internal/agent/workspace"
	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/ai/prompts"
	"amiro/backend/internal/ai/tools"
	"amiro/backend/internal/ai/uimessage"
)

// EvalAgent drives the real tool loop for the evaluation harness.
//
// It lives here rather than in internal/agent/eval because the loop is
// unexported and belongs to this package -- the harness holds an interface
// (eval.Agent) and this is the adapter, which is what keeps the dependency
// pointing from the harness at the app instead of the reverse.
//
// What it deliberately does *not* reuse is the HTTP path: no thread, no
// persistence, no user, no MCP servers. A harness that ran through the
// request handler would be measuring the database and the auth middleware
// alongside the agent, and every scaffold comparison would carry that
// noise. What it does share is the part that matters -- the same
// runToolLoop, the same tool definitions, the same permission engine -- so
// a result here is a statement about the agent that ships.
type EvalAgent struct {
	Engine Engine
	Model  bifrostai.ResolvedModel

	// System is prepended to the task prompt's system message. Empty uses
	// the default agent prompt, which is what the app itself sends.
	System string
}

// NewEvalAgent returns an agent bound to one engine and model.
func NewEvalAgent(engine Engine, model bifrostai.ResolvedModel) *EvalAgent {
	return &EvalAgent{Engine: engine, Model: model}
}

// Solve runs one task, returning the structured record of what happened.
//
// A fresh workspace, todo store, permission engine and language server pool
// per task. Sharing any of them across tasks would let one task's state
// change another's result, which is the difference between a benchmark and
// a sequence of anecdotes.
func (a *EvalAgent) Solve(ctx context.Context, root, prompt, mode string) (*session.Log, eval.Usage, error) {
	ws, err := workspace.New(root)
	if err != nil {
		return nil, eval.Usage{}, fmt.Errorf("eval agent: %w", err)
	}

	pool := lsp.NewPool(root)
	defer pool.Close()

	active := tools.Defaults(tools.Deps{
		Workspace: ws,
		Todos:     tools.NewTodoStore(),
		SessionID: "eval",
		// No memory store: a benchmark in which task 7 remembers what task
		// 3 learned is not measuring the same thing twice, and the numbers
		// would improve over a run for reasons that have nothing to do with
		// the scaffold.
		LSP: pool,
	})

	perms := permission.New(
		permission.ParseMode(mode),
		ws,
		permission.DefaultAllowedCommands,
		nil, // no session grants: nobody is here to grant anything
	)

	if task, ok := subagentTool(a.Engine, a.Model, active, perms); ok {
		active = mergeToolDefinitions(active, []tools.Definition{task})
	}

	system := a.System
	if system == "" {
		// The same prompt the app builds, with no user or preferences --
		// those are per-account and would make one developer's benchmark
		// numbers incomparable with another's.
		system = prompts.BuildUserSystemPrompt(nil, nil)
	}

	// A discard writer: there is no client. The tool loop's stream frames
	// are for a browser, and the harness reads the event log instead --
	// which is precisely the separation the log was introduced to make
	// possible.
	result, runErr := runToolLoop(
		ctx, a.Engine, uimessage.NewDiscardWriter(), a.Model, system,
		[]bifrostai.Message{{Role: bifrostai.RoleUser, Text: prompt}},
		active, perms, nil, // eval runs capture no checkpoints -- there is no thread to rewind
	)

	usage := eval.Usage{}
	if result.Usage != nil {
		usage.PromptTokens = result.Usage.PromptTokens
		usage.CompletionTokens = result.Usage.CompletionTokens
	}
	return result.Log, usage, runErr
}
