package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"amiro/backend/internal/agent/workspace"
)

// gitTimeout bounds one git invocation. Generous enough for a `log` over a
// large history, short enough that a git subprocess waiting on a credential
// prompt (which GIT_TERMINAL_PROMPT=0 should already prevent) cannot hold a
// turn open.
const gitTimeout = 60 * time.Second

// gitMaxOutputChars caps what a single subcommand returns to the model. A
// `git diff` over a large refactor is easily megabytes, and pasting that
// into the context window is how a turn dies two steps later.
const gitMaxOutputChars = 30000

// gitSubcommands is the entire vocabulary this tool exposes. It is an
// allowlist, not a starting point: `git` is a program with subcommands that
// rewrite history, publish to remotes, and run arbitrary code via aliases
// and hooks. Passing the model's string straight to argv[1] would make this
// a shell tool wearing a git costume, and it would bypass the exec risk
// class the actual shell tool is gated under.
//
// push, pull, fetch, reset, rebase, checkout and clean are all deliberately
// absent. The first three reach the network; the rest destroy uncommitted
// work. An agent that needs them can ask for the shell, where the user sees
// the literal command before approving it.
var gitSubcommands = map[string]struct {
	// args builds the argv after "git", from the call's input.
	args func(in gitInput) ([]string, error)
}{
	"status": {args: func(in gitInput) ([]string, error) {
		return []string{"status", "--porcelain=v1", "--branch"}, nil
	}},
	"diff": {args: func(in gitInput) ([]string, error) {
		argv := []string{"diff"}
		if in.Staged {
			argv = append(argv, "--staged")
		}
		return append(argv, pathArgs(in.Paths)...), nil
	}},
	"log": {args: func(in gitInput) ([]string, error) {
		n := in.MaxCount
		if n <= 0 || n > 100 {
			n = 20
		}
		return append([]string{"log", fmt.Sprintf("-n%d", n), "--oneline", "--no-decorate"}, pathArgs(in.Paths)...), nil
	}},
	"show": {args: func(in gitInput) ([]string, error) {
		// No ref means "the last commit", which is the only case worth
		// supporting without letting the model hand git an arbitrary
		// revision expression.
		if in.Ref == "" {
			return []string{"show", "--stat", "--patch"}, nil
		}
		if !isSafeGitRef(in.Ref) {
			return nil, fmt.Errorf("git: ref %q is not a plain revision name", in.Ref)
		}
		return []string{"show", "--stat", "--patch", in.Ref}, nil
	}},
	"add": {args: func(in gitInput) ([]string, error) {
		if len(in.Paths) == 0 {
			return nil, fmt.Errorf("git add: paths is required -- stage the files you changed, not everything")
		}
		return append([]string{"add", "--"}, in.Paths...), nil
	}},
	"commit": {args: func(in gitInput) ([]string, error) {
		if strings.TrimSpace(in.Message) == "" {
			return nil, fmt.Errorf("git commit: message is required")
		}
		// --no-verify is NOT passed: if the repo has hooks, the user wants
		// them to run, and silently skipping them is exactly the kind of
		// thing an agent should never decide on its own.
		return []string{"commit", "-m", in.Message}, nil
	}},
}

type gitInput struct {
	Subcommand string   `json:"subcommand"`
	Paths      []string `json:"paths,omitempty"`
	Message    string   `json:"message,omitempty"`
	Ref        string   `json:"ref,omitempty"`
	Staged     bool     `json:"staged,omitempty"`
	MaxCount   int      `json:"max_count,omitempty"`
	// Force is push-only: it is what lets --force reach the underlying
	// git invocation at all, and it changes nothing about gating -- push
	// always asks (see gitAlwaysAsk), force or not. See
	// docs/coding-agent-parity/04-git-remote-operations.md.
	Force bool `json:"force,omitempty"`
}

// gitPushRemote is the only remote push ever targets. The tool does not
// add remotes and does not let the model name one -- see
// docs/coding-agent-parity/04-git-remote-operations.md's "remote must
// already be configured" and create_pr's identical assumption when it
// infers owner/repo from this same remote.
const gitPushRemote = "origin"

// currentBranch resolves the workspace's checked-out branch itself, so
// push targets exactly that branch and nothing the model named --
// docs/coding-agent-parity/04-git-remote-operations.md's "current branch
// only" constraint, enforced structurally rather than by asking nicely.
func currentBranch(ctx context.Context, ws *workspace.Workspace) (string, error) {
	execCtx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(execCtx, "git", "rev-parse", "--abbrev-ref", "HEAD")
	cmd.Dir = ws.Root()
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("git: could not resolve the current branch: %w", err)
	}
	branch := strings.TrimSpace(string(out))
	if branch == "" || branch == "HEAD" {
		return "", fmt.Errorf("git: not currently on a branch (detached HEAD) -- check out a branch first")
	}
	return branch, nil
}

