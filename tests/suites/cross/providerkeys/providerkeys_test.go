// Package providerkeys_test proves Phase 7's "Provider keys" cross-surface
// journey, quoted verbatim from the Section 1 table of
// docs/testing/phases/phase-07-cross-surface.md:
//
//	| Provider keys | Add a key in the dashboard; the TUI can immediately use that model |
//
// and contributes to Exit Criterion 1, quoted verbatim: "`amirotest run
// --surface cross` passes, and every cross-surface journey above has a
// test."
//
// WHAT PLAYS "THE DASHBOARD", AND WHY THAT IS FAITHFUL.
// "The dashboard" is a second apiclient.Client posting to
// /api/ai/providers -- byte for byte the request the dashboard's provider
// card sends (internal/api/ai/providers.go's SetProviderKey). `cross` is a
// Go-test surface with no DOM to type into; what a browser adds over this
// is a form, and a form is not what the row is about. The TUI half is NOT
// substituted: a real `amiro` binary under a real PTY opens its real model
// picker (ctrl+o -> page.Models, whose Init issues a live GET
// /api/chat/models), selects the new model with enter, and runs a real turn
// on it.
//
// WHAT "IMMEDIATELY" MEANS HERE, AND WHY THIS TEST IS ORDERED AS IT IS.
// The TUI process is started BEFORE the key exists and is never restarted;
// the backend is never restarted either. So "immediately" is asserted in
// its strong form: no restart of anything, on either surface. That ordering
// is the point of the test and is why it cannot be simplified into
// "configure, then launch".
//
// Two independent facts are asserted, because either alone would be weak:
// the new model APPEARS in the TUI's picker (proving the live read), and a
// turn the TUI then runs is PERSISTED against that provider connection's id
// (proving the TUI actually used it, not merely listed it).
package providerkeys_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/assert"
	"amiro/tests/harness/fakeprovider"
	"amiro/tests/harness/pty"
)

type persistedMetadata struct {
	ChatModel *struct {
		Provider string `json:"provider"`
		Model    string `json:"model"`
	} `json:"chatModel"`
}

