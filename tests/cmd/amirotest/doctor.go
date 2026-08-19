package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"amiro/tests/harness/backend"
	"amiro/tests/harness/cassette"
	"amiro/tests/harness/config"
	"amiro/tests/harness/desktop"
	"amiro/tests/harness/run"
)

// cmdDoctor reports the toolchain state and, more usefully, what each
// missing piece MEANS for a run.
//
// "cargo: not found" on its own is a fact. "cargo: not found -- the desktop
// surface will skip itself, which is not a failure" is an answer. The
// second is what stops someone installing Rust to fix a test they were not
// running.
func cmdDoctor(args []string) int {
	fs := flag.NewFlagSet("doctor", flag.ContinueOnError)
	var common commonFlags
	common.register(fs)
	if err := fs.Parse(args); err != nil {
		return exitConfig
	}

	res, code := loadConfig(common)
	if code != exitOK {
		// A broken config is itself a diagnosis, and loadConfig already
		// printed every problem.
		return code
	}

	fmt.Printf("tests directory   %s\n", res.BaseDir)
	if len(res.Sources) == 0 {
		fmt.Printf("config            none -- every value is a default, which is a valid, passing configuration\n")
	} else {
		for _, src := range res.Sources {
			fmt.Printf("config            %s\n", src)
		}
	}
	fmt.Println()

	tools := map[string]run.Tool{}
	for _, t := range run.DetectTools() {
		tools[t.Name] = t
	}

	type check struct {
		name     string
		required bool
		meaning  string
	}
	checks := []check{
		{"go", true, "required: the backend, TUI, desktop and cross surfaces are all `go test`"},
		{"node", false, "the ui surface needs it; without it, ui skips"},
		{"pnpm", false, "the ui surface needs it; without it, ui skips"},
		{"cargo", false, "the desktop surface needs it; desktop.enabled: auto means it skips, not fails"},
		{"git", false, "only used to stamp run.json with a commit; absence costs nothing"},
	}

	missingRequired := false
	for _, c := range checks {
		t := tools[c.name]
		if t.Found {
			fmt.Printf("  ✓ %-6s %s\n", c.name, t.Version)
			continue
		}
		mark := "-"
		if c.required {
			mark = "✗"
			missingRequired = true
		}
		fmt.Printf("  %s %-6s not found\n           %s\n", mark, c.name, c.meaning)
	}

	// The desktop surface needs more than bare cargo: the Tauri CLI is a
	// separate install (`cargo install tauri-cli`), and Linux additionally
	// needs webkit2gtk for the webview to build at all. Checked with
	// harness/desktop.DetectToolchain so doctor and the suites themselves
	// never drift on what "the toolchain is present" means.
	tc := desktop.DetectToolchain()
	if tc.TauriCLIFound {
		fmt.Printf("  ✓ %-6s %s\n", "tauri", tc.TauriCLIVersion)
	} else if tc.CargoFound {
		fmt.Printf("  - %-6s not installed\n           the desktop surface needs it; run `cargo install tauri-cli`\n", "tauri")
	} else {
		fmt.Printf("  - %-6s not checked (cargo missing)\n           the desktop surface needs it\n", "tauri")
	}
	if webview, detail := checkWebviewDeps(); webview {
		fmt.Printf("  ✓ %-6s %s\n", "webview", detail)
	} else {
		fmt.Printf("  - %-6s %s\n           only checked on Linux; a packaged build will fail without it\n", "webview", detail)
	}

	// Playwright browser check
	if browserFound, browserPath := checkPlaywrightBrowser(); browserFound {
		fmt.Printf("  ✓ %-6s %s\n", "chromium", browserPath)
	} else {
		fmt.Printf("  - %-6s not installed\n           the ui surface needs it; run `pnpm --dir tests install-browsers`\n", "chromium")
	}

	// Web UI dist bundle check
	repoRoot, err := backend.FindRepoRoot(res.BaseDir)
	if err == nil {
		distHTML := filepath.Join(repoRoot, "backend-go", "internal", "web", "dist", "index.html")
		if _, err := os.Stat(distHTML); err == nil {
			fmt.Printf("  ✓ %-6s %s\n", "bundle", "backend-go/internal/web/dist (ready for embedui)")
		} else {
			fmt.Printf("  - %-6s missing %s\n           run `./scripts/build-ui.sh` to stage the dashboard for embedui builds\n", "bundle", distHTML)
		}
	}

	fmt.Println()
	fmt.Printf("providers         %s\n", res.Config.Providers.Mode)
	if len(res.Config.Providers.LLM) == 0 {
		fmt.Printf("                  no provider keys configured -- provider-backed tests use canned responses\n")
	} else {
		for _, p := range res.Config.Providers.LLM {
			fmt.Printf("                  %s: key configured\n", p.ID)
		}
	}
	for _, d := range res.DroppedProviders {
		fmt.Printf("                  %s: DROPPED, its apiKey expanded to nothing\n", d)
	}
	for _, v := range res.MissingVars {
		fmt.Printf("                  ${%s} is not set\n", v)
	}

	cassettes := config.Resolve(res.BaseDir, res.Config.Providers.CassetteDir)
	if _, err := os.Stat(cassettes); err != nil {
		fmt.Printf("cassettes         %s does not exist yet\n", cassettes)
	} else {
		reports, _ := cassette.CheckTTL(cassettes, time.Now())
		expiredCount := 0
		for _, r := range reports {
			if r.IsExpired {
				expiredCount++
			}
		}
		if expiredCount > 0 {
			fmt.Printf("cassettes         %s (%d total, %d EXPIRED past TTL)\n", cassettes, len(reports), expiredCount)
			for _, r := range reports {
				if r.IsExpired {
					fmt.Printf("                  ✗ %s (age %dd > ttl %dd)\n", r.Path, r.AgeDays, r.TTLDays)
				}
			}
		} else {
			fmt.Printf("cassettes         %s (%d recorded, all within TTL)\n", cassettes, len(reports))
		}
	}

	logsDir := config.Resolve(res.BaseDir, res.Config.Logging.Dir)
	fmt.Printf("logs              %s (keeping the newest %d runs)\n", logsDir, res.Config.Logging.KeepRuns)

	fixture := filepath.Join(res.BaseDir, "fixtures", "workspaces", "basic")
	if _, err := os.Stat(fixture); err != nil {
		fmt.Printf("\n  ✗ the default workspace fixture is missing: %s\n", fixture)
		fmt.Printf("    every backend test copies it; this checkout is incomplete\n")
		missingRequired = true
	}

	fmt.Println()
	if missingRequired {
		fmt.Println("NOT READY -- something required is missing (marked ✗ above).")
		return exitInfra
	}
	fmt.Println("Ready. Anything marked - above causes a surface to skip itself with a recorded reason, not to fail.")
	return exitOK
}

