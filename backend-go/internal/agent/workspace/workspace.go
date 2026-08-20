// Package workspace confines an agent's file access to one directory tree.
//
// Every filesystem tool an agent gets -- read, write, edit, glob, grep --
// takes its path from the model, which means every one of them is a path
// traversal waiting to happen. Rather than have each tool re-implement the
// check (and get it subtly wrong in a different way), they all resolve
// through a Workspace first: Resolve either returns an absolute path that
// is provably inside the root, or an error. A tool that never calls
// Resolve is the bug.
//
// This is deliberately separate from the permission engine
// (docs/agentic-loop-implementation-plan.md §2.5). Permissions answer "is
// the agent allowed to do this?", which is policy and can be relaxed by a
// user. Containment answers "is this path even in scope?", which is not
// negotiable -- an approved write to ../../.ssh/authorized_keys is still a
// write to ../../.ssh/authorized_keys.
package workspace

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// ErrEmptyPath is returned when a tool passes no path at all, which is
// always a caller bug rather than a containment failure.
var ErrEmptyPath = errors.New("workspace: empty path")

// EscapeError reports a path that resolved outside the workspace root.
// It carries both paths because the message is shown to the model, and a
// model that can see *why* its path was rejected corrects itself instead
// of retrying the same traversal.
type EscapeError struct {
	Path     string
	Resolved string
	Root     string
}

func (e *EscapeError) Error() string {
	return fmt.Sprintf("workspace: %q resolves to %q, outside the workspace root %q", e.Path, e.Resolved, e.Root)
}

// Workspace is a single directory tree an agent may touch.
type Workspace struct {
	mu            sync.RWMutex
	root          string   // absolute, symlinks already resolved
	readOnlyRoots []string // absolute, symlinks already resolved
}

