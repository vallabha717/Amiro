package backend

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// CopyWorkspace copies a fixture workspace into the run directory.
//
// Workspaces are always COPIED, never used in place. The agent's file tools
// write, and a test that mutates a fixture poisons every test after it. The
// copy is what AMIRO_WORKSPACE_ROOT points at, and it survives in the run
// directory on failure so you can see exactly what the agent did to it.
func CopyWorkspace(src, dst string) error {
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	if src == "" {
		return nil // An empty workspace is a valid one.
	}
	info, err := os.Stat(src)
	if err != nil {
		return fmt.Errorf("workspace fixture %s: %w", src, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("workspace fixture %s is not a directory", src)
	}
	return filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		// A symlink is copied as a symlink: fixtures/workspaces/unicode
		// contains them deliberately, to exercise path escaping in the file
		// tools, and following them here would silently defeat that.
		if d.Type()&os.ModeSymlink != 0 {
			dest, err := os.Readlink(path)
			if err != nil {
				return err
			}
			return os.Symlink(dest, target)
		}
		return copyFile(path, target)
	})
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode().Perm())
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

// DefaultWorkspace is the fixture used when backend.workspaceRoot is unset.
const DefaultWorkspace = "fixtures/workspaces/basic"

// ResolveWorkspaceFixture picks the fixture directory to copy: the
// configured one if set, otherwise the default. A configured path that does
// not exist has already been rejected by config validation, so a miss here
// can only be the default fixture being absent, which is a broken checkout
// rather than a user error -- hence the different message.
func ResolveWorkspaceFixture(baseDir, configured string) (string, error) {
	if configured != "" {
		return configured, nil
	}
	fixture := filepath.Join(baseDir, filepath.FromSlash(DefaultWorkspace))
	if _, err := os.Stat(fixture); err != nil {
		return "", fmt.Errorf("the default workspace fixture is missing from this checkout: %s", fixture)
	}
	return fixture, nil
}

// SanitizeTestID turns a Go test name into something safe for a directory
// name on every platform, including the subtest slashes Go inserts.
func SanitizeTestID(name string) string {
	replacer := strings.NewReplacer("/", "-", "\\", "-", ":", "-", "*", "-", "?", "-",
		"\"", "-", "<", "-", ">", "-", "|", "-", " ", "_")
	return replacer.Replace(name)
}