// checkWebviewDeps is Linux-only and best-effort: Tauri's Linux build needs
// webkit2gtk-4.1 (or the older 4.0) at build time, which pkg-config can
// answer without needing cargo at all. Other platforms use their system
// webview (WKWebView, WebView2) and have nothing separate to check here.
func checkWebviewDeps() (bool, string) {
	if runtime.GOOS != "linux" {
		return true, "not applicable on " + runtime.GOOS
	}
	for _, pkg := range []string{"webkit2gtk-4.1", "webkit2gtk-4.0"} {
		if out, err := exec.Command("pkg-config", "--modversion", pkg).Output(); err == nil {
			return true, pkg + " " + strings.TrimSpace(string(out))
		}
	}
	return false, "webkit2gtk not found via pkg-config"
}

func checkPlaywrightBrowser() (bool, string) {
	candidates := []string{
		os.Getenv("PLAYWRIGHT_BROWSERS_PATH"),
	}
	if cacheDir, err := os.UserCacheDir(); err == nil {
		candidates = append(candidates, filepath.Join(cacheDir, "ms-playwright"))
	}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates,
			filepath.Join(home, ".cache", "ms-playwright"),
			filepath.Join(home, "Library", "Caches", "ms-playwright"),
		)
	}

	for _, base := range candidates {
		if base == "" {
			continue
		}
		entries, err := os.ReadDir(base)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() && strings.HasPrefix(e.Name(), "chromium-") {
				return true, filepath.Join(base, e.Name())
			}
		}
	}
	return false, ""
}