// New roots a workspace at dir, which must exist and be a directory.
//
// The root is symlink-resolved once here so every later comparison is
// between two fully-resolved paths. Skipping this is the classic hole: if
// the root is /tmp/work but /tmp is itself a symlink to /private/tmp (the
// default on macOS), a resolved candidate path never string-matches the
// unresolved root and containment either rejects everything or, worse, is
// "fixed" by dropping the resolution step entirely.
func New(dir string) (*Workspace, error) {
	if strings.TrimSpace(dir) == "" {
		return nil, ErrEmptyPath
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, fmt.Errorf("workspace: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, fmt.Errorf("workspace: root %q: %w", dir, err)
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return nil, fmt.Errorf("workspace: root %q: %w", dir, err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("workspace: root %q is not a directory", dir)
	}
	return &Workspace{root: resolved}, nil
}

// Root returns the resolved absolute root.
func (w *Workspace) Root() string {
	if w == nil {
		return ""
	}
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.root
}

// Clone returns a fresh copy of the workspace with its roots intact.
func (w *Workspace) Clone() *Workspace {
	if w == nil {
		return nil
	}
	w.mu.RLock()
	defer w.mu.RUnlock()
	return &Workspace{
		root:          w.root,
		readOnlyRoots: append([]string(nil), w.readOnlyRoots...),
	}
}

// WithReadOnlyRoots returns a copy of the workspace with additional read-only roots attached.
// The primary root is unchanged.
func (w *Workspace) WithReadOnlyRoots(roots []string) *Workspace {
	if w == nil {
		return nil
	}
	resolvedRoots := make([]string, 0, len(roots))
	for _, r := range roots {
		if strings.TrimSpace(r) == "" {
			continue
		}
		abs, err := filepath.Abs(r)
		if err != nil {
			continue
		}
		if res, err := filepath.EvalSymlinks(abs); err == nil {
			resolvedRoots = append(resolvedRoots, res)
		} else {
			resolvedRoots = append(resolvedRoots, abs)
		}
	}
	w.mu.RLock()
	defer w.mu.RUnlock()
	return &Workspace{
		root:          w.root,
		readOnlyRoots: resolvedRoots,
	}
}

// AddReadOnlyRoots attaches additional read-only roots to the workspace in place.
func (w *Workspace) AddReadOnlyRoots(roots ...string) {
	if w == nil {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, r := range roots {
		if strings.TrimSpace(r) == "" {
			continue
		}
		abs, err := filepath.Abs(r)
		if err != nil {
			continue
		}
		res, err := filepath.EvalSymlinks(abs)
		if err != nil {
			res = abs
		}
		exists := false
		for _, existing := range w.readOnlyRoots {
			if existing == res {
				exists = true
				break
			}
		}
		if !exists {
			w.readOnlyRoots = append(w.readOnlyRoots, res)
		}
	}
}

// ReadOnlyRoots returns a copy of the configured read-only roots.
func (w *Workspace) ReadOnlyRoots() []string {
	if w == nil {
		return nil
	}
	w.mu.RLock()
	defer w.mu.RUnlock()
	return append([]string(nil), w.readOnlyRoots...)
}

// Resolve turns a model-supplied path -- relative to the root, or absolute
// -- into an absolute path guaranteed to sit inside the workspace.
//
// The path need not exist: creating a new file has to work. That is what
// makes this more than a filepath.Rel check. Symlinks can only be followed
// on the part of the path that exists, so Resolve walks up to the longest
// existing prefix, resolves *that*, and re-attaches the remainder. A
// nonexistent leaf under a symlinked-away parent is therefore still caught,
// which a naive "EvalSymlinks and ignore ErrNotExist" never catches.
func (w *Workspace) Resolve(p string) (string, error) {
	if strings.TrimSpace(p) == "" {
		return "", ErrEmptyPath
	}

	w.mu.RLock()
	root := w.root
	w.mu.RUnlock()

	abs := p
	if !filepath.IsAbs(abs) {
		abs = filepath.Join(root, abs)
	}
	abs = filepath.Clean(abs)

	resolved, err := resolveExistingPrefix(abs)
	if err != nil {
		return "", err
	}
	if !w.contains(resolved) {
		return "", &EscapeError{Path: p, Resolved: resolved, Root: root}
	}
	return resolved, nil
}

// ResolveReadable turns a model-supplied path into an absolute path guaranteed
// to sit inside either the workspace root or one of the configured read-only roots.
func (w *Workspace) ResolveReadable(p string) (string, error) {
	if strings.TrimSpace(p) == "" {
		return "", ErrEmptyPath
	}

	w.mu.RLock()
	defer w.mu.RUnlock()

	abs := p
	if !filepath.IsAbs(abs) {
		abs = filepath.Join(w.root, abs)
	}
	abs = filepath.Clean(abs)

	resolved, err := resolveExistingPrefix(abs)
	if err != nil {
		return "", err
	}
	if w.contains(resolved) {
		return resolved, nil
	}
	for _, ro := range w.readOnlyRoots {
		if containsInRoot(ro, resolved) {
			return resolved, nil
		}
	}
	return "", &EscapeError{Path: p, Resolved: resolved, Root: w.root}
}

// Rel expresses an absolute in-workspace path relative to the root, for
// display. Tool output quotes workspace-relative paths so a transcript
// doesn't leak the user's home directory layout into the model's context.
func (w *Workspace) Rel(abs string) (string, error) {
	w.mu.RLock()
	root := w.root
	w.mu.RUnlock()

	rel, err := filepath.Rel(root, abs)
	if err != nil {
		return "", fmt.Errorf("workspace: %w", err)
	}
	if escapes(rel) {
		return "", &EscapeError{Path: abs, Resolved: abs, Root: root}
	}
	return rel, nil
}

// RelReadable expresses an absolute path relative to the workspace root or
// the matching read-only root, falling back to Rel.
func (w *Workspace) RelReadable(abs string) (string, error) {
	if w == nil {
		return "", ErrEmptyPath
	}
	w.mu.RLock()
	defer w.mu.RUnlock()

	if rel, err := filepath.Rel(w.root, abs); err == nil && !escapes(rel) {
		return rel, nil
	}
	for _, ro := range w.readOnlyRoots {
		if containsInRoot(ro, abs) {
			rel, err := filepath.Rel(ro, abs)
			if err == nil && !escapes(rel) {
				return rel, nil
			}
		}
	}
	return w.Rel(abs)
}

// Contains reports whether an already-absolute, already-resolved path is
// inside the workspace.
func (w *Workspace) contains(abs string) bool {
	rel, err := filepath.Rel(w.root, abs)
	if err != nil {
		return false
	}
	return !escapes(rel)
}

func containsInRoot(root, abs string) bool {
	rel, err := filepath.Rel(root, abs)
	if err != nil {
		return false
	}
	return !escapes(rel)
}

func escapes(rel string) bool {
	return rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// resolveExistingPrefix resolves symlinks over the longest prefix of abs
// that exists on disk, then rejoins the trailing components that don't.
func resolveExistingPrefix(abs string) (string, error) {
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		return resolved, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("workspace: %w", err)
	}

	// Walk up to the nearest existing ancestor, remembering what we shed.
	var trailing []string
	cur := abs
	for {
		parent := filepath.Dir(cur)
		if parent == cur {
			// Reached the filesystem root without finding anything that
			// exists; nothing to resolve, so the cleaned path stands.
			return abs, nil
		}
		trailing = append([]string{filepath.Base(cur)}, trailing...)
		cur = parent

		resolved, err := filepath.EvalSymlinks(cur)
		if err == nil {
			return filepath.Join(append([]string{resolved}, trailing...)...), nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", fmt.Errorf("workspace: %w", err)
		}
	}
}