func TestCrossSurface_ProviderKeyAddedInTheDashboardIsImmediatelyUsableFromTheTUI(t *testing.T) {
	const probe = "provider key cross surface probe"
	const answer = "Provider key probe acknowledged."
	const providerName = "CrossKeyConnection"
	const modelName = "crosskeymodel"

	h := harness.New(t, harness.Tags("smoke"), harness.WithFake(func(s *fakeprovider.Server) {
		s.OnPrompt(fakeprovider.Contains(probe)).StreamText(answer)
	}))
	be := h.Backend()

	dashboard := h.As("admin")
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// The TUI starts FIRST, with no such key in the database.
	sess := h.PTY(
		harness.PTYAppDataDir(be.AppDataDir),
		harness.PTYDir(be.WorkspaceRoot),
	)
	defer sess.Close()
	if err := sess.WaitForText("Ask Amiro", 15*time.Second); err != nil {
		t.Fatalf("the TUI did not render its prompt: %v\nframe:\n%s", err, sess.Frame())
	}

	// Now the key is added from the other surface, with the TUI already up.
	provider, err := dashboard.SaveProvider(ctx, apiclient.ProviderInput{
		Name:     providerName,
		Provider: "openai",
		APIKey:   "cross-provider-key",
		BaseURL:  h.Proxy().URL + "/openai",
		Models:   []string{modelName},
	})
	if err != nil {
		t.Fatalf("adding the provider key from the dashboard-side client: %v", err)
	}
	if provider.ID == "" {
		t.Fatalf("POST /api/ai/providers returned no id: %+v", provider)
	}

	// ctrl+o opens page.Models, whose Init fires ListModels -- so this is a
	// fresh GET /api/chat/models from the already-running TUI process, not a
	// list cached at launch.
	if err := sess.SendKey(pty.KeyCtrlO, "ctrl+o"); err != nil {
		t.Fatalf("opening the model picker: %v", err)
	}

	// page.Models renders each row as "ProviderName / Model".
	wantRow := providerName + " / " + modelName
	if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
		return strings.Contains(unwrapped(b.Plain()), wantRow)
	}, 15*time.Second); err != nil {
		t.Fatalf("the TUI's model picker never offered %q after the dashboard added that key, so the TUI "+
			"cannot use it without a restart: %v\nframe:\n%s", wantRow, err, sess.Frame())
	}

	// Filter down to exactly this row before selecting, so "enter" cannot
	// pick whichever seeded model happened to sort first.
	if err := sess.Send(modelName); err != nil {
		t.Fatalf("typing the picker filter: %v", err)
	}
	// "> " is page.Models' cursor marker on the selected row. Before the
	// filter is typed the cursor sits on whichever seeded model sorts first,
	// so seeing it on this row is proof the filter narrowed to it and that
	// enter will pick it.
	if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
		return strings.Contains(unwrapped(b.Plain()), "> "+wantRow)
	}, 10*time.Second); err != nil {
		t.Fatalf("filtering by %q did not put the picker's cursor on %q: %v\nframe:\n%s",
			modelName, wantRow, err, sess.Frame())
	}
	if err := sess.SendKey(pty.KeyEnter, "enter"); err != nil {
		t.Fatalf("selecting the model: %v", err)
	}
	if err := sess.WaitForText("Ask Amiro", 10*time.Second); err != nil {
		t.Fatalf("the picker did not close back to the composer after selection: %v\nframe:\n%s", err, sess.Frame())
	}

	if err := sess.SendLine(probe); err != nil {
		t.Fatalf("sending the probe into the TUI: %v", err)
	}
	if err := sess.WaitForText(answer, 20*time.Second); err != nil {
		t.Fatalf("the turn on the newly added connection did not complete: %v\nframe:\n%s", err, sess.Frame())
	}

	// "Listed it" is not "used it". The persisted metadata says which
	// connection the turn actually ran on, and the dashboard's client is the
	// one that reads it back.
	//
	// Polled, not read once: RunTurn persists the assistant row just before
	// it writes [DONE], while the reply text the terminal renders arrives
	// earlier, so reading the instant the text appears is a race.
	assert.Eventually(t, "the dashboard client to read back the connection the TUI's turn ran on", 30*time.Second, func() error {
		threads, err := dashboard.ListThreads(ctx)
		if err != nil {
			return fmt.Errorf("GET /api/thread: %w", err)
		}
		if len(threads) == 0 {
			return fmt.Errorf("the dashboard client sees no threads; the TUI's turn has not reached the shared database")
		}
		var seen []string
		for _, th := range threads {
			detail, err := dashboard.GetThread(ctx, th.ID)
			if err != nil {
				return fmt.Errorf("GET /api/thread/%s: %w", th.ID, err)
			}
			for _, m := range detail.Messages {
				if m.Role != "assistant" || len(m.Metadata) == 0 {
					continue
				}
				var meta persistedMetadata
				if err := json.Unmarshal(m.Metadata, &meta); err != nil {
					return fmt.Errorf("decoding assistant message %s metadata %s: %w", m.ID, m.Metadata, err)
				}
				if meta.ChatModel == nil {
					seen = append(seen, m.ID+": no chatModel")
					continue
				}
				seen = append(seen, m.ID+": "+meta.ChatModel.Provider+"/"+meta.ChatModel.Model)
				if meta.ChatModel.Provider == provider.ID && meta.ChatModel.Model == modelName {
					return nil
				}
			}
		}
		return fmt.Errorf("the TUI's turn did not run on the connection the dashboard just added (%s/%s); "+
			"chatModel seen on each assistant message: %v", provider.ID, modelName, seen)
	})
}

// unwrapped joins a rendered frame's lines back together, undoing the
// terminal's own hard wrap at the right margin. See the same helper in
// suites/cross/skills for the full reasoning: the picker's rows are
// drawn near the right margin and wrap, a wrap continuation always resumes
// at column 0, and pty.Buffer.Plain only trims trailing spaces (which a
// wrapped line has none of), so concatenation is exactly the wrap's
// inverse.
func unwrapped(frame string) string {
	return strings.ReplaceAll(frame, "\n", "")
}
