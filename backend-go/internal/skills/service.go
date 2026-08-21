package skills

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

var (
	ErrSkillNotFound   = errors.New("skill not found")
	ErrConflict        = errors.New("skill name already exists")
	ErrReadOnlySkill   = errors.New("skill is not in the writable root")
	ErrUnexpectedFiles = errors.New("skill directory contains unexpected files")
	ErrInvalidName     = errors.New("invalid skill name")
)

// WriteInput carries the user-supplied fields for skill creation and update.
type WriteInput struct {
	Name        string
	Description string
	Body        string
	// Frontmatter holds optional extra keys (license, compatibility, etc.).
	// The name and description fields are always derived from the above fields.
	Frontmatter map[string]any
}

// Service is the primary interface for listing and retrieving Agent Skills.
// Caching is strictly invalidation-driven (no TTL clock-wait reliance).
type Service struct {
	mu    sync.RWMutex
	cache map[string]ListResult
	opts  ScanOptions
}

// NewService creates a new skills discovery service with default options.
func NewService(opts ...ScanOptions) *Service {
	scanOpts := DefaultScanOptions()
	if len(opts) > 0 {
		scanOpts = opts[0]
	}
	return &Service{
		cache: make(map[string]ListResult),
		opts:  scanOpts,
	}
}

func cacheKey(home, project string) string {
	cleanHome := ""
	if home != "" {
		cleanHome = filepath.Clean(home)
	}
	cleanProject := ""
	if project != "" {
		cleanProject = filepath.Clean(project)
	}
	return fmt.Sprintf("%s\x00%s", cleanHome, cleanProject)
}

// Invalidate clears cached discovery results for a specific home and project.
// If project is empty, all cached entries for that home are invalidated.
func (s *Service) Invalidate(home, project string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if project != "" {
		key := cacheKey(home, project)
		delete(s.cache, key)
		return
	}
	cleanHome := ""
	if home != "" {
		cleanHome = filepath.Clean(home)
	}
	prefix := cleanHome + "\x00"
	for k := range s.cache {
		if strings.HasPrefix(k, prefix) {
			delete(s.cache, k)
		}
	}
}

// InvalidateAll clears all cached scan results across all workspaces.
func (s *Service) InvalidateAll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cache = make(map[string]ListResult)
}

// List returns all discovered and resolved skills for the given home and project root.
func (s *Service) List(ctx context.Context, home, project string) (*ListResult, error) {
	key := cacheKey(home, project)

	s.mu.RLock()
	res, found := s.cache[key]
	s.mu.RUnlock()

	if found {
		return &res, nil
	}

	scanned := ScanRoots(home, project, s.opts)
	resolved := Resolve(scanned, s.opts.MaxSkills)

	s.mu.Lock()
	s.cache[key] = resolved
	s.mu.Unlock()

	return &resolved, nil
}

// Get returns a single skill by name (case-insensitive) for the given home and project root.
func (s *Service) Get(ctx context.Context, home, project, name string) (*Skill, error) {
	list, err := s.List(ctx, home, project)
	if err != nil {
		return nil, err
	}

	normName := strings.ToLower(strings.TrimSpace(name))
	for _, item := range list.Items {
		if strings.ToLower(strings.TrimSpace(item.Name)) == normName {
			return &item, nil
		}
	}

	return nil, fmt.Errorf("%w: %q", ErrSkillNotFound, name)
}

