package tools

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"amiro/backend/internal/skills"
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
	// 2 named tools + alwaysOffered (propose_plan, walkthrough)
	if len(got) != 4 {
		t.Fatalf("got %d tools, want 4: %+v", len(got), got)
	}
	names := map[string]bool{}
	for _, d := range got {
		names[d.Name] = true
	}
	if !names[NameCreatePieChart] || !names[NameHttp] || !names[NameProposePlan] || !names[NameWalkthrough] {
		t.Fatalf("got %+v, want createPieChart, http, and exempt todo tools", names)
	}
}

func TestFilter_SkillToolSurvivesExplicitAllowlistThatDoesNotNameIt(t *testing.T) {
	discovered := []skills.Skill{{Name: "code-review", Description: "Reviews code", Path: "/skills/cr"}}
	defs := Defaults(Deps{DiscoveredSkills: discovered})
	allowed := []string{ToolkitVisualization}
	got := Filter(defs, &allowed, nil)
	sk, ok := FindByName(got, NameSkill)
	if !ok {
		t.Fatalf("skill tool was dropped by explicit allowlist %+v", allowed)
	}
	if sk.Toolkit != ToolkitSkill {
		t.Fatalf("got toolkit %q, want %q", sk.Toolkit, ToolkitSkill)
	}
}

func TestFilter_SkillToolSurvivesDefaultToolNamesBranch(t *testing.T) {
	ws, _ := testWorkspace(t)
	discovered := []skills.Skill{{Name: "code-review", Description: "Reviews code", Path: "/skills/cr"}}
	defs := Defaults(Deps{Workspace: ws, DiscoveredSkills: discovered})
	empty := []string{}
	got := Filter(defs, &empty, []string{NameReadFile})
	if _, ok := FindByName(got, NameSkill); !ok {
		t.Fatalf("skill tool was dropped by defaultToolNames branch")
	}
	if _, ok := FindByName(got, NameReadFile); !ok {
		t.Fatalf("read_file was not returned by defaultToolNames branch")
	}
}

func TestSkillTool_ExecutionFrontmatterStrippedAndDedup(t *testing.T) {
	activated := NewActivationSet()
	var activatedDirs []string
	discovered := []skills.Skill{
		{
			Name:        "code-review",
			Description: "Reviews code.",
			Path:        "/home/u/.agents/skills/code-review",
			RealPath:    "/home/u/.agents/skills/code-review",
			Body:        "# Code Review Instructions\nFollow these guidelines.",
			Resources:   []string{"references/checklist.md", "scripts/diffstat.sh"},
		},
	}

	d, ok := FindByName(Defaults(Deps{
		DiscoveredSkills: discovered,
		ActivatedSkills:  activated,
		OnActivateSkill: func(s *skills.Skill) {
			activatedDirs = append(activatedDirs, s.Path)
		},
	}), NameSkill)
	if !ok {
		t.Fatal("skill tool not in Defaults when discovered skills present")
	}

	if d.Risk != RiskRead {
		t.Errorf("got Risk %v, want RiskRead", d.Risk)
	}

	// First execution
	input, _ := json.Marshal(map[string]any{"name": "code-review"})
	out, err := d.Execute(context.Background(), input)
	if err != nil {
		t.Fatalf("Execute error: %v", err)
	}
	content, ok := out.(string)
	if !ok {
		t.Fatalf("got %T, want string", out)
	}
	if !strings.Contains(content, `<skill_content name="code-review">`) {
		t.Errorf("missing <skill_content> tag in output:\n%s", content)
	}
	if !strings.Contains(content, "Skill directory: /home/u/.agents/skills/code-review") {
		t.Errorf("missing skill directory in output:\n%s", content)
	}
	if !strings.Contains(content, "<file>references/checklist.md</file>") {
		t.Errorf("missing resource in output:\n%s", content)
	}
	if len(activatedDirs) != 1 || activatedDirs[0] != "/home/u/.agents/skills/code-review" {
		t.Errorf("OnActivateSkill not called with expected dir, got %v", activatedDirs)
	}

	// Second execution in same turn -> returns already active notice
	out2, err := d.Execute(context.Background(), input)
	if err != nil {
		t.Fatalf("Execute second activation error: %v", err)
	}
	content2, ok := out2.(string)
	if !ok || !strings.Contains(content2, "already active") {
		t.Fatalf("second activation output = %q, want 'already active'", content2)
	}
}

