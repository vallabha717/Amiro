package main

import (
	"context"
	"flag"
	"fmt"
	"os/signal"
	"syscall"

	"amiro/tests/harness/fakeprovider"
)

// cmdInternalFakeProvider runs a fakeprovider.Server as its own detached
// process rather than an in-process httptest.Server.
//
// `harness.Fake()` (used by every Go suite) works because the fake server
// and the test that configured it live in the same process for the test's
// whole life. `amirotest backend start` cannot do that: it prints its JSON
// and calls os.Exit almost immediately, while the backend it spawned (a
// separate OS process, its own PID) keeps running for the rest of a UI
// test. A fake provider seeded as that backend's OpenAI/Anthropic base URL
// has to outlive the CLI invocation the same way, so it is spawned here
// as its own process -- see cmdBackendStart's startFakeProvider.
//
// Not listed in `amirotest help`: it is plumbing `backend start` spawns
// for itself, not something a person runs directly.
func cmdInternalFakeProvider(args []string) int {
	fs := flag.NewFlagSet("internal-fakeprovider", flag.ContinueOnError)
	reply := fs.String("reply", "This is Amiro's fake test provider, replying automatically for automated tests.", "canned assistant reply text for every prompt")
	// toolCallName/toolCallArgs let a UI spec exercise a real tool-call-
	// bearing turn (docs/coding-agent-parity/phases/phase-01-checkpoints-and-rewind.md's
	// "Rewind to here" needs an actual write_file call to have happened)
	// the same way a Go suite's harness.WithFake(...).ToolCall(...) already
	// can -- Playwright specs have no in-process fake server to script
	// directly, since this process outlives the CLI invocation that
	// started it (see this file's own doc comment).
	toolCallName := fs.String("tool-call-name", "", "if set, emit this tool call before streaming reply, for every prompt")
	toolCallArgs := fs.String("tool-call-args", "{}", "JSON arguments for --tool-call-name")
	if err := fs.Parse(args); err != nil {
		return exitConfig
	}

	fp := fakeprovider.New()
	if *toolCallName != "" {
		fp.OnAny().ToolCall(*toolCallName, *toolCallArgs).ThenStreamText(*reply)
	} else {
		fp.OnAny().StreamText(*reply)
	}
	defer fp.Close()

	fmt.Printf("URL=%s\n", fp.URL)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	<-ctx.Done()
	return exitOK
}
