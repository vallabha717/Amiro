// Package backend builds, starts, isolates and stops the Go server under
// test. It is the only package that knows the application's own AMIRO_*
// environment variable names.
package backend

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"amiro/tests/harness/logging"
)

// BuildSpec names one binary to produce.
type BuildSpec struct {
	// RepoRoot is the repository root; the Go module lives at
	// <RepoRoot>/backend-go.
	RepoRoot string
	// Package is the import path relative to backend-go, e.g. "./cmd/server".
	Package string
	// Name is the output binary's name and its cache key prefix.
	Name string
	// Tags are Go build tags. The UI surface needs "embedui" so `amiro
	// serve` has a dashboard compiled into it; the backend surface does not
	// and should not pay for it.
	Tags []string
	// Override skips the build entirely and uses this path -- config's
	// backend.binary / tui.binary, which is what CI sets.
	Override string
}

// buildLocks serialises builds of the same binary within one process.
// Several parallel tests calling Build for the first time must not run
// `go build` concurrently into the same output path.
var (
	buildMu    sync.Mutex
	buildLocks = map[string]*sync.Mutex{}
)

func lockFor(key string) *sync.Mutex {
	buildMu.Lock()
	defer buildMu.Unlock()
	if l, ok := buildLocks[key]; ok {
		return l
	}
	l := &sync.Mutex{}
	buildLocks[key] = l
	return l
}

// Build produces (or reuses) the binary and returns its path.
//
// The cache key is a content hash of the Go source tree, so a rebuild
// happens exactly when the source changed and never otherwise. Caching by
// mtime would rebuild after every `git checkout`; caching by nothing would
// add ~20s to every single test.
//
// The binary is written to a temp name and renamed into place, which makes
// the cache safe against a second PROCESS building the same thing at the
// same time -- `go test ./suites/backend/... ./suites/tui/...` is two
// processes, and rename is atomic where a partial write is not.
func Build(ctx context.Context, log *logging.Logger, spec BuildSpec) (string, error) {
	if spec.Override != "" {
		abs, err := filepath.Abs(spec.Override)
		if err != nil {
			return "", err
		}
		if _, err := os.Stat(abs); err != nil {
			return "", fmt.Errorf("configured binary %s: %w", abs, err)
		}
		return abs, nil
	}

	moduleDir := filepath.Join(spec.RepoRoot, "backend-go")
	if slices.Contains(spec.Tags, "embedui") {
		distHTML := filepath.Join(moduleDir, "internal", "web", "dist", "index.html")
		if _, err := os.Stat(distHTML); err != nil {
			return "", fmt.Errorf("embedded UI requested (-tags embedui) but %s is missing: run ./scripts/build-ui.sh first", distHTML)
		}
	}
	hash, err := hashTree(moduleDir, spec.Tags)
	if err != nil {
		return "", fmt.Errorf("hashing %s: %w", moduleDir, err)
	}
	key := spec.Name
	if len(spec.Tags) > 0 {
		key += "-" + strings.Join(spec.Tags, "-")
	}
	cacheDir, err := CacheDir()
	if err != nil {
		return "", err
	}
	out := filepath.Join(cacheDir, fmt.Sprintf("%s-%s%s", key, hash[:16], exeSuffix()))

	l := lockFor(out)
	l.Lock()
	defer l.Unlock()

	if _, err := os.Stat(out); err == nil {
		return out, nil
	}
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		return "", err
	}

	started := time.Now()
	tmp := out + ".tmp." + fmt.Sprint(os.Getpid())
	args := []string{"build", "-o", tmp}
	if len(spec.Tags) > 0 {
		args = append(args, "-tags", strings.Join(spec.Tags, ","))
	}
	args = append(args, spec.Package)

	cmd := exec.CommandContext(ctx, "go", args...)
	cmd.Dir = moduleDir
	combined, buildErr := cmd.CombinedOutput()
	if log != nil {
		_ = log.WriteFile("backend/build-"+key+".log", combined)
	}
	if buildErr != nil {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("building %s (%s):\n%s", spec.Package, buildErr, combined)
	}
	if err := os.Rename(tmp, out); err != nil {
		// Another process won the race and put an identical binary there.
		// Its content is determined by the same source hash, so either
		// answer is correct; prefer theirs and drop ours.
		if _, statErr := os.Stat(out); statErr == nil {
			_ = os.Remove(tmp)
			return out, nil
		}
		return "", err
	}
	if log != nil {
		log.Emit(logging.Event{Surface: "backend", Kind: logging.KindProcess, Msg: "built",
			Detail: map[string]any{"package": spec.Package, "out": out, "ms": time.Since(started).Milliseconds()}})
	}
	return out, nil
}

// CacheDir is where built binaries live between runs. Outside the run
// directory on purpose: a binary survives log pruning, which is what makes
// the second run of the day start in milliseconds.
func CacheDir() (string, error) {
	base, err := os.UserCacheDir()
	if err != nil {
		base = os.TempDir()
	}
	return filepath.Join(base, "amiro-tests", "bin"), nil
}

// hashTree hashes every file that can affect the build output.
//
// Content, not mtime: a `git checkout` rewrites mtimes without changing a
// byte, and rebuilding the world after every branch switch is the thing
// this cache exists to avoid. Paths are included alongside contents so that
// renaming a file is a change even when no content moved.
func hashTree(dir string, tags []string) (string, error) {
	includeDist := slices.Contains(tags, "embedui")
	distDir := filepath.Join(dir, "internal", "web", "dist")

	var files []string
	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			switch d.Name() {
			case ".git", "node_modules", "bin", "testdata":
				return filepath.SkipDir
			case "dist":
				if filepath.Dir(path) == filepath.Join(dir, "internal", "web") && !includeDist {
					return filepath.SkipDir
				}
			}
			return nil
		}
		if includeDist && strings.HasPrefix(path, distDir) {
			files = append(files, path)
			return nil
		}
		name := d.Name()
		if strings.HasSuffix(name, ".go") || name == "go.mod" || name == "go.sum" {
			// _test.go files cannot change the built binary, and including
			// them would invalidate the cache every time a test is edited --
			// which is most of the time, in this repository especially.
			if strings.HasSuffix(name, "_test.go") {
				return nil
			}
			files = append(files, path)
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Strings(files)

	h := sha256.New()
	// The toolchain is part of the answer: the same source built by a
	// different Go version is a different binary.
	fmt.Fprintf(h, "go:%s\n", runtime.Version())
	for _, path := range files {
		rel, _ := filepath.Rel(dir, path)
		fmt.Fprintf(h, "%s\n", filepath.ToSlash(rel))
		f, err := os.Open(path)
		if err != nil {
			return "", err
		}
		if _, err := io.Copy(h, f); err != nil {
			f.Close()
			return "", err
		}
		f.Close()
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func exeSuffix() string {
	if runtime.GOOS == "windows" {
		return ".exe"
	}
	return ""
}

// FindRepoRoot walks up from baseDir looking for the repository root -- the
// directory holding backend-go/. tests/ is a sibling of it, so this is one
// step up in the normal case, but the walk keeps it working from anywhere.
func FindRepoRoot(baseDir string) (string, error) {
	dir, err := filepath.Abs(baseDir)
	if err != nil {
		return "", err
	}
	for {
		if info, err := os.Stat(filepath.Join(dir, "backend-go", "go.mod")); err == nil && !info.IsDir() {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("could not find the repository root above %s (looked for backend-go/go.mod)", baseDir)
		}
		dir = parent
	}
}
