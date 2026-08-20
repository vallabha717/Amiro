// Package servetui_test proves Phase 7's "Serve + TUI" cross-surface
// journey, quoted verbatim from the Section 1 table of
// docs/testing/phases/phase-07-cross-surface.md:
//
//	| Serve + TUI | `amiro --serve --port N`: the TUI and the dashboard share one embedded backend |
//
// and contributes to Exit Criterion 1, quoted verbatim: "`amirotest run
// --surface cross` passes, and every cross-surface journey above has a
// test."
//
// NOTHING IS SUBSTITUTED ON THE SERVER SIDE.
// This starts a REAL `amiro --serve --port N` under a real PTY -- not
// harness.Backend(), which spawns cmd/server (the Tauri sidecar) instead and
// would test a different program. The binary is built with -tags embedui so
// the dashboard bundle really is inside it, which is what
// cmd/amiro/serve_cmd.go's embeddedOptions requires (without it, `--serve`
// refuses to start at all: "this build carries no dashboard bundle").
//
// WHAT "SHARE ONE EMBEDDED BACKEND" IS ASSERTED TO MEAN, IN FOUR PARTS.
//  1. There is exactly one backend, and it is this TUI's own process: the
//     discovery lock appwiring wrote (sidecar.lock.json) carries the amiro
//     process's own pid and the port that was asked for. A second backend
//     would have had to write its own pid there.
//  2. The dashboard is served from that same port: GET / returns the
//     exported Next.js shell with internal/web's same-origin bootstrap
//     script injected -- the marker that says "this page was served by the
//     Go binary itself, on the same origin as the API".
//  3. The API is on that same port, and answers as the user the TUI signed
//     in as -- read out of the session the TUI itself persisted through
//     internal/secrets, exactly as a browser session on that origin would be
//     the same account.
//  4. A turn typed into the TUI is readable through that port's API. One
//     backend, one database, two surfaces.
//
// The browser half is an apiclient.Client rather than a rendered page,
// because `cross` is a Go-test surface. What that leaves unproven is only
// that the shell hydrates and renders -- suites/ui covers the dashboard's
// own behaviour, and part 2 above is what ties this port to that bundle.
package servetui_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/assert"
	"amiro/tests/harness/fakeprovider"
	"amiro/tests/harness/process"
	"amiro/tests/harness/pty"
)

// lockFile is appwiring's sidecar.lock.json, transcribed the same way
// suites/cross/attachembed transcribes it.
type lockFile struct {
	PID   int    `json:"pid"`
	Port  int    `json:"port"`
	Token string `json:"token"`
}

