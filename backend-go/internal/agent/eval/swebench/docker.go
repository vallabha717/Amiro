package swebench

import (
	"archive/tar"
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// The container boundary.
//
// Two operations cross it, and they are deliberately the only two:
//
//   - Materialize copies the instance's repository *out* of its image onto
//     the host, once, so the agent has an ordinary directory to work in. The
//     agent's tools are host filesystem tools; giving them a container to
//     reach into would mean a second workspace implementation whose bugs are
//     invisible to every existing test.
//   - Verify carries the agent's work back *in*, as a patch, and runs the
//     instance's own eval script against it.
//
// Sending a patch rather than a directory is not an optimization, it is the
// benchmark's own contract: SWE-bench evaluates a `model_patch` applied to a
// pristine checkout. Copying the agent's whole tree back would also carry
// whatever else it left lying around -- build artifacts, a virtualenv, an
// accidentally-deleted test file -- and score those too.
//
// # Why everything moves as a tar stream and nothing as a path
//
// Both directions could be written far more briefly with `docker cp` to a
// host directory and a `-v` bind mount. Both of those ask the *daemon* to
// resolve a path on the host's filesystem, and the daemon frequently cannot:
// a snap-confined docker sees almost nothing outside $HOME, a rootless daemon
// has its own mount namespace, and a remote or VM-backed daemon (Docker
// Desktop, a DOCKER_HOST over ssh) has no access to these bytes at all.
//
// This was not a theoretical concern -- the first version used both, and the
// integration test failed immediately on a snap docker with "invalid output
// path: directory /tmp/... does not exist". The failure is also the nastiest
// possible shape: it looks like a broken checkout rather than like a
// misconfigured daemon. Streaming tar through the CLI's stdin and stdout
// makes the transfer depend only on the pipe, so it works identically for
// every daemon topology.
var dockerBin = "docker"

// Available reports whether Docker can be reached.
//
// Used to skip rather than fail: a machine without Docker cannot run this
// suite, and that is a fact about the machine. It is reported once, by name,
// instead of surfacing as every instance erroring with a different message.
func Available(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, dockerBin, "info", "--format", "{{.ServerVersion}}")
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("swebench: docker is not available: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// testbedPath is where every SWE-bench image checks its repository out.
const testbedPath = "/testbed"

// patchFailedMarker is how run.sh reports that the agent's patch would not
// apply. A sentinel in the log rather than an exit code, because the eval
// script's own exit code is already carrying "some test failed" and the two
// must not be confused: one is a wrong answer, the other is no answer at all.
const patchFailedMarker = "amiro: PATCH FAILED TO APPLY"

// Materialize copies an instance's repository out of its image into dir.
//
// The result is a git working tree at the instance's base commit -- the same
// state the benchmark starts from. It keeps its `.git`, which is load-bearing
// twice over: it is how the agent's changes are turned back into a patch at
// verification time, and it is what lets the agent orient itself with the
// tools it actually has (git log, git diff) rather than reasoning about a
// directory that fell out of the sky.
//
// The source is a created-but-never-started container, so nothing the image's
// entrypoint would have done can affect what is copied.
func Materialize(ctx context.Context, in Instance, dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("swebench: %w", err)
	}

	container, err := createContainer(ctx, in.Image)
	if err != nil {
		return fmt.Errorf("swebench: %s: %w", in.ID, err)
	}
	defer removeContainer(container)

	cmd := exec.CommandContext(ctx, dockerBin, "cp", container+":"+testbedPath, "-")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("swebench: %w", err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("swebench: %s: docker cp: %w", in.ID, err)
	}
	// `docker cp <container>:/testbed -` emits a tar whose entries are all
	// under a top-level `testbed/`. Stripping it puts the repository at the
	// root of dir rather than at dir/testbed.
	untarErr := untar(stdout, dir, "testbed")
	// Drain whatever is left, or the CLI blocks on a full pipe and Wait never
	// returns -- a hang, which is far worse to diagnose than an error.
	_, _ = io.Copy(io.Discard, stdout)
	waitErr := cmd.Wait()

	if untarErr != nil {
		return fmt.Errorf("swebench: %s: extracting %s: %w", in.ID, testbedPath, untarErr)
	}
	if waitErr != nil {
		return fmt.Errorf("swebench: %s: docker cp: %w: %s", in.ID, waitErr, clip(stderr.String()))
	}
	return nil
}

// PatchFrom reconstructs what the agent changed, by reading the workspace.
//
// This is the harness's central rule applied to SWE-bench:
// TestRunner_ScoresByTheWorkspaceNotByWhatTheAgentSays. The patch is computed
// from git's view of the tree the agent left behind -- not from the edit_file
// calls it made, not from anything it said it did. An agent that reports six
// edits and made none produces an empty patch here and scores zero.
//
// Untracked files are included (via `git add -N`) because a fix that adds a
// new module is a real fix, and a diff that silently omitted it would score
// the agent wrong in the one direction that looks like a scaffold bug.
func PatchFrom(ctx context.Context, root string) (string, error) {
	// The materialized tree is owned by whoever the copy ran as, which git
	// may refuse to operate on. The harness created this directory itself, so
	// vouching for it is a statement of fact, not a loosening.
	safe := exec.CommandContext(ctx, "git", "-C", root, "config", "--local", "safe.directory", root)
	_ = safe.Run()

	// Intent-to-add stages untracked files' existence without their content,
	// which is exactly enough to make them appear in `git diff`.
	add := exec.CommandContext(ctx, "git", "-C", root, "add", "-A", "-N")
	if out, err := add.CombinedOutput(); err != nil {
		return "", fmt.Errorf("swebench: git add -N: %w: %s", err, clip(string(out)))
	}

	// No color, no ext-diff: this output is going to `git apply` inside a
	// container, not to a person.
	diff := exec.CommandContext(ctx, "git", "-C", root,
		"-c", "core.fileMode=false", "diff", "--no-color", "--no-ext-diff", "--binary", "HEAD")
	out, err := diff.Output()
	if err != nil {
		return "", fmt.Errorf("swebench: git diff: %w", err)
	}
	return string(out), nil
}

// RunEval applies a patch inside a fresh container from the instance's image
// and runs the instance's own eval script, returning the combined log.
//
// A fresh container per verification, never a reused one: the eval script
// installs the package and mutates /testbed, so a second run against a
// container that already ran one is scoring a different starting state than
// the benchmark defines. The image is the pristine state, and starting from it
// every time is the only way that stays true.
//
// The patch and the scripts are delivered as files rather than interpolated
// into a shell command. A patch is arbitrary text full of quotes, backslashes,
// dollar signs and heredoc markers, and the failure mode of getting that
// wrong is a mangled patch that fails to apply -- which reads exactly like an
// agent that produced a bad fix.
func RunEval(ctx context.Context, in Instance, patch string) (string, error) {
	container, err := createContainer(ctx, in.Image, "bash", "/amiro/run.sh")
	if err != nil {
		return "", fmt.Errorf("swebench: %s: %w", in.ID, err)
	}
	defer removeContainer(container)

	payload, err := tarFiles(map[string]string{
		"amiro/run.sh":      runScript,
		"amiro/eval.sh":     in.EvalScript,
		"amiro/model.patch": patch,
	})
	if err != nil {
		return "", fmt.Errorf("swebench: %w", err)
	}

	cp := exec.CommandContext(ctx, dockerBin, "cp", "-", container+":/")
	cp.Stdin = bytes.NewReader(payload)
	if out, err := cp.CombinedOutput(); err != nil {
		return "", fmt.Errorf("swebench: %s: docker cp into container: %w: %s", in.ID, err, clip(string(out)))
	}

	// `start -a` attaches, so the eval script's output comes back on the
	// pipe. A non-zero exit is expected and not an error: the script exits
	// non-zero whenever any test failed, which is most of what this measures.
	// The log is the result; only a failure to *produce* one is an error.
	run := exec.CommandContext(ctx, dockerBin, "start", "-a", container)
	out, err := run.CombinedOutput()
	if err != nil && len(out) == 0 {
		return "", fmt.Errorf("swebench: %s: docker start: %w", in.ID, err)
	}
	return string(out), nil
}

func createContainer(ctx context.Context, image string, argv ...string) (string, error) {
	// No network. The agent has already finished; the only thing a suite
	// reaches the network for at this point is flakiness, and a benchmark
	// result that depends on a CDN is not a measurement. (The eval script's
	// `pip install -e .` resolves from the image's own environment, which is
	// the reason these images exist.)
	args := append([]string{"create", "--network", "none", image}, argv...)
	out, err := exec.CommandContext(ctx, dockerBin, args...).Output()
	if err != nil {
		return "", fmt.Errorf("docker create %s: %w", image, err)
	}
	return strings.TrimSpace(string(out)), nil
}

// removeContainer is best effort: a leaked stopped container costs disk, and
// failing an instance because cleanup failed would throw away a finished run.
func removeContainer(id string) {
	if id != "" {
		_ = exec.Command(dockerBin, "rm", "-f", id).Run()
	}
}

// tarFiles builds an in-memory tar of the given path->content pairs.
func tarFiles(files map[string]string) ([]byte, error) {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for name, content := range files {
		if err := tw.WriteHeader(&tar.Header{
			Name: name,
			Mode: 0o755,
			Size: int64(len(content)),
		}); err != nil {
			return nil, err
		}
		if _, err := io.WriteString(tw, content); err != nil {
			return nil, err
		}
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// untar extracts a tar stream into dir, dropping the leading path component
// named strip.
//
// Entries that would escape dir are refused rather than skipped. The archive
// here comes from an image this harness chose to run, so this is not a
// security boundary -- it is a guard against a path bug silently scattering a
// repository across the filesystem, which is the kind of thing that is only
// noticed much later.
func untar(r io.Reader, dir, strip string) error {
	tr := tar.NewReader(r)
	prefix := strip + "/"
	for {
		header, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}

		name := header.Name
		switch {
		case name == strip || name == prefix:
			continue
		case strings.HasPrefix(name, prefix):
			name = strings.TrimPrefix(name, prefix)
		}
		if name == "" {
			continue
		}

		target := filepath.Join(dir, filepath.Clean("/"+name))
		if !strings.HasPrefix(target, filepath.Clean(dir)+string(os.PathSeparator)) {
			return fmt.Errorf("entry %q escapes the destination", header.Name)
		}

		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			f, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, os.FileMode(header.Mode).Perm()|0o600)
			if err != nil {
				return err
			}
			if _, err := io.Copy(f, tr); err != nil {
				f.Close()
				return err
			}
			if err := f.Close(); err != nil {
				return err
			}
		case tar.TypeSymlink:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			// Removed first: extraction may be re-run over a partial tree.
			_ = os.Remove(target)
			if err := os.Symlink(header.Linkname, target); err != nil {
				return err
			}
		default:
			// Devices, fifos and hardlinks do not appear in a source checkout
			// and are not worth reproducing. Skipped rather than refused: one
			// stray entry should not cost the whole instance.
		}
	}
}

