package security_test

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/backend"
	"amiro/tests/harness/process"
)

// servedBackend is an `amiro serve` process: the entrypoint that puts the
// API on an interface the operator chose.
//
// Two of this suite's checks are about behaviour that ONLY exists on this
// path and cannot be reached through harness.Backend():
//
//   - `--allow-origin` is a flag on `amiro serve` and `amiro --serve`
//     (backend-go/cmd/amiro/serve_cmd.go, cmd/amiro/tui.go). cmd/server --
//     the sidecar harness/backend spawns -- defines no flags at all and has
//     no way to set httpserver.Options.AllowedOrigins.
//   - the auth rate limiter is installed by cmd/amiro/serve_cmd.go's
//     embeddedOptions, and only when the bind host is not loopback.
//     cmd/server never installs it under any configuration.
//
// So these tests spawn the real `amiro` binary rather than reusing the
// harness's backend. Everything else about the isolation is unchanged:
// backend.Env builds the same stripped, redirected environment, and
// harness/process supervises the child, streams its stdio to the run
// directory, and asserts on teardown that it really went away.
type servedBackend struct {
	URL   string
	Port  int
	Token string
	proc  *process.Process
}

// startServe spawns `amiro serve` and returns once it has printed the port
// it bound. `amiro serve` prints the same `PORT=<n>` line cmd/server does,
// deliberately, "so a script that needs the port when --port was left at 0
// has one line to parse" (serve_cmd.go).
func startServe(t *testing.T, h *harness.Harness, name, host string, extraArgs ...string) *servedBackend {
	t.Helper()

	dir := filepath.Join(h.Dir(), name)
	appData := filepath.Join(dir, "appdata")
	workspace := filepath.Join(dir, "workspace")
	home := filepath.Join(dir, "home")
	for _, d := range []string{appData, workspace, home,
		filepath.Join(home, ".config"), filepath.Join(home, ".local", "share"), filepath.Join(home, ".cache"),
		filepath.Join(dir, "db")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	token := "serve-token-" + name + "-0123456789abcdef"
	h.Log.Redactor().Add(token)

	args := append([]string{
		"serve",
		"--host", host,
		// --no-ui is required, not incidental: this binary is built without
		// the embedui tag, so `amiro serve` would refuse to start rather
		// than serve a dashboard it does not carry.
		"--no-ui",
		"--token", token,
	}, extraArgs...)

	env := backend.Env(h.Config, backend.Paths{
		AppDataDir:    appData,
		WorkspaceRoot: workspace,
		Home:          home,
		DatabaseDSN:   filepath.Join(dir, "db", "amiro.db"),
	}, token)

	proc, err := process.Start(h.Log, process.Spec{
		Name:    "amiro-serve-" + name,
		Path:    h.TUIBinary(),
		Args:    args,
		Dir:     workspace,
		Env:     env,
		LogDir:  filepath.ToSlash(filepath.Join(h.Surface, h.TestID, name)),
		Surface: h.Surface,
		Test:    h.Address,
	})
	if err != nil {
		t.Fatalf("starting `amiro serve --host %s`: %v", host, err)
	}

	portLine, err := proc.WaitForLine(h.Ctx, "PORT=", 60*time.Second)
	if err != nil {
		_ = proc.Stop(h.Ctx)
		t.Fatalf("`amiro serve --host %s` never printed a port: %v", host, err)
	}
	port, err := strconv.Atoi(portLine)
	if err != nil {
		_ = proc.Stop(h.Ctx)
		t.Fatalf("`amiro serve` printed PORT=%q, which is not a port", portLine)
	}

	s := &servedBackend{
		// 0.0.0.0 is every interface, not a destination; dial loopback.
		URL:   "http://" + net.JoinHostPort(dialHostFor(host), strconv.Itoa(port)),
		Port:  port,
		Token: token,
		proc:  proc,
	}
	t.Cleanup(func() {
		if err := proc.Stop(h.Ctx); err != nil {
			t.Errorf("stopping `amiro serve --host %s`: %v", host, err)
		}
		if err := proc.AssertStopped(); err != nil {
			t.Errorf("%v", err)
		}
		if err := process.AssertPortFree(dialHostFor(host), port, 10*time.Second); err != nil {
			t.Errorf("%v", err)
		}
	})

	// Readiness is a predicate with a deadline, never a sleep: the PORT=
	// line says the listener is bound, /health says the server answers.
	if err := process.WaitFor(h.Ctx, fmt.Sprintf("GET %s/health to return 200", s.URL), 30*time.Second, func() error {
		resp, err := httpGet(s.URL+"/health", map[string]string{"X-Amiro-Token": token})
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return fmt.Errorf("status %d", resp.StatusCode)
		}
		return nil
	}); err != nil {
		t.Fatalf("`amiro serve --host %s` never became healthy: %v", host, err)
	}
	return s
}

func dialHostFor(bindHost string) string {
	switch bindHost {
	case "0.0.0.0", "":
		return "127.0.0.1"
	case "::":
		return "::1"
	default:
		return bindHost
	}
}
