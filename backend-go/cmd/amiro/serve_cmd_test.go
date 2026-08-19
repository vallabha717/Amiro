package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"amiro/backend/internal/config"
)

// bundleDir writes the minimum that reads as a built dashboard, so these
// tests exercise the real resolution path rather than the "no bundle"
// branch. internal/web decides a directory is a bundle by the presence of
// index.html.
func bundleDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html><head></head><body>x</body></html>"), 0o644); err != nil {
		t.Fatalf("write index.html: %v", err)
	}
	return dir
}

func testCfg() config.Config {
	return config.Config{AuthToken: "0123456789abcdef0123456789abcdef", WorkspaceRoot: "/tmp/ws"}
}

func TestEmbeddedOptions_LoopbackNeedsNoRateLimit(t *testing.T) {
	for _, host := range []string{"127.0.0.1", "::1", "localhost"} {
		opts, err := embeddedOptions(serveConfig{Host: host, UIDir: bundleDir(t)}, testCfg())
		if err != nil {
			t.Fatalf("host %s: %v", host, err)
		}
		if opts.RateLimit != nil {
			t.Errorf("host %s: a rate limit was installed for a loopback bind -- a local attacker has better options, and it only costs the real user", host)
		}
		if opts.UI == nil {
			t.Errorf("host %s: no dashboard was resolved", host)
		}
	}
}

// TestEmbeddedOptions_NonLoopbackInstallsTheAuthRateLimit is the control
// that makes --host 0.0.0.0 defensible: login and register are the two
// routes that must stay reachable without a session, so they are the two
// that need a brake once they are on a network.
func TestEmbeddedOptions_NonLoopbackInstallsTheAuthRateLimit(t *testing.T) {
	opts, err := embeddedOptions(serveConfig{Host: "0.0.0.0", UIDir: bundleDir(t)}, testCfg())
	if err != nil {
		t.Fatalf("embeddedOptions: %v", err)
	}
	if opts.RateLimit == nil {
		t.Fatal("no rate limit installed for a network-reachable bind")
	}
	if len(opts.RateLimit.Paths) == 0 {
		t.Fatal("the rate limit guards no paths")
	}
}

// TestEmbeddedOptions_NonLoopbackRefusesAnEmptyToken: config.Load always
// generates a token, so an empty one only arrives via an explicit
// `--token ""`. A blank shared secret is worse than none, because
// everything downstream treats it as meaningful.
func TestEmbeddedOptions_NonLoopbackRefusesAnEmptyToken(t *testing.T) {
	cfg := testCfg()
	cfg.AuthToken = "   "

	_, err := embeddedOptions(serveConfig{Host: "0.0.0.0", UIDir: bundleDir(t)}, cfg)
	if err == nil {
		t.Fatal("a network bind with a blank token was accepted")
	}
	if !strings.Contains(err.Error(), "--token") {
		t.Fatalf("error should name the flag to fix, got: %v", err)
	}

	// The same blank token on loopback is fine: nothing outside this
	// machine can reach the listener to try it.
	if _, err := embeddedOptions(serveConfig{Host: "127.0.0.1", UIDir: bundleDir(t)}, cfg); err != nil {
		t.Fatalf("loopback with a blank token should be allowed: %v", err)
	}
}

func TestEmbeddedOptions_NoUISkipsTheBundleEntirely(t *testing.T) {
	// No UIDir and (in a test binary) no embedded bundle -- --no-ui must
	// still resolve, because "serve the API only" is a real thing to want.
	opts, err := embeddedOptions(serveConfig{Host: "127.0.0.1", NoUI: true}, testCfg())
	if err != nil {
		t.Fatalf("embeddedOptions with --no-ui: %v", err)
	}
	if opts.UI != nil {
		t.Fatal("--no-ui still resolved a dashboard")
	}
}

