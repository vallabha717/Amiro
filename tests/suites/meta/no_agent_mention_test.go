package meta_test

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"testing"

	"amiro/tests/harness"
)

// mentionTypeUnionSource names one file and the byte range within it that
// declares the chat mention-type union, so the guard below scans exactly
// that union rather than the whole file (which legitimately says "agent"
// elsewhere -- design-doc comments, decision records, the harness's own
// deprecation tests -- none of which is a live mention type).
type mentionTypeUnionSource struct {
	label      string
	relPath    string
	start, end *regexp.Regexp
}

var mentionTypeUnionSources = []mentionTypeUnionSource{
	{
		label:   "Go wire type (backend-go/internal/api/chat/route.go)",
		relPath: filepath.Join("backend-go", "internal", "api", "chat", "route.go"),
		start:   regexp.MustCompile(`type mentionDTO struct \{`),
		end:     regexp.MustCompile(`\n\}`),
	},
	{
		label:   "TS schema (src/types/chat.ts)",
		relPath: filepath.Join("src", "types", "chat.ts"),
		start:   regexp.MustCompile(`ChatMentionSchema = z\.discriminatedUnion\("type", \[`),
		end:     regexp.MustCompile(`\n\]\);`),
	},
	{
		label:   "TUI mention kinds (backend-go/internal/tui/component/editor/mention.go)",
		relPath: filepath.Join("backend-go", "internal", "tui", "component", "editor", "mention.go"),
		start:   regexp.MustCompile(`type MentionKind string\n\nconst \(`),
		end:     regexp.MustCompile(`\n\)`),
	},
}

// agentLiteralPattern matches "agent" as a quoted string value -- the shape
// a mention-type literal takes in all three languages here (Go string
// const, TS z.literal, Go struct tag) -- not the bare word, which would
// also match unrelated prose if this scanned whole files instead of just
// the union declarations above.
var agentLiteralPattern = regexp.MustCompile(`"agent"`)

// extractUnion returns the text between the first match of start and the
// first match of end that follows it, or an error naming which boundary it
// could not find -- so a failure here reads as "the file's shape changed
// out from under the guard," not a silent false pass.
func extractUnion(src string, u mentionTypeUnionSource) (string, error) {
	startLoc := u.start.FindStringIndex(src)
	if startLoc == nil {
		return "", fmt.Errorf("start pattern %q not found", u.start.String())
	}
	rest := src[startLoc[1]:]
	endLoc := u.end.FindStringIndex(rest)
	if endLoc == nil {
		return "", fmt.Errorf("end pattern %q not found after the start match", u.end.String())
	}
	return rest[:endLoc[0]], nil
}

// TestNoAgentMentionType is Phase 6's (docs/skills/) closing guard: the
// invariant this phase creates is that "agent" is no longer one of the
// values a chat mention's `type` field can carry, on any of the three
// surfaces that declare the union independently (Go's wire struct, the TS
// zod schema, and the TUI's own mention-kind enum). A later feature
// re-adding an "agent" mention type without reading this file would fail
// here first.
func TestNoAgentMentionType(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))
	repoRoot := filepath.Join(h.BaseDir, "..")

	for _, u := range mentionTypeUnionSources {
		t.Run(u.label, func(t *testing.T) {
			path := filepath.Join(repoRoot, u.relPath)
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("reading %s: %v", path, err)
			}
			union, err := extractUnion(string(data), u)
			if err != nil {
				t.Fatalf("%s: %v", u.relPath, err)
			}
			if agentLiteralPattern.MatchString(union) {
				t.Fatalf("%s: found \"agent\" inside the mention-type union:\n%s", u.relPath, union)
			}
		})
	}
}

// TestNoAgentMentionType_IsNonVacuous proves extractUnion and the pattern
// actually catch a reintroduced "agent" literal, against synthetic source
// text shaped like each of the three real files -- not the real files
// (which is what TestNoAgentMentionType itself checks).
func TestNoAgentMentionType_IsNonVacuous(t *testing.T) {
	cases := []struct {
		name   string
		source mentionTypeUnionSource
		clean  string
		dirty  string
	}{
		{
			name:   "Go wire type",
			source: mentionTypeUnionSources[0],
			clean: `type mentionDTO struct {
	Type       string ` + "`json:\"type\"`" + `
	Name       string ` + "`json:\"name\"`" + `
}
`,
			dirty: `type mentionDTO struct {
	Type       string ` + "`json:\"type\"`" + `
	Name       string ` + "`json:\"name\"`" + `
	AgentID    string ` + "`json:\"agentId,omitempty\"`" + ` // "agent" reintroduced
}
`,
		},
		{
			name:   "TS schema",
			source: mentionTypeUnionSources[1],
			clean: `ChatMentionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("workflow") }),
]);
`,
			dirty: `ChatMentionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("workflow") }),
  z.object({ type: z.literal("agent") }),
]);
`,
		},
		{
			name:   "TUI mention kinds",
			source: mentionTypeUnionSources[2],
			clean: `type MentionKind string

const (
	MentionWorkflow MentionKind = "workflow"
)
`,
			dirty: `type MentionKind string

const (
	MentionAgent    MentionKind = "agent"
	MentionWorkflow MentionKind = "workflow"
)
`,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cleanUnion, err := extractUnion(tc.clean, tc.source)
			if err != nil {
				t.Fatalf("extractUnion(clean): %v", err)
			}
			if agentLiteralPattern.MatchString(cleanUnion) {
				t.Fatalf("clean fixture already matches the agent pattern -- fixture is wrong")
			}

			dirtyUnion, err := extractUnion(tc.dirty, tc.source)
			if err != nil {
				t.Fatalf("extractUnion(dirty): %v", err)
			}
			if !agentLiteralPattern.MatchString(dirtyUnion) {
				t.Fatalf("dirty fixture with a reintroduced agent literal was not caught")
			}
		})
	}
}