// Create creates ~/.agents/skills/<name>/SKILL.md.
// Returns ErrConflict if the name already exists in the writable root.
// A validation error slice is returned (non-nil, non-empty) when the input
// fails validation; in that case err is nil.
func (s *Service) Create(ctx context.Context, home string, in WriteInput) (*Skill, []FieldError, error) {
	// Validate.
	vr := CombineResults(
		ValidateName(in.Name),
		ValidateDescription(in.Description),
		ValidateFrontmatter(in.Frontmatter),
		ValidateBody(in.Body),
	)
	if len(vr.Errors) > 0 {
		return nil, vr.Errors, nil
	}

	// Resolve writable root (creates ~/.agents/skills/ if absent).
	root, err := WritableRoot(home)
	if err != nil {
		return nil, nil, err
	}

	// Build target dir path and run containment check before touching the fs.
	skillDir := filepath.Join(root, in.Name)
	resolvedTarget := filepath.Clean(skillDir)
	if err := ContainmentCheck(root, resolvedTarget); err != nil {
		return nil, []FieldError{{Field: "name", Message: err.Error()}}, nil
	}

	// Check for existing directory — no accidental overwrites.
	if _, err := os.Stat(skillDir); err == nil {
		return nil, nil, fmt.Errorf("%w: %q", ErrConflict, in.Name)
	}

	// Create the directory.
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		return nil, nil, fmt.Errorf("create skill directory: %w", err)
	}

	// Build SKILL.md content and write atomically.
	content, err := BuildSkillMDContent(in.Name, in.Description, in.Frontmatter, in.Body)
	if err != nil {
		_ = os.RemoveAll(skillDir) // rollback the empty dir
		return nil, nil, fmt.Errorf("build SKILL.md: %w", err)
	}
	if err := WriteSkillMD(skillDir, content); err != nil {
		_ = os.RemoveAll(skillDir) // rollback
		return nil, nil, fmt.Errorf("write SKILL.md: %w", err)
	}

	// Invalidate cache for the home scope before reading back.
	s.Invalidate(home, "")

	// Re-read to return the canonicalised skill object.
	skill, err := s.Get(ctx, home, "", in.Name)
	if err != nil {
		return nil, nil, fmt.Errorf("read back created skill: %w", err)
	}
	return skill, vr.Warnings, nil
}

// Update replaces the SKILL.md of an existing skill.
// Returns ErrReadOnlySkill (409) if the resolved skill is not in the writable root.
func (s *Service) Update(ctx context.Context, home, name string, in WriteInput) (*Skill, []FieldError, error) {
	// Validate.
	vr := CombineResults(
		ValidateName(in.Name),
		ValidateDescription(in.Description),
		ValidateFrontmatter(in.Frontmatter),
		ValidateBody(in.Body),
	)
	if len(vr.Errors) > 0 {
		return nil, vr.Errors, nil
	}

	// Look up the existing skill to get its on-disk path and writability.
	existing, err := s.Get(ctx, home, "", name)
	if err != nil {
		return nil, nil, err
	}
	if !existing.Writable {
		return nil, nil, fmt.Errorf("%w: source is %q at %s", ErrReadOnlySkill, existing.Source, existing.Path)
	}

	// Confirm the path is still inside the writable root.
	root, err := WritableRoot(home)
	if err != nil {
		return nil, nil, err
	}
	skillDir := existing.Path
	// Resolve symlinks for containment check.
	resolvedDir, err := filepath.EvalSymlinks(skillDir)
	if err != nil {
		resolvedDir = filepath.Clean(skillDir)
	}
	if err := ContainmentCheck(root, resolvedDir); err != nil {
		return nil, nil, fmt.Errorf("%w: %s", ErrReadOnlySkill, err.Error())
	}

	// Build and write.
	content, err := BuildSkillMDContent(in.Name, in.Description, in.Frontmatter, in.Body)
	if err != nil {
		return nil, nil, fmt.Errorf("build SKILL.md: %w", err)
	}
	if err := WriteSkillMD(skillDir, content); err != nil {
		return nil, nil, fmt.Errorf("write SKILL.md: %w", err)
	}

	s.Invalidate(home, "")

	skill, err := s.Get(ctx, home, "", in.Name)
	if err != nil {
		return nil, nil, fmt.Errorf("read back updated skill: %w", err)
	}
	return skill, vr.Warnings, nil
}

