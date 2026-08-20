package skills

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

const (
	DefaultMaxDepth       = 4
	DefaultMaxDirsVisited = 2000
	DefaultMaxSkills      = 256
	DefaultMaxFileBytes   = 1024 * 1024 // 1 MiB
)

// ScanOptions configures the bounds and behavior for filesystem scanning.
type ScanOptions struct {
	MaxDepth       int
	MaxDirsVisited int
	MaxSkills      int
	MaxFileBytes   int64
}

// DefaultScanOptions returns the standard scan limits.
func DefaultScanOptions() ScanOptions {
	return ScanOptions{
		MaxDepth:       DefaultMaxDepth,
		MaxDirsVisited: DefaultMaxDirsVisited,
		MaxSkills:      DefaultMaxSkills,
		MaxFileBytes:   DefaultMaxFileBytes,
	}
}

// ScannedSkill contains a parsed skill before deduplication along with its discovery index.
type ScannedSkill struct {
	Skill       *Skill
	SourceIndex int
	SourceRoot  SourceRoot
}

// ScanResult holds all scanned skills and diagnostics across roots.
type ScanResult struct {
	Skills      []ScannedSkill
	Diagnostics []Diagnostic
	Truncated   bool
}

// ScanRoots scans the filesystem across all eight sources given home and project root.
func ScanRoots(home, project string, opts ScanOptions) ScanResult {
	if opts.MaxDepth <= 0 {
		opts.MaxDepth = DefaultMaxDepth
	}
	if opts.MaxDirsVisited <= 0 {
		opts.MaxDirsVisited = DefaultMaxDirsVisited
	}
	if opts.MaxSkills <= 0 {
		opts.MaxSkills = DefaultMaxSkills
	}
	if opts.MaxFileBytes <= 0 {
		opts.MaxFileBytes = DefaultMaxFileBytes
	}

	var res ScanResult
	dirsVisited := 0

	for srcIdx, root := range Sources {
		var rootDir string
		if root.Scope == ScopeProject {
			if project == "" {
				continue
			}
			rootDir = filepath.Join(project, root.RelPath)
		} else {
			if home == "" {
				continue
			}
			rootDir = filepath.Join(home, root.RelPath)
		}

		info, err := os.Stat(rootDir)
		if err != nil || !info.IsDir() {
			continue
		}

		// Walk rootDir with bounds
		walkErr := walkRoot(rootDir, 0, opts.MaxDepth, &dirsVisited, opts.MaxDirsVisited, func(dirPath string) error {
			skillMDPath := filepath.Join(dirPath, "SKILL.md")
			fi, err := os.Stat(skillMDPath)
			if err != nil || fi.IsDir() {
				return nil
			}

			// Resolve symlinks
			realPath, err := filepath.EvalSymlinks(dirPath)
			if err != nil {
				realPath = dirPath
			}

			skill, diags, parseErr := ParseSkill(dirPath, realPath, root, opts.MaxFileBytes)
			res.Diagnostics = append(res.Diagnostics, diags...)
			if parseErr != nil {
				return nil
			}

			res.Skills = append(res.Skills, ScannedSkill{
				Skill:       skill,
				SourceIndex: srcIdx,
				SourceRoot:  root,
			})

			return nil
		})

		if walkErr != nil {
			res.Diagnostics = append(res.Diagnostics, Diagnostic{
				Path:     rootDir,
				Severity: "warning",
				Message:  walkErr.Error(),
			})
		}

		if dirsVisited >= opts.MaxDirsVisited {
			res.Truncated = true
			res.Diagnostics = append(res.Diagnostics, Diagnostic{
				Path:     rootDir,
				Severity: "warning",
				Message:  fmt.Sprintf("scan directory limit reached (%d directories visited)", dirsVisited),
			})
			break
		}
	}

	return res
}

func walkRoot(current string, depth, maxDepth int, visited *int, maxVisited int, onDir func(string) error) error {
	if depth > maxDepth {
		return nil
	}
	*visited++
	if *visited > maxVisited {
		return fmt.Errorf("exceeded max directory scan limit of %d", maxVisited)
	}

	// Check if this directory itself is a skill
	skillMD := filepath.Join(current, "SKILL.md")
	if fi, err := os.Stat(skillMD); err == nil && !fi.IsDir() {
		if err := onDir(current); err != nil {
			return err
		}
		// When a directory contains SKILL.md, it is a skill directory.
		// Subdirectories inside it are resources (scripts, templates), not nested skills.
		return nil
	}

	entries, err := os.ReadDir(current)
	if err != nil {
		return nil
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		// Skip .git, node_modules, and dot-directories below a skills root
		if name == ".git" || name == "node_modules" || strings.HasPrefix(name, ".") {
			continue
		}

		subPath := filepath.Join(current, name)
		// Check for symlinked directories
		fileInfo, err := entry.Info()
		if err == nil && fileInfo.Mode()&fs.ModeSymlink != 0 {
			resolved, err := filepath.EvalSymlinks(subPath)
			if err == nil {
				resInfo, err := os.Stat(resolved)
				if err == nil && resInfo.IsDir() {
					// Check skill or recurse
					if err := walkRoot(subPath, depth+1, maxDepth, visited, maxVisited, onDir); err != nil {
						return err
					}
					continue
				}
			}
		}

		if err := walkRoot(subPath, depth+1, maxDepth, visited, maxVisited, onDir); err != nil {
			return err
		}
	}

	return nil
}
