package perf_test

import (
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/backend"
)

// TestPerf_BackendColdStartToHealthy is "Backend cold start to healthy
// /health | < 2s".
//
// backend.Start's own contract is the measurement: "It returns only once
// /health has answered 200. 'Started' and 'ready' are separate facts and
// this function does not return between them." So timing Start end to end
// IS the budget -- spawn, migrations, port binding and the first successful
// health probe, with nothing else folded in.
//
// A throwaway backend is started and stopped first. That is not padding:
// harness/backend.Build's cache is content-hashed, so the first Start in a
// fresh checkout would include a ~20s `go build` and measure the toolchain
// rather than the server. The warm-up pays that once, outside the clock.
func TestPerf_BackendColdStartToHealthy(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("slow"))

	start := func(suffix string) *backend.Backend {
		t.Helper()
		be, err := backend.Start(h.Ctx, backend.Options{
			RepoRoot: h.RepoRoot,
			BaseDir:  h.BaseDir,
			Config:   h.Config,
			Log:      h.Log,
			TestID:   h.TestID + suffix,
			Surface:  h.Surface,
			Address:  h.Address + suffix,
		})
		if err != nil {
			t.Fatalf("backend.Start%s: %v", suffix, err)
		}
		return be
	}

	warm := start("-warm")
	if err := warm.Stop(h.Ctx); err != nil {
		t.Fatalf("stopping the warm-up backend: %v", err)
	}

	began := time.Now()
	be := start("-timed")
	elapsed := time.Since(began)
	defer func() {
		if err := be.Stop(h.Ctx); err != nil {
			t.Errorf("backend teardown: %v", err)
		}
	}()

	// Prove the thing that was timed is actually serving, so a Start that
	// returned early for any reason cannot pass this budget. A client is
	// built by hand rather than through h.Client(), which would insist on
	// starting the harness-managed backend this test deliberately opted out
	// of.
	client := apiclient.New(apiclient.Options{
		BaseURL: be.URL, Token: be.Token, Log: h.Log,
		Surface: h.Surface, Address: h.Address,
		NDJSONPath: filepath.ToSlash(filepath.Join("backend", h.TestID+"-timed", "http.ndjson")),
	})
	if err := client.Health(t.Context()); err != nil {
		t.Fatalf("the backend that was timed is not healthy: %v", err)
	}

	recordDuration(h, budgetColdStart, elapsed, limitColdStart,
		"process spawn -> PORT= line -> first /health 200, with the go build cache already warm")
}

// TestPerf_TUILaunchToFirstFrameEmbedded is "TUI launch to first frame
// (embedded) | < 3s".
//
// Embedded means no server is running for this AppDataDir, so `amiro` has
// to start one inside itself before it can draw anything. The fresh,
// empty AppDataDir (no sidecar.lock.json) is what forces that branch --
// the same setup suites/tui/launch/attach_embed_test.go's
// TestLaunch_EmbedsServerWhenNoneRunning uses to prove the branch was
// taken at all.
//
// "First frame" is the chat prompt "Ask Amiro", which is the ready-text
// convention every existing TUI test uses. The binary is built before the
// clock starts, for the same reason as the cold-start budget.
func TestPerf_TUILaunchToFirstFrameEmbedded(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("slow"))

	h.TUIBinary() // warm the build cache outside the measurement

	appDataDir := filepath.Join(h.Dir(), "embed-appdata")
	if err := mkdir(appDataDir); err != nil {
		t.Fatal(err)
	}

	began := time.Now()
	sess := h.PTY(harness.PTYAppDataDir(appDataDir))
	defer sess.Close()
	if err := sess.WaitForText("Ask Amiro", 30*time.Second); err != nil {
		t.Fatalf("embedded amiro never drew its first frame: %v\nframe:\n%s", err, sess.Frame())
	}
	elapsed := time.Since(began)

	// Non-vacuousness: if a backend had already been running here, this
	// would have been the cheap attach path and the number would mean
	// something else entirely.
	assertLockWritten(t, appDataDir)

	recordDuration(h, budgetTUIEmbedded, elapsed, limitTUIEmbedded,
		"fresh AppDataDir (no sidecar.lock.json), so amiro embeds its own backend; "+
			"clock starts before harness.PTY and stops when \"Ask Amiro\" is on the screen")
}

