package skills

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
)

var (
	ErrSkillNotFound = errors.New("skill not found")
)

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
func (s *Service) Invalidate(home, project string) {
	key := cacheKey(home, project)
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.cache, key)
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
