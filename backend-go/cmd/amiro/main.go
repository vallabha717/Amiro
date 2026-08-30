// Command amiro is the terminal client -- a CLIENT of the same backend the
// desktop app runs (docs/tui-implementation-plan.md §2.2), never a second
// in-process caller of the agent loop, with one deliberate exception:
// `amiro run` (Phase 6) calls chat.RunTurn directly, the same in-process
// path the evaluation harness uses, because a one-shot headless invocation
// genuinely has no client to be one of. `amiro` with no subcommand launches
// the chat TUI; `amiro auth` manages the session it authenticates with.
package main

import (
	"fmt"
	"os"
)

func main() {
	args := os.Args[1:]

	var cmd string
	if len(args) > 0 && !isFlag(args[0]) {
		cmd = args[0]
		args = args[1:]
	}

	var err error
	switch cmd {
	case "", "chat":
		err = runTUI(args)
	case "run":
		err = runHeadless(args)
	case "serve":
		err = runServe(args)
	case "auth":
		err = runAuth(args)
	case "version":
		printVersion()
	case "help", "-h", "--help":
		printUsage()
	default:
		fmt.Fprintf(os.Stderr, "amiro: unknown command %q\n\n", cmd)
		printUsage()
		os.Exit(1)
	}

	if err != nil {
		fmt.Fprintln(os.Stderr, "amiro: "+err.Error())
		os.Exit(1)
	}
}

func isFlag(s string) bool {
	return len(s) > 0 && s[0] == '-'
}

func printUsage() {
	fmt.Print(`amiro -- terminal client for Amiro

Usage:
  amiro [flags]               start the chat TUI (attach-or-embed)
  amiro run "<prompt>"        run one turn headlessly and exit -- no TUI, no server
  amiro serve                 serve the web dashboard and API, no TUI
  amiro auth login            sign in and store a session
  amiro auth logout           forget the stored session
  amiro auth whoami           show who is signed in
  amiro version               print the build version

Flags (amiro / amiro run):
  -C dir             run as though launched from dir (default: current directory)
  --mode MODE        permission mode: plan, interactive, edit, or auto (default: interactive)
  --model M          provider/model to use, e.g. anthropic/claude-sonnet-5
  --thread ID        resume an existing thread by id, instead of starting a new one
  --connect URL      (amiro only) attach explicitly to the server at URL, bypassing
                     attach-or-embed discovery entirely -- a running desktop sidecar,
                     or another machine (requires --token; amiro will not guess or
                     fabricate an identity for a server it does not own)
  --token TOK        (amiro only) the server's shared secret, required with --connect

Flags (amiro serve, and amiro --serve):
  --serve            (amiro only) run the TUI *and* serve the dashboard off
                     the same embedded backend
  --host HOST        interface to bind (default 127.0.0.1). 0.0.0.0 makes the
                     dashboard reachable from every host on the network --
                     Amiro runs shell commands and reads files, so only do
                     this on a network you trust
  --port PORT        port to bind (default 0, meaning pick a free one)
  --ui-dir DIR       serve the dashboard from DIR instead of the bundle
                     compiled into this binary (a "next build" export)
  --no-ui            (amiro serve only) serve the API without the dashboard.
                     Callers must then send the shared secret on every
                     request, exactly as the desktop sidecar requires --
                     the header is only relaxed for a page this server
                     itself delivered
  --open             (amiro serve only) open the dashboard in a browser
  --allow-origin O   extra origin allowed to call the API cross-origin;
                     repeatable. The served dashboard is same-origin and
                     never needs this

Flags (amiro run only):
  --json             print the turn's result -- text, usage, the full session log --
                     as one JSON object on stdout, instead of streaming text
  --yes              auto-approve every gated tool call; without it, a gated call
                     suspends the turn (exit 2) since there is no one to ask headlessly

amiro run's exit code: 0 the turn completed, 1 it failed, 2 it suspended on
an approval nobody headless can give -- rerun with --yes.

Defaults for --mode and --model can also be set in .amiro/config.yaml
(project) or ~/.config/amiro/config.yaml (user) as defaultMode/defaultModel
-- see docs/tui-implementation-plan.md §2.8 for the full precedence order.

In the TUI, "/" opens the command palette: /mode, /threads, /models,
/settings, /compact, /export, /skills. "@" completes MCP tools, workflows
and Amiro's own tools. ctrl+t and ctrl+o open the thread switcher and model
picker directly.
`)
}
