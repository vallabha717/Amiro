package tools

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDefaults_ReturnsThirteenToolsAcrossFiveToolkits(t *testing.T) {
	defs := Defaults(Deps{})
	if len(defs) != 13 {
		t.Fatalf("got %d tools, want 13 (4 visualization + 1 http + 2 webSearch + 4 terminal + 2 todo), defs: %+v", len(defs), defs)
	}
	byToolkit := map[string]int{}
	for _, d := range defs {
		byToolkit[d.Toolkit]++
	}
	// The two `todo` entries here are propose_plan and walkthrough, which
	// need no session store and so exist even for an empty Deps. todo_write
	// and todo_read do need one, and are absent from this count.
	want := map[string]int{ToolkitVisualization: 4, ToolkitHttp: 1, ToolkitWebSearch: 2, ToolkitTerminal: 4, ToolkitTodo: 2}
	for k, v := range want {
		if byToolkit[k] != v {
			t.Fatalf("toolkit %q: got %d tools, want %d (%+v)", k, byToolkit[k], v, byToolkit)
		}
	}
}

// propose_plan is the one built-in with no server-side executor, and that is
// the mechanism rather than an oversight: a nil Execute is what makes the
// scheduler leave the call in "input-available", stop the loop, and hand it
// to the browser for a human to answer.
//
// So this test asserts the exception by name. Relaxing it to "some tools may
// have no executor" would let a genuine omission -- a tool that simply
// forgot its implementation -- through, and the symptom of that is a turn
// that hangs forever waiting for an answer nobody will send.
func TestDefaults_EveryToolHasExecuteExceptProposePlan(t *testing.T) {
	defs := Defaults(Deps{})
	for _, d := range defs {
		if d.Name == NameProposePlan {
			if d.Execute != nil {
				t.Fatalf("%s has an executor; the nil one is what suspends the turn for the user", d.Name)
			}
			continue
		}
		if d.Execute == nil {
			t.Fatalf("tool %q (toolkit %q): got nil Execute, want non-nil", d.Name, d.Toolkit)
		}
	}
}

