package toolcard

import (
	"encoding/json"
	"fmt"

	"amiro/backend/internal/tui/session"
	"amiro/backend/internal/tui/theme"
)

// maxShellOutputLines bounds the command output tail a card shows --
// enough to see whether it worked, not the whole log.
const maxShellOutputLines = 8

type shellInput struct {
	Command string `json:"command"`
}

// shellOutput mirrors internal/ai/tools' terminalOutput -- run_shell's
// output shape.
type shellOutput struct {
	Command  string `json:"command"`
	ExitCode int    `json:"exit_code"`
	Output   string `json:"output"`
	TimedOut bool   `json:"timed_out"`
}

func renderShell(width int, call session.ToolCall) string {
	var in shellInput
	_ = json.Unmarshal(call.Input, &in)
	command := firstLine(in.Command, 72)

	// A command that exits non-zero is not a tool failure (the call itself
	// succeeded: it ran the command and reported what happened), but it is
	// visually the same signal a user is scanning the transcript for --
	// src/components/tool-presenters/shell-presenters.tsx's isError makes
	// the same call, and a red border here is what "the test suite failed"
	// looks like at a glance instead of requiring the exit code be read.
	effective := call.Status

	var body string
	switch call.Status {
	case session.ToolError:
		body = theme.Default.Error.Render(errorOrDefault(call.ErrorText))
	case session.ToolDone:
		var out shellOutput
		_ = json.Unmarshal(call.Output, &out)
		if out.Command != "" {
			command = firstLine(out.Command, 72)
		}
		status := fmt.Sprintf("exit %d", out.ExitCode)
		if out.TimedOut {
			status = "timed out"
		} else if out.ExitCode != 0 {
			effective = session.ToolError
		}
		body = fmt.Sprintf("$ %s  (%s)", command, status)
		if tail := tailLines(out.Output, maxShellOutputLines); tail != "" {
			body += "\n" + tail
		}
	}

	title := "run_shell" + statusSuffix(call.Status)
	return card(width, statusBorder(effective), title, body)
}
