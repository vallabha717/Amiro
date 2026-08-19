package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/ai/tools"
)

// The regression guard for the one thing the EventLog inversion was most
// likely to break: the order and shape of the parts array a turn persists.
//
// Part ordering has already been a live bug in this tree once -- tool parts
// were appended mid-stream and therefore landed *before* the step's text in
// the persisted array even though the client had been shown the text first,
// so reloading a thread reordered it. The inversion re-derives this array from
// a log whose events are appended in a different order again (tool calls are
// recorded at offer time, during the stream; text is recorded after the step
// returns). Nothing but a golden file can prove the output did not move.
//
// Regenerate deliberately, never reflexively:
//
//	UPDATE_GOLDEN=1 go test ./internal/api/chat -run TestToolLoop_PersistedParts
//
// and read the diff. A change here changes how every already-persisted thread
// in every existing database renders.
func TestToolLoop_PersistedPartsGolden(t *testing.T) {
	// A turn that exercises every part producer at once: reasoning, text, two
	// tool calls in one step (so call-order merging is covered), a tool that
	// fails, a second step with more text, and a final step with no calls.
	engine := &fakeStreamEngine{steps: []bifrostai.StepResult{
		{
			Reasoning: "I should look at both files.",
			Text:      "Reading the two files now.",
			ToolCalls: []bifrostai.ToolCall{
				{ID: "c1", Name: tools.NameReadFile, Arguments: `{"path":"a.go"}`},
				{ID: "c2", Name: tools.NameGrep, Arguments: `{"pattern":"x"}`},
			},
		},
		{
			Text: "One of those failed. Trying an edit.",
			ToolCalls: []bifrostai.ToolCall{
				{ID: "c3", Name: tools.NameEditFile, Arguments: `{"path":"a.go"}`},
			},
		},
		{Text: "Done."},
	}}

	defs := []tools.Definition{
		okTool(tools.NameReadFile),
		{Name: tools.NameGrep, Risk: tools.RiskRead,
			Execute: func(context.Context, json.RawMessage) (any, error) {
				return nil, fmt.Errorf("grep: no matches for %q", "x")
			}},
		{Name: tools.NameEditFile, Risk: tools.RiskWrite,
			Execute: func(context.Context, json.RawMessage) (any, error) {
				return map[string]any{"path": "a.go", "added": 3, "removed": 1}, nil
			}},
	}

	res := loopWith(t, engine, defs, testPerms())

	var got bytes.Buffer
	if err := json.Indent(&got, res.Parts, "", "  "); err != nil {
		t.Fatalf("indent parts: %v", err)
	}
	got.WriteString("\n")

	path := filepath.Join("testdata", "persisted_parts.json")
	if os.Getenv("UPDATE_GOLDEN") != "" {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, got.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %s", path)
		return
	}

	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read golden (run with UPDATE_GOLDEN=1 to create): %v", err)
	}
	if !bytes.Equal(bytes.TrimSpace(want), bytes.TrimSpace(got.Bytes())) {
		t.Errorf("the persisted parts array changed.\n\n--- want (golden)\n%s\n\n--- got\n%s\n\n"+
			"This array is what every existing thread in every existing database "+
			"renders from. If the change is intended, regenerate with UPDATE_GOLDEN=1 "+
			"and read the diff.", want, got.Bytes())
	}
}