// runScript applies the agent's patch, then hands off to the instance's own
// eval script.
//
// `git apply` is tried in three escalating forms because a patch produced by
// one git version against a tree checked out by another legitimately needs
// them: the plain form, then with whitespace correction, then the three-way
// merge that can reconstruct context it cannot match exactly. Falling through
// all three is a real failure and says so on the log, where the parser will
// find no test results and report *that* rather than pretending the tests ran
// and failed.
//
// An empty patch is applied trivially and successfully -- an agent that
// changed nothing must reach the tests and fail them, not error out. "Did
// nothing" and "broke the harness" are different results.
const runScript = `#!/bin/bash
set -uo pipefail
cd /testbed
git config --global --add safe.directory /testbed

if [ -s /amiro/model.patch ]; then
  if git apply -v /amiro/model.patch; then
    echo "amiro: patch applied"
  elif git apply -v --whitespace=fix /amiro/model.patch; then
    echo "amiro: patch applied (whitespace fixed)"
  elif git apply -v --3way /amiro/model.patch; then
    echo "amiro: patch applied (3-way)"
  else
    echo "amiro: PATCH FAILED TO APPLY"
    exit 1
  fi
else
  echo "amiro: empty patch, nothing to apply"
fi

bash /amiro/eval.sh
`

func sanitize(s string) string {
	var b strings.Builder
	for _, c := range s {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' {
			b.WriteRune(c)
		} else {
			b.WriteRune('-')
		}
	}
	return b.String()
}

func clip(s string) string {
	const max = 2000
	if len(s) <= max {
		return s
	}
	return s[:max] + "\n... (truncated)"
}
