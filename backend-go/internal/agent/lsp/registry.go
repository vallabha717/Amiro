package lsp

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

// ServerSpec describes how to launch a language server and what it covers.
type ServerSpec struct {
	Lang string   // LSP languageId, sent on didOpen
	Bin  string   // executable name, looked up on PATH
	Args []string // arguments after the binary
	Exts []string // file extensions this server handles

	// RootMarkers are files whose presence in the workspace means this
	// language is actually used here. Extension matching alone is not
	// enough: one stray .py script in a Go repository should not cost the
	// user a Python language server, its memory, and its indexing time.
	RootMarkers []string

	// Root is where the server is actually started, filled in by Available.
	// It is the directory the marker was found in, which is not always the
	// workspace root -- see findMarker.
	Root string
}

// knownServers is deliberately a short list of the servers that are both
// widely installed and stable over stdio.
//
// It is not configurable yet, and that is a real limitation worth naming:
// a user with a language server this list does not know cannot add one.
// Making it configurable means a settings surface for spawning arbitrary
// executables, which is a permission question (the user is authorizing a
// program to run, not a tool to be called) and belongs with the Phase 3
// machinery rather than bolted onto a discovery list.
var knownServers = []ServerSpec{
	{
		Lang: "go", Bin: "gopls", Exts: []string{".go"},
		RootMarkers: []string{"go.mod", "go.work"},
	},
	{
		Lang: "typescript", Bin: "typescript-language-server", Args: []string{"--stdio"},
		Exts:        []string{".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"},
		RootMarkers: []string{"tsconfig.json", "jsconfig.json", "package.json"},
	},
	{
		Lang: "python", Bin: "pyright-langserver", Args: []string{"--stdio"},
		Exts:        []string{".py", ".pyi"},
		RootMarkers: []string{"pyproject.toml", "setup.py", "requirements.txt"},
	},
	{
		Lang: "rust", Bin: "rust-analyzer", Exts: []string{".rs"},
		RootMarkers: []string{"Cargo.toml"},
	},
}

// extraLookupDirs are places a language server commonly lives that a
// GUI-launched desktop app's PATH does not include.
//
// This matters more than it looks. On macOS and Linux a windowed app
// inherits the session's PATH, not the login shell's, so `~/go/bin` and
// `~/.local/bin` -- where `go install` and `pip install --user` put things
// -- are routinely absent. Without this the feature would work when the
// developer runs the binary from a terminal and silently not work for the
// user who launched it from the dock, which is the worst possible split.
func extraLookupDirs() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	return []string{
		filepath.Join(home, "go", "bin"),
		filepath.Join(home, ".local", "bin"),
		filepath.Join(home, ".cargo", "bin"),
		"/usr/local/bin",
		"/opt/homebrew/bin",
	}
}

// lookPath finds an executable on PATH or in extraLookupDirs.
func lookPath(bin string) (string, bool) {
	if p, err := exec.LookPath(bin); err == nil {
		return p, true
	}
	for _, dir := range extraLookupDirs() {
		candidate := filepath.Join(dir, bin)
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return candidate, true
		}
	}
	return "", false
}

// Available returns the specs whose server is installed AND whose language
// is actually used in root, with the resolved binary path filled in.
//
// Both halves are required. Installed-but-unused spawns a server for a
// language the repo does not contain; used-but-not-installed offers a tool
// that will fail on first call, which costs a turn and teaches the model
// nothing.
func Available(root string) []ServerSpec {
	var out []ServerSpec
	for _, spec := range knownServers {
		bin, ok := lookPath(spec.Bin)
		if !ok {
			continue
		}
		at, ok := findMarker(root, spec.RootMarkers)
		if !ok {
			continue
		}
		found := spec
		found.Bin = bin
		found.Root = at
		out = append(out, found)
	}
	return out
}

// markerSearchDepth is how far below the workspace root a project marker is
// looked for.
//
// Zero -- checking only the root -- was the first implementation and it was
// wrong for the most common real layout there is. This repository has
// `package.json` at the top and `go.mod` in `backend-go/`, so a root-only
// check found no Go project and the `lsp` tool silently never appeared,
// which is the exact failure the "not offered rather than broken" design
// was supposed to make impossible to hit *by accident*. Two levels reaches
// `backend-go/`, `packages/api/`, `services/worker/` and the rest of the
// usual monorepo shapes.
const markerSearchDepth = 2

