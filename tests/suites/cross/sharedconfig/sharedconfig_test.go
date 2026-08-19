// Package sharedconfig_test covers Phase 7's "Shared config" cross-surface
// journey, quoted verbatim from the Section 1 table of
// docs/testing/phases/phase-07-cross-surface.md:
//
//	| Shared config | Set `defaultModel` in `.amiro/config.yaml`; both the TUI and the desktop sidecar honour it |
//
// and contributes to Exit Criterion 1, quoted verbatim: "`amirotest run
// --surface cross` passes, and every cross-surface journey above has a
// test."
//
// WHAT IS PROVEN HERE, AND WHAT IS NOT -- READ THIS BEFORE TRUSTING THE ROW.
//
// The TUI half is proven, end to end and cross-surface: a real
// `.amiro/config.yaml` on disk, a real `amiro` binary under a real PTY, a
// real turn, and then the model that turn actually ran on read back from
// the shared database by a SECOND client -- the one standing in for the
// dashboard. That last step is what makes this cross-surface rather than a
// TUI-only config test (suites/tui/config already covers `defaultMode`
// precedence within one process, and covers only `defaultMode`): the file
// the terminal read is observable in the row the other surface reads.
//
// The "desktop sidecar" half is NOT proven, and cannot be, because it is
// NOT TRUE OF THE SHIPPED CODE. The sidecar is backend-go/cmd/server; its
// main() calls internal/config.Load() and nothing else. internal/config
// resolves AMIRO_* environment variables only and has no notion of a file
// on disk (no yaml import, no config.yaml path). The only reader of
// `.amiro/config.yaml`'s `defaultModel` in the tree is
// internal/tui/config.Load, and its only caller is cmd/amiro/tui.go.
// internal/tui/config's own package doc asserts the opposite ("Both amiro
// and the desktop sidecar read the same two file paths"); that sentence
// does not match cmd/server. Writing a test that asserted the sidecar
// honours defaultModel would fail; writing one that asserted it ignores it
// would be pinning a defect as intended behaviour. So neither is written:
// the gap is reported instead. See this suite's entry in the Phase 7
// progress notes.
package sharedconfig_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/assert"
	"amiro/tests/harness/fakeprovider"
)

// persistedMetadata is the subset of internal/api/chat's chatMetadata this
// test reads back off an assistant message. Transcribed, not imported --
// the same rule the rest of apiclient follows.
type persistedMetadata struct {
	ChatModel *struct {
		Provider string `json:"provider"`
		Model    string `json:"model"`
	} `json:"chatModel"`
}

func TestCrossSurface_DefaultModelInProjectConfigIsHonouredByTheTUIAndVisibleToTheDashboard(t *testing.T) {
	const probe = "shared config default model probe"
	const answer = "Shared config probe acknowledged."
	// A model name no seeded provider offers, so the assertion below cannot
	// pass by accident on the server's own fallback (bifrost's catalog
	// fallback is openai/gpt-4.1).
	const wantModel = "cross-shared-config-model"

	h := harness.New(t, harness.Tags("smoke"), harness.WithFake(func(s *fakeprovider.Server) {
		s.OnPrompt(fakeprovider.Contains(probe)).StreamText(answer)
	}))
	be := h.Backend()

	dashboard := h.As("admin")
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// A provider connection to name in the config file. `defaultModel`'s
	// "provider" segment is a provider CONFIG ID, not a provider type --
	// bifrost's Resolve(configID, modelID) looks the connection up
	// dynamically by id (internal/ai/bifrost/account.go), which is why the
	// config file can only be written once the connection exists.
	provider, err := dashboard.SaveProvider(ctx, apiclient.ProviderInput{
		Name:     "Cross Shared Config Provider",
		Provider: "openai",
		APIKey:   "cross-shared-config-key",
		BaseURL:  h.Proxy().URL + "/openai",
		Models:   []string{wantModel},
	})
	if err != nil {
		t.Fatalf("adding the provider connection the config file will name: %v", err)
	}
	if provider.ID == "" {
		t.Fatalf("POST /api/ai/providers returned no id: %+v", provider)
	}

	// The project layer of internal/tui/config's precedence ladder:
	// <workspace>/.amiro/config.yaml, read by cmd/amiro at launch.
	configDir := filepath.Join(be.WorkspaceRoot, ".amiro")
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := "defaultModel: " + provider.ID + "/" + wantModel + "\n"
	if err := os.WriteFile(filepath.Join(configDir, "config.yaml"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	sess := h.PTY(
		harness.PTYAppDataDir(be.AppDataDir),
		harness.PTYDir(be.WorkspaceRoot),
	)
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 15*time.Second); err != nil {
		t.Fatalf("the TUI did not render its prompt: %v\nframe:\n%s", err, sess.Frame())
	}
	if err := sess.SendLine(probe); err != nil {
		t.Fatalf("sending the probe into the TUI: %v", err)
	}
	if err := sess.WaitForText(answer, 20*time.Second); err != nil {
		t.Fatalf("the TUI turn did not complete -- if defaultModel named a connection that cannot serve the "+
			"model, the turn would fail here rather than fall back: %v\nframe:\n%s", err, sess.Frame())
	}

	// The cross-surface read: the dashboard's client, against the same
	// backend, asks which model the terminal's turn actually ran on.
	//
	// Polled, not read once. internal/api/chat's RunTurn persists the
	// assistant row just before it writes [DONE] to the stream, but the
	// answer text the terminal renders arrives earlier than that -- so "the
	// TUI printed the reply" and "the row is in the database" are two
	// different moments, and reading at the first one is a race. This is the
	// second moment, waited for against the real API.
	assert.Eventually(t, "the dashboard client to read back the model the TUI's turn ran on", 30*time.Second, func() error {
		threads, err := dashboard.ListThreads(ctx)
		if err != nil {
			return fmt.Errorf("GET /api/thread: %w", err)
		}
		if len(threads) == 0 {
			return fmt.Errorf("the dashboard client sees no threads at all; the TUI's turn has not reached the " +
				"shared database")
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
				if meta.ChatModel.Provider == provider.ID && meta.ChatModel.Model == wantModel {
					return nil
				}
			}
		}
		return fmt.Errorf("no assistant message ran on %s/%s, so the TUI did not honour "+
			"%s/.amiro/config.yaml's defaultModel; chatModel seen on each assistant message: %v",
			provider.ID, wantModel, be.WorkspaceRoot, seen)
	})
}