// TestPerf_TUILaunchToFirstFrameAttached is "TUI launch to first frame
// (attached) | < 1s".
//
// Attached means a backend is already serving this AppDataDir, so `amiro`
// discovers it through sidecar.lock.json and talks to it over HTTP instead
// of starting a second one. h.Backend() is that already-running server:
// cmd/server writes the same discovery lock the desktop app does
// (cmd/server/main.go's appwiring.WriteLock), which is exactly the
// arrangement suites/tui/launch's TestLaunch_AttachesToRunningBackend
// asserts the attach against.
//
// The backend's own startup is deliberately outside the clock. The budget
// is what a user waits for when they type `amiro` with the desktop app
// already open, and in that situation the backend started minutes ago.
func TestPerf_TUILaunchToFirstFrameAttached(t *testing.T) {
	h := harness.New(t, harness.Tags("slow"))
	be := h.Backend()
	h.Seeded() // so harness.PTY writes a usable session into keys.json
	h.TUIBinary()

	lockBefore := readLockBytes(t, be.AppDataDir)

	began := time.Now()
	sess := h.PTY(
		harness.PTYAppDataDir(be.AppDataDir),
		harness.PTYDir(be.WorkspaceRoot),
	)
	defer sess.Close()
	if err := sess.WaitForText("Ask Amiro", 30*time.Second); err != nil {
		t.Fatalf("attaching amiro never drew its first frame: %v\nframe:\n%s", err, sess.Frame())
	}
	elapsed := time.Since(began)

	// The proof that this was the ATTACH path and not a second embed:
	// appwiring.WriteLock records the writing process's own pid and port,
	// so an unchanged lock file means nothing else called it. Same
	// reasoning as suites/cross/attachembed. Without this the budget could
	// be met by a fast embed and would silently measure the wrong thing.
	if lockAfter := readLockBytes(t, be.AppDataDir); lockAfter != lockBefore {
		t.Fatalf("the discovery lock changed while the TUI started -- it embedded its own backend "+
			"rather than attaching, so this is not the attached budget\nbefore: %s\nafter:  %s",
			lockBefore, lockAfter)
	}

	recordDuration(h, budgetTUIAttached, elapsed, limitTUIAttached,
		"a cmd/server backend is already serving this AppDataDir; clock covers harness.PTY "+
			"through \"Ask Amiro\", and the discovery lock is asserted unchanged so this is the attach path")
}

// TestPerf_DashboardFirstContentfulPaint is the "Dashboard first
// contentful paint | < 2s" row, and it is the one budget in this table
// that is NOT measured as specified.
//
// FCP is a browser rendering milestone: it is the moment the compositor
// paints the first text or image, reported by the PerformanceObserver
// 'paint' entry. Nothing in a Go test can observe that -- there is no
// renderer here. What this test measures instead is the server-side lower
// bound: time to first byte of the dashboard's HTML document from the
// backend's embedded static file server, plus the time to read the whole
// document. Real FCP is that number PLUS DNS/connection (nil here, it is
// loopback), plus HTML parse, plus the JS bundle fetch, parse and
// execute, plus the first paint -- which for a Next.js export is by far
// the larger share.
//
// So: this asserts a proxy, clearly labelled, and the FCP budget itself
// is NOT MET. Closing it means a Playwright-side companion budget in
// ui/specs that reads performance.getEntriesByName('first-contentful-paint').
// The proxy is still worth asserting: if the HTML alone takes 2s, FCP
// cannot possibly be under 2s, so a failure here is a real one.
func TestPerf_DashboardFirstContentfulPaint(t *testing.T) {
	// embedui is what compiles the dashboard bundle into cmd/server
	// (backend-go/internal/web/embed_on.go). Without it web.New() returns
	// no handler and the router never registers "/" at all, so there would
	// be no document to time.
	h := harness.New(t, harness.Tags("slow"), harness.BuildTags("embedui"))
	be := h.Backend()

	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, be.URL+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	be.Authorize(req)

	client := &http.Client{Timeout: 30 * time.Second}

	// One warm request first: the very first hit pays for lazily built
	// file-system indexes and TCP setup, and the budget is about steady
	// state, not the first packet after boot.
	warm, err := client.Do(req.Clone(t.Context()))
	if err != nil {
		t.Fatalf("GET / (warm-up): %v", err)
	}
	_ = warm.Body.Close()

	began := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("GET /: %v", err)
	}
	defer resp.Body.Close()
	// http.Client.Do returns once the response HEADERS have been read, so
	// this is time to first byte, not time to last byte.
	ttfb := time.Since(began)

	body := make([]byte, 1<<20)
	n, _ := readFull(resp.Body, body)
	full := time.Since(began)

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET / = %d, want 200 -- this build has no dashboard to time (was it built with -tags embedui?)",
			resp.StatusCode)
	}
	if n == 0 {
		t.Fatal("GET / returned an empty document; there is nothing here that could paint")
	}
	if ct := resp.Header.Get("Content-Type"); ct == "" {
		t.Errorf("GET / sent no Content-Type; a browser would have to sniff it before it could parse anything")
	}

	t.Logf("dashboard document: %d bytes, TTFB %s, fully read %s", n, ttfb, full)
	recordDuration(h, budgetDashboardTTFB, ttfb, limitDashboard,
		"PROXY, NOT FCP: time to first byte of GET / (the embedded dashboard's HTML) over loopback. "+
			"Real first contentful paint additionally includes HTML parse, JS bundle fetch/parse/execute "+
			"and the first paint, none of which a Go test can observe. See the test's doc comment.")
}