func TestSkillTool_MentionAndModelActivation_BundledResourceReadable(t *testing.T) {
	ws, _ := testWorkspace(t)
	mentionedSkillDir := t.TempDir()
	modelSkillDir := t.TempDir()

	refFile := filepath.Join(modelSkillDir, "references", "x.md")
	if err := os.MkdirAll(filepath.Dir(refFile), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(refFile, []byte("# X content"), 0o644); err != nil {
		t.Fatal(err)
	}

	deps := Deps{
		Workspace:        ws,
		ReadOnlyRoots:    []string{mentionedSkillDir}, // from a skill mention
		ActivatedSkills:  NewActivationSet(),
		DiscoveredSkills: []skills.Skill{{Name: "b", Description: "d", Path: modelSkillDir, Body: "body"}},
		OnActivateSkill:  func(s *skills.Skill) { ws.AddReadOnlyRoots(s.Path) },
	}
	defs := Filter(Defaults(deps), nil, nil)

	// Activate "b" through the skill tool
	skTool, ok := FindByName(defs, NameSkill)
	if !ok {
		t.Fatal("skill tool not found in defs")
	}
	input, _ := json.Marshal(map[string]any{"name": "b"})
	if _, err := skTool.Execute(context.Background(), input); err != nil {
		t.Fatalf("activating skill b: %v", err)
	}

	// Read modelSkillDir/references/x.md through read_file -- must succeed!
	readFileTool, ok := FindByName(defs, NameReadFile)
	if !ok {
		t.Fatal("read_file tool not found in defs")
	}
	readInput, _ := json.Marshal(map[string]any{"path": refFile})
	out, err := readFileTool.Execute(context.Background(), readInput)
	if err != nil {
		t.Fatalf("read_file of activated skill bundled resource failed: %v", err)
	}
	res, ok := out.(ReadFileOutput)
	if !ok {
		t.Fatalf("expected ReadFileOutput, got %T", out)
	}
	if !strings.Contains(res.Content, "# X content") {
		t.Fatalf("expected content '# X content', got %q", res.Content)
	}
}

func TestSkillTool_ConcurrentActivation_Race(t *testing.T) {
	ws, _ := testWorkspace(t)
	s1Dir := t.TempDir()
	s2Dir := t.TempDir()

	actSet := NewActivationSet()
	deps := Deps{
		Workspace:       ws,
		ActivatedSkills: actSet,
		DiscoveredSkills: []skills.Skill{
			{Name: "skill-1", Description: "d1", Path: s1Dir, Body: "b1"},
			{Name: "skill-2", Description: "d2", Path: s2Dir, Body: "b2"},
		},
		OnActivateSkill: func(s *skills.Skill) { ws.AddReadOnlyRoots(s.Path) },
	}
	defs := Defaults(deps)
	skTool, ok := FindByName(defs, NameSkill)
	if !ok {
		t.Fatal("skill tool not found")
	}

	done := make(chan struct{})
	go func() {
		for i := 0; i < 100; i++ {
			raw1, _ := json.Marshal(map[string]any{"name": "skill-1"})
			_, _ = skTool.Execute(context.Background(), raw1)
		}
		close(done)
	}()

	for i := 0; i < 100; i++ {
		raw2, _ := json.Marshal(map[string]any{"name": "skill-2"})
		_, _ = skTool.Execute(context.Background(), raw2)
	}
	<-done
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
		if got := gitCommandLineFor(nil)(raw); got != tc.want {
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
