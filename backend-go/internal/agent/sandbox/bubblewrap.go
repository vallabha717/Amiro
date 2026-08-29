//go:build linux

package sandbox

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

// bubblewrapBackend wraps a command with bwrap, Linux's unprivileged
// sandboxing tool. See docs/coding-agent-parity/03-sandboxed-execution.md's
// table: a new mount namespace makes the workspace root the only writable
// bind (everything else -- /, /usr, and so on -- is read-only), and a new
// network namespace has no route at all unless the command's prefix
// matched SandboxNetworkAllow.
type bubblewrapBackend struct {
	// bin is the resolved path to bwrap, filled in by detectBubblewrap.
	bin string
}

func (b *bubblewrapBackend) Name() string    { return "bubblewrap" }
func (b *bubblewrapBackend) Sandboxed() bool { return true }

// wrap builds bwrap's flag list. Order matters for bwrap: bind mounts are
// applied in the order given, so a later --bind can widen an earlier
// --ro-bind for the same path -- which is exactly what happens here: `/`
// is bound read-only first, then the workspace root (if any) is bound
// read-write over it.
func (b *bubblewrapBackend) wrap(argv []string, opts CommandOpts) []string {
	flags := []string{
		b.bin,
		// New mount and PID namespaces; --die-with-parent means an
		// abandoned sandboxed process cannot outlive the terminal
		// executor's own process, which os/exec's Cmd.Cancel already
		// assumes for everything else it runs.
		"--die-with-parent",
		"--unshare-pid",
		// The whole host filesystem, read-only, so the sandboxed process
		// can still read /usr, the Go toolchain, a monorepo's
		// node_modules living outside the workspace root -- reading
		// something global is a normal thing for build tooling to need;
		// writing to it is what this sandbox exists to prevent.
		"--ro-bind", "/", "/",
		"--proc", "/proc",
		"--dev", "/dev",
		"--tmpfs", "/tmp",
	}
	if opts.Dir != "" {
		// Bound read-write *after* the read-only "/", so it wins for
		// exactly this one path. Everything else stays read-only.
		flags = append(flags, "--bind", opts.Dir, opts.Dir)
		flags = append(flags, "--chdir", opts.Dir)
	}
	if !opts.NetworkAllowed {
		// No route at all: a fresh network namespace with nothing
		// configured in it, not even loopback. Verified in this
		// environment: curl to 127.0.0.1 and to a real external host
		// both fail with "Couldn't connect" the instant --unshare-net is
		// present, with or without a network-allow entry.
		flags = append(flags, "--unshare-net")
	}
	flags = append(flags, "--")
	return append(flags, argv...)
}

// detectBubblewrap looks for bwrap on PATH and smoke-tests it: an
// unprivileged binary present but unable to create namespaces (a
// restrictive container with user namespaces disabled, say) must fall
// through to none.go exactly like "not found" -- see detect.go's doc
// comment on why a failed smoke test and a missing binary are the same
// outcome.
func detectBubblewrap() Backend {
	bin, err := exec.LookPath("bwrap")
	if err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// The smoke command mirrors real usage as closely as a one-liner can:
	// a read-only root bind, a fresh net namespace, /bin/true. If bwrap
	// can't even do that here, it can't do anything else here either.
	cmd := exec.CommandContext(ctx, bin,
		"--die-with-parent", "--unshare-pid", "--unshare-net",
		"--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
		"--", "/bin/true")
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil
	}
	return &bubblewrapBackend{bin: bin}
}
