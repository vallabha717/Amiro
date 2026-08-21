package skills

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// WritableRoot returns the resolved path of ~/.agents/skills/, creating it if absent.
// It is the sole directory Amiro may write skills into.
func WritableRoot(home string) (string, error) {
	if home == "" {
		return "", errors.New("home directory is not set")
	}
	root := filepath.Join(home, ".agents", "skills")
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", fmt.Errorf("create writable root %s: %w", root, err)
	}
	// Resolve symlinks so containment checks compare real paths.
	real, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", fmt.Errorf("resolve writable root %s: %w", root, err)
	}
	return real, nil
}

// ContainmentCheck verifies that target is inside resolvedRoot after symlink expansion.
// target must already be a clean, absolute path; resolvedRoot must already be resolved.
func ContainmentCheck(resolvedRoot, target string) error {
	// Ensure root ends with separator so that prefix matching is unambiguous.
	prefix := resolvedRoot
	if !strings.HasSuffix(prefix, string(filepath.Separator)) {
		prefix += string(filepath.Separator)
	}
	if target != resolvedRoot && !strings.HasPrefix(target, prefix) {
		return fmt.Errorf("path %q is outside writable root %q", target, resolvedRoot)
	}
	return nil
}

// WriteSkillMD atomically writes content to <dir>/SKILL.md using the
// temp-file → fsync → rename pattern, so a crash during the write
// leaves the original file untouched.
//
// Allowed callers (enforced by the meta guard in tests/suites/meta/):
//   - (*Service).Create
//   - (*Service).Update
//   - (*Service).Duplicate
func WriteSkillMD(dir string, content []byte) error {
	skillMD := filepath.Join(dir, "SKILL.md")

	// Write into the same directory so that the final rename is atomic
	// (same filesystem device).
	tmp, err := os.CreateTemp(dir, ".skill-*.md.tmp")
	if err != nil {
		return fmt.Errorf("create temp file in %s: %w", dir, err)
	}
	tmpName := tmp.Name()

	// Clean up the temp file if we bail out early.
	success := false
	defer func() {
		if !success {
			_ = tmp.Close()
			_ = os.Remove(tmpName)
		}
	}()

	if _, err := tmp.Write(content); err != nil {
		return fmt.Errorf("write temp file: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("fsync temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp file: %w", err)
	}

	if err := os.Rename(tmpName, skillMD); err != nil {
		return fmt.Errorf("rename temp to SKILL.md: %w", err)
	}
	success = true
	return nil
}

// SerializeFrontmatter serializes the frontmatter map to YAML bytes.
// Uses go-yaml's own quoting, so values containing colons are handled
// correctly — no manual string formatting.
func SerializeFrontmatter(fm map[string]any) ([]byte, error) {
	if len(fm) == 0 {
		return []byte{}, nil
	}
	return yaml.Marshal(fm)
}

// BuildSkillMDContent assembles a complete SKILL.md from frontmatter fields and a body.
func BuildSkillMDContent(name, description string, extras map[string]any, body string) ([]byte, error) {
	fm := make(map[string]any, len(extras)+2)
	for k, v := range extras {
		fm[k] = v
	}
	fm["name"] = name
	fm["description"] = description

	fmBytes, err := SerializeFrontmatter(fm)
	if err != nil {
		return nil, fmt.Errorf("serialize frontmatter: %w", err)
	}

	// Assemble: ---\n<yaml>---\n\n<body>
	var out []byte
	out = append(out, []byte("---\n")...)
	out = append(out, fmBytes...)
	out = append(out, []byte("---\n")...)
	if body != "" {
		out = append(out, '\n')
		out = append(out, []byte(strings.TrimRight(body, "\n"))...)
		out = append(out, '\n')
	}
	return out, nil
}

// standardResourceDirs are the subdirectories that Create/Duplicate may write.
// Any directory or file in a skill dir beyond SKILL.md and these is "unexpected"
// for the purposes of a safe delete.
var standardResourceDirs = map[string]bool{
	"scripts":    true,
	"references": true,
	"assets":     true,
}

// UnexpectedFiles returns paths (relative to skillDir) of files and
// directories that are not SKILL.md or a standard resource subdir.
// An empty return means it is safe to delete without force.
func UnexpectedFiles(skillDir string) ([]string, error) {
	entries, err := os.ReadDir(skillDir)
	if err != nil {
		return nil, fmt.Errorf("read dir %s: %w", skillDir, err)
	}
	var unexpected []string
	for _, entry := range entries {
		name := entry.Name()
		if name == "SKILL.md" {
			continue
		}
		if entry.IsDir() && standardResourceDirs[name] {
			continue
		}
		unexpected = append(unexpected, name)
	}
	return unexpected, nil
}

// CopyDir recursively copies src to dst, creating dst if needed.
// Only regular files and directories are copied; symlinks are followed.
func CopyDir(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, info.Mode())
		}
		return copyFile(path, target, info.Mode())
	})
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer func() { _ = out.Close() }()

	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Sync()
}