func TestTerminalExecute_RunsEchoCommand(t *testing.T) {
	defs := Defaults(Deps{})
	d, ok := FindByName(defs, NameTerminalExecution)
	if !ok {
		t.Fatalf("tool %q not found", NameTerminalExecution)
	}
	input, _ := json.Marshal(map[string]any{"command": "echo 'hello amiro'"})
	out, err := d.Execute(context.Background(), input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	res, ok := out.(terminalOutput)
	if !ok {
		t.Fatalf("got %T, want terminalOutput", out)
	}
	if !strings.Contains(res.Output, "hello amiro") {
		t.Fatalf("expected output containing 'hello amiro', got %q", res.Output)
	}
	if res.ExitCode != 0 {
		t.Fatalf("expected exit code 0, got %d", res.ExitCode)
	}
}

func TestHttpFetchExecute_MakesRealRequestAndReturnsJSONBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	d, _ := FindByName(Defaults(Deps{}), NameHttp)
	input, _ := json.Marshal(map[string]any{"url": srv.URL, "method": "POST", "body": "{}"})
	out, err := d.Execute(context.Background(), input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	result, ok := out.(httpFetchOutput)
	if !ok {
		t.Fatalf("got %T, want httpFetchOutput", out)
	}
	if result.Status != 201 || !result.OK {
		t.Fatalf("got status=%d ok=%v, want 201/true", result.Status, result.OK)
	}
}

func TestFilter_NilAllowedToolkitsReturnsEverything(t *testing.T) {
	defs := Defaults(Deps{})
	got := Filter(defs, nil, nil)
	if len(got) != len(defs) {
		t.Fatalf("got %d tools, want all %d", len(got), len(defs))
	}
}

// "None" means none of the *capabilities*. The plan toolkit survives any
// allowlist by design (alwaysOffered) -- it is how the agent coordinates
// with the user about its own work, not something a user would think to
// switch on. This test used to read "returns none" and passed only because
// an empty Deps has no todo store; propose_plan and walkthrough need no
// store, so the exemption is now visible here and worth asserting directly.
func TestFilter_EmptyAllowedToolkitsReturnsOnlyTheExemptPlanTools(t *testing.T) {
	defs := Defaults(Deps{})
	empty := []string{}
	got := Filter(defs, &empty, nil)
	for _, d := range got {
		if d.Toolkit != ToolkitTodo {
			t.Fatalf("tool %q (toolkit %q) survived an empty allowlist", d.Name, d.Toolkit)
		}
	}
	for _, name := range []string{NameProposePlan, NameWalkthrough} {
		if _, ok := FindByName(got, name); !ok {
			t.Fatalf("%s is exempt from the allowlist but was dropped", name)
		}
	}
}

func TestFilter_SpecificToolkitReturnsItsToolsPlusTheExemptOnes(t *testing.T) {
	defs := Defaults(Deps{})
	allowed := []string{ToolkitVisualization}
	got := Filter(defs, &allowed, nil)
	for _, d := range got {
		if d.Toolkit != ToolkitVisualization && d.Toolkit != ToolkitTodo {
			t.Fatalf("got tool %q from toolkit %q, want only visualization (plus the exempt plan tools)", d.Name, d.Toolkit)
		}
	}
	visualization := 0
	for _, d := range got {
		if d.Toolkit == ToolkitVisualization {
			visualization++
		}
	}
	if visualization != 4 {
		t.Fatalf("got %d visualization tools, want 4", visualization)
	}
}

func TestFilter_DefaultToolNamesTakesPriorityOverToolkits(t *testing.T) {
	defs := Defaults(Deps{})
	empty := []string{} // would select nothing on its own
	got := Filter(defs, &empty, []string{NameCreatePieChart, NameHttp})
	if len(got) != 2 {
		t.Fatalf("got %d tools, want 2: %+v", len(got), got)
	}
	names := map[string]bool{}
	for _, d := range got {
		names[d.Name] = true
	}
	if !names[NameCreatePieChart] || !names[NameHttp] {
		t.Fatalf("got %+v, want createPieChart and http", names)
	}
}

func TestFindByName_UnknownNameReturnsFalse(t *testing.T) {
	if _, ok := FindByName(Defaults(Deps{}), "does-not-exist"); ok {
		t.Fatal("got ok=true for unknown tool name")
	}
}

func TestParametersSchema_EveryToolIsValidJSON(t *testing.T) {
	for _, d := range Defaults(Deps{}) {
		var v any
		if err := json.Unmarshal(d.ParametersSchema, &v); err != nil {
			t.Fatalf("tool %q: ParametersSchema is not valid JSON: %v", d.Name, err)
		}
	}
}

// Risk is the one property everything else derives from -- permission
// gating and parallel scheduling both read it -- and the zero value is the
// restrictive one, so a tool that forgets to declare it does not break, it
// just quietly starts asking for approval and stops running in parallel.
// That is the right failure mode at runtime and the wrong one to discover
// in production, hence this.
func TestDefaults_EveryToolDeclaresRisk(t *testing.T) {
	ws, _ := testWorkspace(t)
	for _, d := range Defaults(Deps{Workspace: ws}) {
		if d.Risk == RiskUnclassified {
			t.Fatalf("tool %q (toolkit %q) declares no Risk", d.Name, d.Toolkit)
		}
	}
}

// The git tool renders itself as a command line so that one allowlist
// covers both it and the shell. If that rendering drifts, `git status`
// silently starts prompting even though it is on the default allowlist.
func TestGitCommandLine_RendersMatchableCommands(t *testing.T) {
	for _, tc := range []struct {
		in   map[string]any
		want string
	}{
		{map[string]any{"subcommand": "status"}, "git status --porcelain=v1 --branch"},
		{map[string]any{"subcommand": "log", "max_count": 5}, "git log -n5 --oneline --no-decorate"},
		{map[string]any{"subcommand": "add", "paths": []string{"a.go", "b.go"}}, "git add -- a.go b.go"},
		{map[string]any{"subcommand": "commit", "message": "fix the thing"}, "git commit -m 'fix the thing'"},
	} {
		raw, _ := json.Marshal(tc.in)
		if got := gitCommandLine(raw); got != tc.want {
			t.Fatalf("gitCommandLine(%v) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestGitTool_RejectsUnknownSubcommands(t *testing.T) {
	ws, _ := testWorkspace(t)
	d, ok := FindByName(Defaults(Deps{Workspace: ws}), NameGit)
	if !ok {
		t.Fatal("git tool not in Defaults")
	}
	// push reaches the network and reset destroys uncommitted work; neither
	// is reachable through this tool by design.
	for _, sub := range []string{"push", "reset", "checkout", "clean", "config"} {
		raw, _ := json.Marshal(map[string]any{"subcommand": sub})
		if _, err := d.Execute(context.Background(), raw); err == nil {
			t.Fatalf("git %s: got nil error, want a refusal", sub)
		}
	}
}
