package toolcard

import (
	"encoding/json"
	"fmt"

	"amiro/backend/internal/tui/session"
	"amiro/backend/internal/tui/theme"
)

// gitInput mirrors internal/ai/tools' gitInput -- the fields this card
// reads off a pending or completed git call.
type gitInput struct {
	Subcommand string `json:"subcommand"`
	Message    string `json:"message,omitempty"`
	Force      bool   `json:"force,omitempty"`
}

// gitOutput mirrors internal/ai/tools' GitOutput.
type gitOutput struct {
	Subcommand string   `json:"subcommand"`
	Command    string   `json:"command"`
	Paths      []string `json:"paths,omitempty"`
	ExitCode   int      `json:"exit_code"`
	Output     string   `json:"output"`
}

// renderGit covers every git subcommand, including push -- the phase's own
// "approving a push shows branch and remote" is exactly out.Command, which
// git.go builds as "git push origin <branch>" (+ " --force"), so this card
// needs no branch/remote-specific fields of its own.
func renderGit(width int, call session.ToolCall) string {
	var in gitInput
	_ = json.Unmarshal(call.Input, &in)

	command := "git " + in.Subcommand
	effective := call.Status

	var body string
	switch call.Status {
	case session.ToolAwaitingApproval:
		// The approval card is exactly where a force push most needs to
		// read plainly -- this is the one place a user decides whether to
		// let it run at all.
		if in.Subcommand == "push" && in.Force {
			body = theme.Default.Error.Render("force push -- this can overwrite another party's commits")
		}
	case session.ToolError:
		body = theme.Default.Error.Render(errorOrDefault(call.ErrorText))
	case session.ToolDone:
		var out gitOutput
		_ = json.Unmarshal(call.Output, &out)
		if out.Command != "" {
			command = out.Command
		}
		if out.ExitCode != 0 {
			effective = session.ToolError
		}
		body = fmt.Sprintf("(exit %d)", out.ExitCode)
		if tail := tailLines(out.Output, maxShellOutputLines); tail != "" {
			body += "\n" + tail
		}
	}

	title := command + statusSuffix(call.Status)
	return card(width, statusBorder(effective), title, body)
}

// createPRInput mirrors internal/ai/tools' createPRInput.
type createPRInput struct {
	Base  string `json:"base"`
	Draft bool   `json:"draft,omitempty"`
}

// createPROutput mirrors internal/ai/tools' CreatePROutput.
type createPROutput struct {
	Owner  string `json:"owner"`
	Repo   string `json:"repo"`
	Head   string `json:"head"`
	Base   string `json:"base"`
	Title  string `json:"title"`
	Body   string `json:"body"`
	URL    string `json:"url,omitempty"`
	Number int    `json:"number,omitempty"`
	Error  string `json:"error,omitempty"`
}

// renderCreatePR shows exactly what the design doc's approval-card rule
// asks for: the PR title and the first lines of the walkthrough-derived
// body -- never a raw JSON argument blob.
func renderCreatePR(width int, call session.ToolCall) string {
	var in createPRInput
	_ = json.Unmarshal(call.Input, &in)

	base := in.Base
	title := "create_pr"

	var body string
	switch call.Status {
	case session.ToolError:
		body = theme.Default.Error.Render(errorOrDefault(call.ErrorText))
	case session.ToolAwaitingApproval, session.ToolDone:
		var out createPROutput
		_ = json.Unmarshal(call.Output, &out)
		if out.Base != "" {
			base = out.Base
		}
		head := pathOr(out.Head, "current branch")
		title = fmt.Sprintf("create_pr: %s -> %s", head, pathOr(base, "?"))
		if out.Title != "" {
			body = out.Title
		}
		if out.Error != "" {
			body = theme.Default.Error.Render(out.Error)
		} else if out.URL != "" {
			body += fmt.Sprintf("\n%s", out.URL)
		} else if bodyPreview := firstLine(out.Body, 100); bodyPreview != "" {
			body += "\n" + bodyPreview
		}
	}
	if title == "create_pr" && base != "" {
		title = "create_pr -> " + base
	}

	return card(width, statusBorder(call.Status), title+statusSuffix(call.Status), body)
}