// Delete removes a skill directory.
// Returns ErrReadOnlySkill if the skill is not in the writable root.
// Returns ErrUnexpectedFiles (listing them in the error message) when the
// directory contains files beyond the expected set and force is false.
func (s *Service) Delete(ctx context.Context, home, name string, force bool) error {
	existing, err := s.Get(ctx, home, "", name)
	if err != nil {
		return err
	}
	if !existing.Writable {
		return fmt.Errorf("%w: source is %q at %s", ErrReadOnlySkill, existing.Source, existing.Path)
	}

	root, err := WritableRoot(home)
	if err != nil {
		return err
	}
	skillDir := existing.Path
	resolvedDir, err := filepath.EvalSymlinks(skillDir)
	if err != nil {
		resolvedDir = filepath.Clean(skillDir)
	}
	if err := ContainmentCheck(root, resolvedDir); err != nil {
		return fmt.Errorf("%w: %s", ErrReadOnlySkill, err.Error())
	}

	if !force {
		unexpected, err := UnexpectedFiles(skillDir)
		if err != nil {
			return fmt.Errorf("scan skill directory: %w", err)
		}
		if len(unexpected) > 0 {
			return fmt.Errorf("%w: %s", ErrUnexpectedFiles, strings.Join(unexpected, ", "))
		}
	}

	if err := os.RemoveAll(skillDir); err != nil {
		return fmt.Errorf("remove skill directory: %w", err)
	}

	s.Invalidate(home, "")
	return nil
}

// Duplicate copies a skill (any scope) into ~/.agents/skills/ under the same
// name. If that name is already taken in the writable root it appends "-copy"
// (or "-copy-2", etc.) until a free slot is found.
func (s *Service) Duplicate(ctx context.Context, home, name, project string) (*Skill, error) {
	src, err := s.Get(ctx, home, project, name)
	if err != nil {
		return nil, err
	}

	// Validate that the source name is valid for creation in ~/.agents/skills/.
	vr := ValidateName(src.Name)
	if len(vr.Errors) > 0 {
		return nil, fmt.Errorf("%w: %s", ErrInvalidName, vr.Errors[0].Message)
	}

	root, err := WritableRoot(home)
	if err != nil {
		return nil, err
	}

	// Find a free target name.
	targetName := src.Name
	for {
		candidateDir := filepath.Join(root, targetName)
		if _, err := os.Stat(candidateDir); os.IsNotExist(err) {
			break
		}
		targetName = nextCopyName(targetName)
		vrCopy := ValidateName(targetName)
		if len(vrCopy.Errors) > 0 {
			return nil, fmt.Errorf("%w: %s", ErrInvalidName, vrCopy.Errors[0].Message)
		}
	}

	dstDir := filepath.Join(root, targetName)

	// Containment check on destination.
	if err := ContainmentCheck(root, filepath.Clean(dstDir)); err != nil {
		return nil, fmt.Errorf("duplicate destination: %w", err)
	}

	// Copy entire source skill directory.
	if err := CopyDir(src.Path, dstDir); err != nil {
		_ = os.RemoveAll(dstDir)
		return nil, fmt.Errorf("copy skill directory: %w", err)
	}

	// If the name changed, rewrite SKILL.md frontmatter name while preserving other frontmatter.
	if targetName != src.Name {
		content, err := BuildSkillMDContent(targetName, src.Description, src.FrontmatterExtras(), src.Body)
		if err != nil {
			_ = os.RemoveAll(dstDir)
			return nil, fmt.Errorf("rebuild SKILL.md for duplicate: %w", err)
		}
		if err := WriteSkillMD(dstDir, content); err != nil {
			_ = os.RemoveAll(dstDir)
			return nil, fmt.Errorf("write SKILL.md for duplicate: %w", err)
		}
	}

	s.Invalidate(home, "")

	skill, err := s.Get(ctx, home, "", targetName)
	if err != nil {
		return nil, fmt.Errorf("read back duplicated skill: %w", err)
	}
	return skill, nil
}


// nextCopyName appends "-copy" or increments the existing "-copy-N" suffix.
func nextCopyName(name string) string {
	const suffix = "-copy"
	if !strings.HasSuffix(name, suffix) {
		// Check for -copy-N pattern.
		if idx := strings.LastIndex(name, suffix+"-"); idx >= 0 {
			base := name[:idx+len(suffix)]
			numStr := name[idx+len(suffix)+1:]
			var n int
			if _, err := fmt.Sscanf(numStr, "%d", &n); err == nil {
				return fmt.Sprintf("%s-%d", base, n+1)
			}
		}
		return name + suffix
	}
	return name + "-2"
}