// gitRemoteURL reads a configured remote's URL, or an error if remote does
// not exist -- push and create_pr both refuse rather than guess or add one.
func gitRemoteURL(ctx context.Context, ws *workspace.Workspace, remote string) (string, error) {
	execCtx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(execCtx, "git", "remote", "get-url", remote)
	cmd.Dir = ws.Root()
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("git: no %q remote is configured in this workspace -- add one in a terminal first", remote)
	}
	return strings.TrimSpace(string(out)), nil
}

// gitAlwaysAsk is git.go's Definition.AlwaysAsk: true only for push (force
// or not), leaving every other subcommand on the ordinary
// command-allowlist path unchanged. See tools.go's Definition.AlwaysAsk
// doc comment for why this is a function rather than a plain bool.
func gitAlwaysAsk(raw json.RawMessage) bool {
	var in gitInput
	if err := json.Unmarshal(raw, &in); err != nil {
		return false
	}
	return in.Subcommand == "push"
}

// buildPushArgv resolves the current branch and the configured remote,
// then builds `push <remote> <branch>` (+ `--force` iff in.Force) -- the
// only argv this tool's push subcommand ever produces. Returns the branch
// too, since gitCommandLine needs it for the approval card without a
// second resolution.
func buildPushArgv(ctx context.Context, ws *workspace.Workspace, in gitInput) (argv []string, branch string, err error) {
	if _, err := gitRemoteURL(ctx, ws, gitPushRemote); err != nil {
		return nil, "", err
	}
	branch, err = currentBranch(ctx, ws)
	if err != nil {
		return nil, "", err
	}
	argv = []string{"push", gitPushRemote, branch}
	if in.Force {
		argv = append(argv, "--force")
	}
	return argv, branch, nil
}

// GitOutput is what the presenter renders. Subcommand and Paths are echoed
// back because the glance line ("git commit · 3 files") is built from the
// output alone -- a presenter that has to reach into the input to say what
// happened is a presenter that shows nothing while a call is still pending.
type GitOutput struct {
	Subcommand string   `json:"subcommand"`
	Command    string   `json:"command"`
	Paths      []string `json:"paths,omitempty"`
	ExitCode   int      `json:"exit_code"`
	Output     string   `json:"output"`
	Truncated  bool     `json:"truncated"`
	Error      string   `json:"error,omitempty"`
}

func pathArgs(paths []string) []string {
	if len(paths) == 0 {
		return nil
	}
	return append([]string{"--"}, paths...)
}

// isSafeGitRef rejects anything that isn't a plain branch/tag/sha-ish name.
// Revision expressions can name arbitrary objects and, more to the point,
// a leading dash would be read by git as an option.
func isSafeGitRef(ref string) bool {
	if ref == "" || strings.HasPrefix(ref, "-") || len(ref) > 200 {
		return false
	}
	for _, r := range ref {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '/', r == '.', r == '_', r == '-':
		default:
			return false
		}
	}
	// ".." would turn a ref into a range, and a trailing "." is never a
	// real ref name.
	return !strings.Contains(ref, "..")
}

// gitCommandLineFor renders a call the way a user would have typed it. This
// is what the approval card shows and what the command allowlist matches,
// so "git status" on the allowlist auto-runs the tool's status subcommand
// exactly as it auto-runs a shell `git status`. One allowlist, one matching
// rule, whichever tool the model reached for.
//
// A closure over ws, not a free function, because push (unlike every other
// subcommand) needs to resolve live repo state -- the current branch, the
// configured remote -- to render anything more useful than "git push".
func gitCommandLineFor(ws *workspace.Workspace) func(json.RawMessage) string {
	return func(raw json.RawMessage) string {
		var in gitInput
		if err := json.Unmarshal(raw, &in); err != nil || in.Subcommand == "" {
			return "git"
		}
		if in.Subcommand == "push" {
			return gitPushCommandLine(ws, in)
		}
		spec, ok := gitSubcommands[in.Subcommand]
		if !ok {
			return "git " + in.Subcommand
		}
		argv, err := spec.args(in)
		if err != nil {
			return "git " + in.Subcommand
		}
		quoted := make([]string, len(argv))
		for i, a := range argv {
			quoted[i] = quoteArg(a)
		}
		return "git " + strings.Join(quoted, " ")
	}
}

// gitPushCommandLine renders push's approval-card line: "git push origin
// <branch>" (+ " --force"), or a bare fallback if the branch/remote cannot
// be resolved yet (e.g. no origin configured) -- this must never fail the
// approval flow itself, only degrade what it shows.
func gitPushCommandLine(ws *workspace.Workspace, in gitInput) string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	argv, _, err := buildPushArgv(ctx, ws, in)
	if err != nil {
		if in.Force {
			return "git push --force"
		}
		return "git push"
	}
	quoted := make([]string, len(argv))
	for i, a := range argv {
		quoted[i] = quoteArg(a)
	}
	return "git " + strings.Join(quoted, " ")
}

// quoteArg renders one argv element so the command line reads back as the
// single word it is -- a commit message with a space in it must not look
// like two arguments, either to the user reading the approval card or to
// the allowlist matcher tokenizing it.
func quoteArg(s string) string {
	if s == "" {
		return "''"
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '/', r == '.', r == '_', r == '-', r == '=', r == ':', r == ',', r == '+', r == '@':
		default:
			return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
		}
	}
	return s
}

