//go:build darwin

package sandbox

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"time"
)

// seatbeltBackend wraps a command with macOS's sandbox-exec and a
// generated profile: writes confined to the workspace root, network denied
// by default via the profile's `deny network*`. See
// docs/coding-agent-parity/03-sandboxed-execution.md's table.
//
// sandbox-exec is formally deprecated by Apple with no public replacement
// API offered in its place; it remains the only per-process sandboxing
// primitive available without an app extension entitlement Amiro's sidecar
// does not have, and it is what every other coding agent shipping macOS
// sandboxing (named in docs/03-sandboxed-execution.md's precedent) uses for
// the same reason.
type seatbeltBackend struct {
	bin string
}

func (b *seatbeltBackend) Name() string    { return "seatbelt" }
func (b *seatbeltBackend) Sandboxed() bool { return true }

// profile renders an SBPL (Sandbox Profile Language) document. Deny-by-
// default, then a narrow set of allows: process exec (the command has to
// run at all), read-anything (build tooling reaches for the toolchain,
// global caches, and so on -- read access is not what this sandbox is
// protecting), write confined to dir, and network only when explicitly
// allowed for this command.
func profile(dir string, networkAllowed bool) string {
	writeRule := `(deny file-write*)`
	if dir != "" {
		writeRule = fmt.Sprintf(`(allow file-write* (subpath %q))`, dir)
	}
	networkRule := `(deny network*)`
	if networkAllowed {
		networkRule = `(allow network*)`
	}
	return fmt.Sprintf(`(version 1)
(allow process-exec*)
(allow process-fork)
(allow file-read*)
(allow sysctl-read)
(allow mach-lookup)
%s
%s
`, writeRule, networkRule)
}

func (b *seatbeltBackend) wrap(argv []string, opts CommandOpts) []string {
	// sandbox-exec -p <profile> -- argv...
	// The profile is passed inline via -p rather than a temp file: it is
	// small, generated fresh per call (it embeds this command's own
	// dir/network decision), and a temp file would be one more thing to
	// clean up on every code path, including the ones that panic.
	p := profile(opts.Dir, opts.NetworkAllowed)
	return append([]string{b.bin, "-p", p, "--"}, argv...)
}

// detectSeatbelt looks for sandbox-exec (normally /usr/bin/sandbox-exec,
// present on every macOS install) and smoke-tests it the same way
// detectBubblewrap does: a real invocation, not just a PATH check, because
// a profile sandbox-exec can't parse or a signing/entitlement restriction
// that blocks it outright must fall through to none.go exactly like "not
// found."
func detectSeatbelt() Backend {
	bin, err := exec.LookPath("sandbox-exec")
	if err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	p := profile("", false)
	cmd := exec.CommandContext(ctx, bin, "-p", p, "--", "/usr/bin/true")
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return nil
	}
	return &seatbeltBackend{bin: bin}
}