// TestEmbeddedOptions_MissingBundleExplainsHowToBuildOne: the failure mode
// here is a fresh clone where nobody has run pnpm build, and the error is
// the only place that person will learn what to do about it.
func TestEmbeddedOptions_MissingBundleExplainsHowToBuildOne(t *testing.T) {
	_, err := embeddedOptions(serveConfig{Host: "127.0.0.1", UIDir: t.TempDir()}, testCfg())
	if err == nil {
		t.Fatal("an empty --ui-dir was accepted as a dashboard")
	}
	if !strings.Contains(err.Error(), "index.html") {
		t.Errorf("error should say what is missing, got: %v", err)
	}

	_, err = embeddedOptions(serveConfig{Host: "127.0.0.1"}, testCfg())
	if err == nil {
		t.Skip("this test binary was built with -tags embedui and carries a real bundle")
	}
	for _, want := range []string{"build-ui.sh", "embedui", "--ui-dir", "--no-ui"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the no-bundle error should mention %q, got:\n%v", want, err)
		}
	}
}

func TestServeConfig_IsLoopback(t *testing.T) {
	for host, want := range map[string]bool{
		"127.0.0.1":   true,
		"::1":         true,
		"localhost":   true,
		"0.0.0.0":     false,
		"::":          false,
		"192.168.1.5": false,
		"":            false,
	} {
		if got := (serveConfig{Host: host}).isLoopback(); got != want {
			t.Errorf("isLoopback(%q) = %v, want %v", host, got, want)
		}
	}
}

// TestDashboardURL_NamesAReachableAddressForAWildcardBind: "0.0.0.0" is a
// bind directive, not a destination -- printing it as a URL gives the user
// something that does not work when they paste it on another device.
func TestDashboardURL_NamesAReachableAddressForAWildcardBind(t *testing.T) {
	for _, host := range []string{"0.0.0.0", "::", ""} {
		got := dashboardURL(host, 8080)
		if strings.Contains(got, "0.0.0.0") || strings.Contains(got, "[::]") {
			t.Errorf("dashboardURL(%q) = %q, want a real address someone can open", host, got)
		}
		if !strings.HasSuffix(got, ":8080") {
			t.Errorf("dashboardURL(%q) = %q, want it to carry the port", host, got)
		}
	}

	if got, want := dashboardURL("192.168.1.5", 8080), "http://192.168.1.5:8080"; got != want {
		t.Errorf("dashboardURL = %q, want %q", got, want)
	}
	if got, want := dashboardURL("::1", 8080), "http://[::1]:8080"; got != want {
		t.Errorf("dashboardURL = %q, want %q (IPv6 literals need brackets)", got, want)
	}
}

// TestRunTUI_RejectsServeFlagsThatWouldSilentlyDoNothing. A person who
// types `amiro --port 8080` expecting a dashboard and gets a TUI with no
// server has been failed by the CLI, not by their own reading. Every
// serve-only flag says so instead.
func TestRunTUI_RejectsServeFlagsThatWouldSilentlyDoNothing(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"--host", "0.0.0.0"}, "--host"},
		{[]string{"--port", "8080"}, "--port"},
		{[]string{"--ui-dir", "/tmp"}, "--ui-dir"},
		{[]string{"--allow-origin", "https://x.example"}, "--allow-origin"},
	} {
		err := runTUI(tc.args)
		if err == nil {
			t.Errorf("%v: accepted silently", tc.args)
			continue
		}
		if !strings.Contains(err.Error(), tc.want) || !strings.Contains(err.Error(), "--serve") {
			t.Errorf("%v: error = %q, want it to name %s and --serve", tc.args, err, tc.want)
		}
	}
}

// TestRunTUI_RejectsServeWithConnect: --connect points this process at a
// backend it does not own. There would be nothing local to serve, and
// re-serving someone else's backend under a second identity is not what
// the flag offers.
func TestRunTUI_RejectsServeWithConnect(t *testing.T) {
	err := runTUI([]string{"--serve", "--connect", "http://192.168.1.5:8080", "--token", "abc"})
	if err == nil {
		t.Fatal("--serve --connect was accepted")
	}
	if !strings.Contains(err.Error(), "--serve") || !strings.Contains(err.Error(), "--connect") {
		t.Fatalf("error should name both flags, got: %v", err)
	}
}
