package cassette

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"gopkg.in/yaml.v3"
)

// Store manages loading, saving, and matching recorded cassettes.
type Store struct {
	mu           sync.RWMutex
	dir          string
	cassettes    map[string]*Cassette
	playPointers map[string]int
}

// NewStore initializes a cassette store rooted at dir.
func NewStore(dir string) *Store {
	return &Store{
		dir:          dir,
		cassettes:    make(map[string]*Cassette),
		playPointers: make(map[string]int),
	}
}

// Load reads all .yaml cassettes from dir recursively.
func (s *Store) Load() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, err := os.Stat(s.dir); os.IsNotExist(err) {
		return nil
	}

	return filepath.Walk(s.dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || (!strings.HasSuffix(path, ".yaml") && !strings.HasSuffix(path, ".yml")) {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("reading cassette %s: %w", path, err)
		}
		var c Cassette
		if err := yaml.Unmarshal(data, &c); err != nil {
			return fmt.Errorf("parsing cassette %s: %w", path, err)
		}
		rel, _ := filepath.Rel(s.dir, path)
		key := filepath.ToSlash(rel)
		s.cassettes[key] = &c
		return nil
	})
}

// Add inserts a cassette in-memory under name.
func (s *Store) Add(name string, c *Cassette) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cassettes[name] = c
}

// ResetPointers resets playback indices for all cassettes.
func (s *Store) ResetPointers() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.playPointers = make(map[string]int)
}

// Match searches for an interaction matching the inbound request.
// It first attempts ordered playback within the preferred cassette (if named),
// and falls back to content-addressed lookup across all loaded interactions.
func (s *Store) Match(preferredCassette string, method, path string, bodyBytes []byte) (*Interaction, string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	normTarget, err := Normalize(method, path, bodyBytes)
	if err != nil {
		return nil, "", false
	}

	// 1. Ordered matching within preferred cassette
	if preferredCassette != "" {
		if c, ok := s.cassettes[preferredCassette]; ok {
			ptr := s.playPointers[preferredCassette]
			if ptr < len(c.Interactions) {
				cand := c.Interactions[ptr]
				candBody, _ := json.Marshal(cand.Request.Body)
				normCand, _ := Normalize(cand.Request.Method, cand.Request.Path, candBody)
				if normCand == normTarget {
					s.playPointers[preferredCassette] = ptr + 1
					return &cand, preferredCassette, true
				}
			}
		}
	}

	// 2. Content-addressed search across all cassettes
	for name, c := range s.cassettes {
		for i, cand := range c.Interactions {
			candBody, _ := json.Marshal(cand.Request.Body)
			normCand, _ := Normalize(cand.Request.Method, cand.Request.Path, candBody)
			if normCand == normTarget {
				s.playPointers[name] = i + 1
				return &cand, name, true
			}
		}
	}

	return nil, "", false
}

// Save writes a cassette to a YAML file under the store's directory.
func (s *Store) Save(relativePath string, c *Cassette) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	targetPath := filepath.Join(s.dir, relativePath)
	if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
		return err
	}

	data, err := yaml.Marshal(c)
	if err != nil {
		return fmt.Errorf("encoding cassette YAML: %w", err)
	}

	if err := os.WriteFile(targetPath, data, 0644); err != nil {
		return fmt.Errorf("writing cassette %s: %w", targetPath, err)
	}

	s.cassettes[relativePath] = c
	return nil
}
