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

// gitCommandLine renders a call the way a user would have typed it. This is
// what the approval card shows and what the command allowlist matches, so
// "git status" on the allowlist auto-runs the tool's status subcommand
// exactly as it auto-runs a shell `git status`. One allowlist, one matching
// rule, whichever tool the model reached for.
func gitCommandLine(raw json.RawMessage) string {
	var in gitInput
	if err := json.Unmarshal(raw, &in); err != nil || in.Subcommand == "" {
		return "git"
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
		CommandLine: gitCommandLine,
		Description: "Run git in the workspace: status, diff, log, show, add, commit. " +
			"Network and history-rewriting subcommands (push/pull/reset/rebase/checkout) are " +
			"not available here -- use the shell for those so the exact command is visible.",
		ParametersSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"subcommand": {
					"type": "string",
					"enum": ["status", "diff", "log", "show", "add", "commit"],
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
				"max_count": {"type": "integer", "description": "log: how many commits (default 20, max 100)."}
			},
			"required": ["subcommand"],
			"additionalProperties": false
		}`),
		Execute: func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in gitInput
			if err := json.Unmarshal(raw, &in); err != nil {
				return nil, fmt.Errorf("git: %w", err)
			}
			spec, ok := gitSubcommands[in.Subcommand]
			if !ok {
				return nil, fmt.Errorf("git: unsupported subcommand %q -- available: add, commit, diff, log, show, status", in.Subcommand)
			}

			// Every path the model named is resolved through the workspace
			// before git ever sees it. Without this, `git add ../../..`
			// stages files outside the root, and the containment the file
			// tools enforce would have a git-shaped hole next to it.
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

			argv, err := spec.args(in)
			if err != nil {
				return nil, err
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
