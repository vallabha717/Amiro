package editor

import "testing"

func TestSuggest_FiltersByPrefixWhileTypingTheCommandName(t *testing.T) {
	if got := Suggest("hello"); got != nil {
		t.Fatalf("Suggest(%q) = %v, want nil for text that isn't a slash command", "hello", got)
	}
	if got := Suggest("/"); len(got) != len(Commands) {
		t.Fatalf("Suggest(\"/\") = %d matches, want all %d commands", len(got), len(Commands))
	}
	if got := Suggest("/thre"); len(got) != 1 || got[0].Name != "threads" {
		t.Fatalf("Suggest(\"/thre\") = %+v, want just {threads}", got)
	}
	if got := Suggest("/zz"); len(got) != 0 {
		t.Fatalf("Suggest(\"/zz\") = %+v, want no matches", got)
	}
}

func TestSuggest_StopsOnceArgumentsStart(t *testing.T) {
	// Once there's a space, the user is typing arguments, not still
	// choosing a command -- the palette should get out of the way.
	if got := Suggest("/mode plan"); got != nil {
		t.Fatalf("Suggest(\"/mode plan\") = %v, want nil once the command name is followed by a space", got)
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
	matches := Suggest("/")
	for _, w := range []int{0, 1, 5, 80} {
		_ = RenderSuggestions(w, matches, 0)
	}
}