func gitTool(ws *workspace.Workspace) Definition {
	return Definition{
		Name:    NameGit,
		Toolkit: ToolkitFile,
		// Write, for the whole tool, because the definition includes `add`
		// and `commit`. The read-only subcommands are not thereby doomed to
		// prompt forever: they are on the default command allowlist, which
		// CommandLine below is what makes possible.
		Risk:        RiskWrite,
		CommandLine: gitCommandLineFor(ws),
		AlwaysAsk:   gitAlwaysAsk,
		Description: "Run git in the workspace: status, diff, log, show, add, commit, push. " +
			"push always resolves and targets the current branch -- you cannot name a different " +
			"one -- and always asks for approval, even in auto mode; force requires the force " +
			"input explicitly and asks every time regardless. " +
			"History-rewriting subcommands (pull/reset/rebase/checkout) are " +
			"not available here -- use the shell for those so the exact command is visible.",
		ParametersSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"subcommand": {
					"type": "string",
					"enum": ["status", "diff", "log", "show", "add", "commit", "push"],
					"description": "Which git subcommand to run."
				},
				"paths": {
					"type": "array",
					"items": {"type": "string"},
					"description": "Workspace-relative paths. Required for add; narrows diff and log."
				},
				"message": {"type": "string", "description": "Commit message. Required for commit."},
				"ref": {"type": "string", "description": "Revision for show. Defaults to HEAD."},
				"staged": {"type": "boolean", "description": "diff: show staged changes instead of unstaged."},
				"max_count": {"type": "integer", "description": "log: how many commits (default 20, max 100)."},
				"force": {
					"type": "boolean",
					"description": "push only: force-push. Always asks for approval regardless of mode; use only when you mean it."
				}
			},
			"required": ["subcommand"],
			"additionalProperties": false
		}`),
		Execute: func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in gitInput
			if err := json.Unmarshal(raw, &in); err != nil {
				return nil, fmt.Errorf("git: %w", err)
			}

			var argv []string
			if in.Subcommand == "push" {
				// Special-cased rather than going through gitSubcommands:
				// push is the one subcommand whose argv depends on
				// resolving live repo state (the current branch, the
				// configured remote) via its own git subprocess calls,
				// which the args-building table's pure func(gitInput)
				// signature has no way to do. Every other subcommand keeps
				// using that table unchanged.
				resolved, _, buildErr := buildPushArgv(ctx, ws, in)
				if buildErr != nil {
					return nil, buildErr
				}
				argv = resolved
			} else {
				spec, ok := gitSubcommands[in.Subcommand]
				if !ok {
					return nil, fmt.Errorf("git: unsupported subcommand %q -- available: add, commit, diff, log, show, status, push", in.Subcommand)
				}

				// Every path the model named is resolved through the
				// workspace before git ever sees it. Without this,
				// `git add ../../..` stages files outside the root, and the
				// containment the file tools enforce would have a
				// git-shaped hole next to it.
				for i, p := range in.Paths {
					abs, err := ws.Resolve(p)
					if err != nil {
						return nil, err
					}
					rel, err := ws.Rel(abs)
					if err != nil {
						return nil, err
					}
					in.Paths[i] = rel
				}

				built, err := spec.args(in)
				if err != nil {
					return nil, err
				}
				argv = built
			}

			execCtx, cancel := context.WithTimeout(ctx, gitTimeout)
			defer cancel()

			cmd := exec.CommandContext(execCtx, "git", argv...)
			cmd.Dir = ws.Root()
			// A git subprocess that decides to ask for a password or open
			// $EDITOR would hang until the timeout with nobody to answer it.
			cmd.Env = append(cmd.Environ(),
				"GIT_TERMINAL_PROMPT=0",
				"GIT_PAGER=cat",
				"GIT_EDITOR=true",
			)

			var buf bytes.Buffer
			cmd.Stdout = &buf
			cmd.Stderr = &buf
			runErr := cmd.Run()

			out := GitOutput{
				Subcommand: in.Subcommand,
				Command:    "git " + strings.Join(argv, " "),
				Paths:      in.Paths,
				Output:     buf.String(),
			}
			if runErr != nil {
				var exitErr *exec.ExitError
				if errors.As(runErr, &exitErr) {
					out.ExitCode = exitErr.ExitCode()
				} else {
					out.ExitCode = 1
					out.Error = runErr.Error()
				}
			}
			if execCtx.Err() == context.DeadlineExceeded {
				out.Error = fmt.Sprintf("git timed out after %s", gitTimeout)
			}
			if len(out.Output) > gitMaxOutputChars {
				// Keep the head, not the tail: git's useful part (the
				// summary, the first hunks) is at the top, unlike a build
				// log where the error is at the bottom.
				out.Output = out.Output[:gitMaxOutputChars]
				out.Truncated = true
			}
			return out, nil
		},
	}
}
