package editor

import (
	"fmt"
	"strings"
	"testing"
)

func TestSuggest_FiltersByPrefixWhileTypingTheCommandName(t *testing.T) {
	if got := Suggest("hello", nil); got != nil {
		t.Fatalf("Suggest(%q) = %v, want nil for text that isn't a slash command", "hello", got)
	}
	if got := Suggest("/", nil); len(got) != len(Commands) {
		t.Fatalf("Suggest(\"/\") = %d matches, want all %d commands", len(got), len(Commands))
	}
	if got := Suggest("/thre", nil); len(got) != 1 || got[0].Name != "threads" {
		t.Fatalf("Suggest(\"/thre\") = %+v, want just {threads}", got)
	}
	if got := Suggest("/zz", nil); len(got) != 0 {
		t.Fatalf("Suggest(\"/zz\") = %+v, want no matches", got)
	}
}

func TestSuggest_StopsOnceArgumentsStart(t *testing.T) {
	// Once there's a space, the user is typing arguments, not still
	// choosing a command -- the palette should get out of the way.
	if got := Suggest("/mode plan", nil); got != nil {
		t.Fatalf("Suggest(\"/mode plan\") = %v, want nil once the command name is followed by a space", got)
	}
}

func TestSuggest_MatchesBuiltinsFirstThenSkills(t *testing.T) {
	skills := []SkillCommand{
		{Name: "example", Invoke: "example", Description: "an example skill", Source: ".agents", Scope: "project"},
		{Name: "export", Invoke: "skill:export", Description: "shadowed skill", Source: ".claude", Scope: "user"},
		{Name: "echo", Invoke: "echo", Description: "echoes input", Source: ".agents", Scope: "project"},
	}

	// "/e" matches built-in "/export", then skills "/example" and "/echo".
	// "/skill:export" does NOT start with "e", so it is not in the "/e" matches.
	matches := Suggest("/e", skills)
	if len(matches) != 3 {
		t.Fatalf("Suggest(\"/e\") = %d matches, want 3 (export, example, echo)", len(matches))
	}
	if matches[0].Name != "export" || matches[0].IsSkill {
		t.Errorf("matches[0] = %+v, want built-in export", matches[0])
	}
	if matches[1].Name != "example" || !matches[1].IsSkill {
		t.Errorf("matches[1] = %+v, want skill example", matches[1])
	}
	if matches[2].Name != "echo" || !matches[2].IsSkill {
		t.Errorf("matches[2] = %+v, want skill echo", matches[2])
	}

	// "/skill:export" matches the shadowed skill by its Invoke name
	skillMatches := Suggest("/skill:exp", skills)
	if len(skillMatches) != 1 || skillMatches[0].Name != "export" || skillMatches[0].Invoke != "skill:export" {
		t.Fatalf("Suggest(\"/skill:exp\") = %+v, want skill:export", skillMatches)
	}
}

func TestParse_SplitsNameAndArgs(t *testing.T) {
	name, args, ok := Parse("/mode plan")
	if !ok || name != "mode" || args != "plan" {
		t.Fatalf("Parse(\"/mode plan\") = (%q, %q, %v), want (mode, plan, true)", name, args, ok)
	}

	name, args, ok = Parse("/threads")
	if !ok || name != "threads" || args != "" {
		t.Fatalf("Parse(\"/threads\") = (%q, %q, %v), want (threads, \"\", true)", name, args, ok)
	}

	if _, _, ok := Parse("not a command"); ok {
		t.Fatalf("Parse(\"not a command\") ok = true, want false")
	}
}

func TestRenderSuggestions_EmptyForNoMatches(t *testing.T) {
	if got := RenderSuggestions(80, nil, 0); got != "" {
		t.Fatalf("RenderSuggestions with no matches = %q, want empty", got)
	}
}

func TestRenderSuggestions_NeverPanicsAtNarrowWidths(t *testing.T) {
	skills := []SkillCommand{
		{Name: "example", Invoke: "example", Description: "an example skill", Source: ".agents", Scope: "project"},
	}
	matches := Suggest("/", skills)
	for _, w := range []int{0, 1, 5, 80} {
		_ = RenderSuggestions(w, matches, 0)
	}
}

func TestRenderSuggestions_GroupsBuiltinsAndSkillsWithHeading(t *testing.T) {
	skills := []SkillCommand{
		{Name: "example", Invoke: "example", Description: "an example skill", Source: ".agents", Scope: "project"},
	}
	matches := Suggest("/e", skills)
	rendered := RenderSuggestions(80, matches, 0)
	if !strings.Contains(rendered, "/export") {
		t.Errorf("rendered output missing /export:\n%s", rendered)
	}
	if !strings.Contains(rendered, "skills") {
		t.Errorf("rendered output missing 'skills' heading:\n%s", rendered)
	}
	if !strings.Contains(rendered, "/example") {
		t.Errorf("rendered output missing /example:\n%s", rendered)
	}
}

func TestRenderSuggestions_CapsAtMaxRowsWithMoreLine(t *testing.T) {
	var skills []SkillCommand
	for i := 0; i < 40; i++ {
		name := fmt.Sprintf("skill-%02d", i)
		skills = append(skills, SkillCommand{Name: name, Invoke: name, Description: "test skill", Source: ".agents", Scope: "user"})
	}
	matches := Suggest("/", skills)
	rendered := RenderSuggestions(80, matches, 0)
	lines := strings.Split(rendered, "\n")
	// Header + builtins + heading + skills + "+N more" should be well below 40 lines
	if len(lines) > 15 {
		t.Errorf("rendered suggestion lines = %d, want capped (<= 15)", len(lines))
	}
	if !strings.Contains(rendered, "more") {
		t.Errorf("rendered output missing '+N more' line:\n%s", rendered)
	}
}