// findMarker locates the directory a language's project actually lives in.
//
// It returns that directory rather than the workspace root, and the server
// is started there. Rooting gopls at a repository whose go.mod is one level
// down puts it in a mode where it answers nothing useful -- the honest fix
// is to tell it where the module is, not to hope it finds it.
//
// The first match wins, and directories are walked in lexical order, so a
// repository with two Go modules gets a server for whichever sorts first.
// That is a real limitation and the right next step is a server per module,
// not a deeper search.
func findMarker(root string, markers []string) (string, bool) {
	var search func(dir string, depth int) (string, bool)
	search = func(dir string, depth int) (string, bool) {
		for _, m := range markers {
			if _, err := os.Stat(filepath.Join(dir, m)); err == nil {
				return dir, true
			}
		}
		if depth >= markerSearchDepth {
			return "", false
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return "", false
		}
		for _, e := range entries {
			if !e.IsDir() || strings.HasPrefix(e.Name(), ".") || alwaysSkippedDir[e.Name()] {
				continue
			}
			if found, ok := search(filepath.Join(dir, e.Name()), depth+1); ok {
				return found, true
			}
		}
		return "", false
	}
	return search(root, 0)
}

// alwaysSkippedDir keeps the marker search out of dependency trees, where
// every one of these markers appears hundreds of times and none of them
// describes the user's project.
var alwaysSkippedDir = map[string]bool{
	"node_modules": true, "vendor": true, "target": true, "dist": true,
	"build": true, ".venv": true, "__pycache__": true, "testdata": true,
}

// Pool keeps at most one running server per language for one workspace.
//
// Each server is rooted where its project actually is, which may be below
// the workspace root -- see findMarker.
//
// Servers start lazily on first use and stay up for the process lifetime.
// gopls needs seconds to tens of seconds to index a repository before its
// first useful answer; restarting per request would make every call slower
// than the grep it is meant to beat.
type Pool struct {
	root  string
	specs []ServerSpec

	mu      sync.Mutex
	servers map[string]*Server
	failed  map[string]bool // a server that failed to start is not retried
}

// NewPool returns a pool for root, or nil when no usable server exists.
//
// nil rather than an empty pool, so the caller's "is this available?"
// check is a nil check and the `lsp` tool is simply never constructed.
func NewPool(root string) *Pool {
	specs := Available(root)
	if len(specs) == 0 {
		return nil
	}
	return &Pool{root: root, specs: specs, servers: map[string]*Server{}, failed: map[string]bool{}}
}

// Languages lists what this pool can serve, for the tool description.
func (p *Pool) Languages() []string {
	if p == nil {
		return nil
	}
	out := make([]string, 0, len(p.specs))
	for _, s := range p.specs {
		out = append(out, s.Lang)
	}
	return out
}

// For returns a started server able to handle path, or nil.
func (p *Pool) For(ctx context.Context, path string) (*Server, error) {
	if p == nil {
		return nil, nil
	}
	ext := strings.ToLower(filepath.Ext(path))
	var spec *ServerSpec
	for i := range p.specs {
		for _, e := range p.specs[i].Exts {
			if e == ext {
				spec = &p.specs[i]
				break
			}
		}
		if spec != nil {
			break
		}
	}
	if spec == nil {
		return nil, nil
	}

	p.mu.Lock()
	if p.failed[spec.Lang] {
		p.mu.Unlock()
		return nil, nil
	}
	if s, ok := p.servers[spec.Lang]; ok {
		p.mu.Unlock()
		return s, nil
	}
	p.mu.Unlock()

	// Started outside the lock: initialize can take tens of seconds, and
	// holding the pool lock across it would serialize every other language's
	// first call behind this one.
	s, err := Start(ctx, spec.Lang, spec.Root, append([]string{spec.Bin}, spec.Args...))

	p.mu.Lock()
	defer p.mu.Unlock()
	if err != nil {
		// Remembered, not retried. A missing dependency or a broken install
		// fails identically every time, and retrying it on every tool call
		// would spend the turn's wall-clock budget re-learning that.
		p.failed[spec.Lang] = true
		return nil, err
	}
	if existing, ok := p.servers[spec.Lang]; ok {
		// Another goroutine won the race; keep theirs and drop ours.
		go func() { _ = s.Close() }()
		return existing, nil
	}
	p.servers[spec.Lang] = s
	return s, nil
}

// Close shuts every running server down.
func (p *Pool) Close() {
	if p == nil {
		return
	}
	p.mu.Lock()
	servers := make([]*Server, 0, len(p.servers))
	for _, s := range p.servers {
		servers = append(servers, s)
	}
	p.servers = map[string]*Server{}
	p.mu.Unlock()

	for _, s := range servers {
		_ = s.Close()
	}
}