func TestCrossSurface_ServeAndTUIShareOneEmbeddedBackend(t *testing.T) {
	const probe = "serve plus tui shared backend probe"
	const answer = "Shared embedded backend probe acknowledged."

	h := harness.New(t,
		harness.NoBackend(),
		harness.BuildTags("embedui"),
		harness.Tags("smoke"),
		harness.WithFake(func(s *fakeprovider.Server) {
			s.OnPrompt(fakeprovider.Contains(probe)).StreamText(answer)
		}),
	)

	port, err := process.FreePort("127.0.0.1")
	if err != nil {
		t.Fatalf("picking a port for --serve: %v", err)
	}

	appDataDir := filepath.Join(h.Dir(), "serve-appdata")
	if err := os.MkdirAll(appDataDir, 0o755); err != nil {
		t.Fatal(err)
	}

	sess := h.PTY(
		harness.PTYAppDataDir(appDataDir),
		harness.PTYArgs("--serve", "--port", strconv.Itoa(port)),
	)
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 30*time.Second); err != nil {
		t.Fatalf("`amiro --serve --port %d` never reached its prompt. If the frame mentions a missing dashboard "+
			"bundle, backend-go/internal/web/dist is not staged and harness.BuildTags(\"embedui\") could not "+
			"embed one: %v\nframe:\n%s", port, err, sess.Frame())
	}

	// (1) One backend, and it is this process.
	lockPath := filepath.Join(appDataDir, "sidecar.lock.json")
	var lock lockFile
	assert.Eventually(t, "the serving process to publish its discovery lock", 15*time.Second, func() error {
		data, err := os.ReadFile(lockPath)
		if err != nil {
			return fmt.Errorf("reading %s: %w", lockPath, err)
		}
		if err := json.Unmarshal(data, &lock); err != nil {
			return fmt.Errorf("parsing %s (%s): %w", lockPath, data, err)
		}
		if lock.Port == 0 {
			return fmt.Errorf("%s carries no port yet: %+v", lockPath, lock)
		}
		return nil
	})
	if lock.Port != port {
		t.Fatalf("the embedded backend is on port %d, but --port asked for %d", lock.Port, port)
	}
	if pid := sess.Process.Pid(); lock.PID != pid {
		t.Fatalf("the discovery lock names pid %d, but the amiro process is pid %d -- the backend the dashboard "+
			"is on is not the TUI's own embedded one", lock.PID, pid)
	}

	baseURL := "http://127.0.0.1:" + strconv.Itoa(port)

	// The session the TUI itself provisioned and persisted through
	// internal/secrets. Reading it is how this test becomes the same user
	// the terminal is -- which is the whole point of "share one backend".
	var session string
	assert.Eventually(t, "the TUI to persist the session it signed in with", 15*time.Second, func() error {
		data, err := os.ReadFile(filepath.Join(appDataDir, "keys.json"))
		if err != nil {
			return fmt.Errorf("reading the secrets store: %w", err)
		}
		var keys map[string]string
		if err := json.Unmarshal(data, &keys); err != nil {
			return fmt.Errorf("parsing the secrets store: %w", err)
		}
		if keys["amiro:session"] == "" {
			return fmt.Errorf("no \"amiro:session\" entry yet (have: %v)", keyNames(keys))
		}
		session = keys["amiro:session"]
		return nil
	})

	dashboard := apiclient.New(apiclient.Options{
		BaseURL: baseURL,
		// backend.Env pins AMIRO_AUTH_TOKEN for every harness-launched
		// amiro, so this is the shared secret the served process is using.
		Token:   "test-tui-token",
		Log:     h.Log,
		Surface: h.Surface,
		Address: h.Address,
	}).As("browser", session)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// (2) The dashboard is on that port, out of that binary.
	resp, err := dashboard.Do(ctx, http.MethodGet, "/", nil, nil)
	if err != nil {
		t.Fatalf("GET %s/ (the dashboard `--serve` exists to serve): %v", baseURL, err)
	}
	if resp.Status != http.StatusOK {
		t.Fatalf("GET %s/ returned %d, want 200", baseURL, resp.Status)
	}
	body := string(resp.Body)
	if !strings.Contains(body, "__BACKEND_ORIGIN__") {
		t.Errorf("the page served at %s/ carries no __BACKEND_ORIGIN__ bootstrap, so it is not internal/web's "+
			"same-origin dashboard shell\nfirst 400 bytes: %s", baseURL, truncate(body, 400))
	}

	// (3) The API is on the same port, as the same user.
	me, err := dashboard.Me(ctx)
	if err != nil {
		t.Fatalf("GET %s/api/auth/me with the session the TUI persisted: %v", baseURL, err)
	}
	if me.ID == "" {
		t.Fatalf("the API on %s answered with no user: %+v", baseURL, me)
	}

	// (4) A turn typed into the terminal is readable through that same port.
	//
	// `--serve` embeds a brand-new backend with an empty database, so a
	// provider connection has to be created before a turn can run at all --
	// and creating it through the dashboard's client, then selecting it in
	// the TUI's own model picker, is itself another crossing of the same
	// shared backend.
	const modelName = "servetuimodel"
	const providerName = "ServeTUIConnection"
	if _, err := dashboard.SaveProvider(ctx, apiclient.ProviderInput{
		Name:     providerName,
		Provider: "openai",
		APIKey:   "serve-tui-key",
		BaseURL:  h.Proxy().URL + "/openai",
		Models:   []string{modelName},
	}); err != nil {
		t.Fatalf("adding a provider connection through the served port: %v", err)
	}

	wantRow := providerName + " / " + modelName
	if err := sess.SendKey(pty.KeyCtrlO, "ctrl+o"); err != nil {
		t.Fatalf("opening the TUI's model picker: %v", err)
	}
	if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
		return strings.Contains(strings.ReplaceAll(b.Plain(), "\n", ""), wantRow)
	}, 20*time.Second); err != nil {
		t.Fatalf("the TUI's model picker never offered %q, so it is not reading the same backend the dashboard "+
			"client just wrote to: %v\nframe:\n%s", wantRow, err, sess.Frame())
	}
	if err := sess.Send(modelName); err != nil {
		t.Fatalf("typing the picker filter: %v", err)
	}
	if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
		return strings.Contains(strings.ReplaceAll(b.Plain(), "\n", ""), "> "+wantRow)
	}, 15*time.Second); err != nil {
		t.Fatalf("filtering by %q did not put the picker's cursor on %q: %v\nframe:\n%s",
			modelName, wantRow, err, sess.Frame())
	}
	if err := sess.SendKey(pty.KeyEnter, "enter"); err != nil {
		t.Fatalf("selecting the model: %v", err)
	}
	if err := sess.WaitForText("Ask Amiro", 15*time.Second); err != nil {
		t.Fatalf("the picker did not close back to the composer: %v\nframe:\n%s", err, sess.Frame())
	}
	_ = sess.WaitForStable(1 * time.Second)

	if err := sess.SendLine(probe); err != nil {
		t.Fatalf("sending the probe into the TUI: %v", err)
	}
	if err := sess.WaitForText(answer, 30*time.Second); err != nil {
		t.Fatalf("the TUI turn did not complete: %v\nframe:\n%s", err, sess.Frame())
	}

	assert.Eventually(t, "the dashboard's port to serve the thread the TUI just started", 20*time.Second, func() error {
		threads, err := dashboard.ListThreads(ctx)
		if err != nil {
			return fmt.Errorf("GET /api/thread: %w", err)
		}
		for _, th := range threads {
			detail, err := dashboard.GetThread(ctx, th.ID)
			if err != nil {
				return fmt.Errorf("GET /api/thread/%s: %w", th.ID, err)
			}
			for _, m := range detail.Messages {
				if strings.Contains(string(m.Parts), probe) {
					return nil
				}
			}
		}
		return fmt.Errorf("none of the %d thread(s) on %s carries the TUI's message; the dashboard's port is not "+
			"reading the same database the TUI wrote to", len(threads), baseURL)
	})
}

func keyNames(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
