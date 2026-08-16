// Package memory gives an agent durable, workspace-scoped notes that
// outlive a conversation.
//
// The thing it is for: an agent that relearns "this repo uses pnpm, the
// tests are `pnpm test`, and the Go code lives under backend-go/" at the
// start of every conversation is paying for that discovery over and over,
// and getting it slightly differently wrong each time. Compaction
// (internal/agent/compaction) protects a *turn*; this protects the run of
// conversations.
//
// Four decisions shape everything here:
//
//  1. Memories are injected into the system prompt, not fetched by a tool.
//     A memory the model has to remember to look up is not memory -- it is
//     a database, and the model will forget to query it precisely when it
//     matters. `memory_read` exists for searching past what the injection
//     budget fits, not as the primary path.
//
//  2. They are scoped to a workspace, never global. "We use pnpm" is a
//     fact about one repository, and carrying it into another is how an
//     agent becomes confidently wrong about a project it has never seen.
//     Nothing here is keyed by user or by model.
//
//  3. They live in the app data directory, not in the repository. Writing
//     notes into the user's tree would put them in `git status`, get them
//     committed by accident, and make an agent's private bookkeeping into
//     a diff someone has to review.
//
//  4. Writing one is consequential (RiskWrite in the tool layer), so it is
//     approval-gated outside Auto mode. This is the one place the Phase 4
//     RiskSession argument does *not* transfer: a todo list affects only
//     the current turn and the user watches it happen, whereas a memory
//     silently changes how the agent behaves in every future conversation
//     about this workspace and appears in no transcript afterwards. A
//     wrong memory is an invisible, persistent behavioural bug -- exactly
//     the thing a human should have seen once.
package memory

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	// maxEntries bounds one workspace's store. Past this, the oldest
	// un-reinforced memories are dropped: a store that only grows turns
	// into a second context window that nobody compacts.
	maxEntries = 200

	// maxEntryChars keeps one memory a fact rather than a transcript. The
	// failure this prevents is the model "remembering" its entire reasoning
	// for a decision, which is both useless later and enormous.
	maxEntryChars = 600

	// promptBudgetChars bounds the system-prompt injection. Every
	// conversation in this workspace pays this on every turn, so it is
	// deliberately much smaller than the store itself.
	promptBudgetChars = 4000
)

// Entry is one remembered fact.
type Entry struct {
	ID   string   `json:"id"`
	Text string   `json:"text"`
	Tags []string `json:"tags,omitempty"`

	// Source is the thread that wrote it. Kept so a user looking at a
	// memory that turned out to be wrong can find the conversation that
	// produced it, which is the only way to work out *why* it is wrong.
	Source string `json:"source,omitempty"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// file is the on-disk shape.
type file struct {
	// Workspace is recorded so a person who finds this file in their app
	// data directory can tell what it is about. The filename is a hash and
	// says nothing.
	Workspace string  `json:"workspace"`
	Entries   []Entry `json:"entries"`
}

// Store is one workspace's memories, backed by a single JSON file.
//
// A whole-file rewrite per change, not an append log: the store is small
// by construction (maxEntries), edits are rare, and a rewrite makes
// "forget" and "update" the same operation as "add" rather than three
// different ones with a compaction step. The write is atomic via rename,
// so a crash mid-write loses the change rather than the store.
type Store struct {
	mu   sync.Mutex
	path string
	root string
}

// Open returns the store for one workspace root, creating nothing until
// something is written.
//
// The filename is a hash of the root rather than the path itself, because
// a workspace root is an arbitrary absolute path -- it contains separators
// and can be longer than a filename may be. It is not a security boundary:
// the root comes from the operator's environment, not from the model.
func Open(dataDir, workspaceRoot string) (*Store, error) {
	if strings.TrimSpace(dataDir) == "" || strings.TrimSpace(workspaceRoot) == "" {
		return nil, fmt.Errorf("memory: both a data directory and a workspace root are required")
	}
	dir := filepath.Join(dataDir, "agent-memory")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("memory: %w", err)
	}
	sum := sha256.Sum256([]byte(workspaceRoot))
	return &Store{
		path: filepath.Join(dir, hex.EncodeToString(sum[:16])+".json"),
		root: workspaceRoot,
	}, nil
}

// Path is where this store's file lives, so the UI and the tool result can
// tell the user where to look. A memory store the user cannot find is one
// they cannot audit or correct.
func (s *Store) Path() string {
	if s == nil {
		return ""
	}
	return s.path
}

func (s *Store) load() (file, error) {
	var f file
	raw, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return file{Workspace: s.root}, nil
		}
		return f, fmt.Errorf("memory: %w", err)
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		// A corrupt store is not a reason to fail every request in the
		// workspace. Start fresh and say so rather than wedging the agent
		// on a file it cannot parse and the user did not know existed.
		return file{Workspace: s.root}, nil
	}
	f.Workspace = s.root
	return f, nil
}

func (s *Store) save(f file) error {
	raw, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return fmt.Errorf("memory: %w", err)
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return fmt.Errorf("memory: %w", err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return fmt.Errorf("memory: %w", err)
	}
	return nil
}

// All returns every memory, newest first.
func (s *Store) All() []Entry {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	f, err := s.load()
	if err != nil {
		return nil
	}
	sort.SliceStable(f.Entries, func(a, b int) bool {
		return f.Entries[a].UpdatedAt.After(f.Entries[b].UpdatedAt)
	})
	return f.Entries
}

// Remember stores a fact, updating an existing one if it is a repeat.
//
// Dedup is on exact normalized text -- lowercased, whitespace collapsed --
// and nothing cleverer. Fuzzy matching would merge "the tests are `pnpm
// test`" with "the tests are `pnpm test:e2e`", and a memory silently
// replaced by a similar-looking wrong one is far worse than two memories
// that say nearly the same thing. Repeating a fact bumps UpdatedAt, which
// is what keeps it alive through eviction: reinforcement, not recency of
// first learning, is the signal that a memory is still true.
func (s *Store) Remember(text string, tags []string, source string) (Entry, error) {
	if s == nil {
		return Entry{}, fmt.Errorf("memory: no store configured")
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return Entry{}, fmt.Errorf("memory: empty memory")
	}
	if len(text) > maxEntryChars {
		return Entry{}, fmt.Errorf("memory: %d characters, over the %d limit -- record the conclusion, not the reasoning that reached it",
			len(text), maxEntryChars)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	f, err := s.load()
	if err != nil {
		return Entry{}, err
	}

	now := time.Now().UTC()
	key := normalize(text)
	for i := range f.Entries {
		if normalize(f.Entries[i].Text) == key {
			f.Entries[i].UpdatedAt = now
			f.Entries[i].Tags = mergeTags(f.Entries[i].Tags, tags)
			if err := s.save(f); err != nil {
				return Entry{}, err
			}
			return f.Entries[i], nil
		}
	}

	e := Entry{
		ID:        newID(text, now),
		Text:      text,
		Tags:      normalizeTags(tags),
		Source:    source,
		CreatedAt: now,
		UpdatedAt: now,
	}
	f.Entries = append(f.Entries, e)
	f.Entries = evict(f.Entries)
	if err := s.save(f); err != nil {
		return Entry{}, err
	}
	return e, nil
}

// Forget removes a memory by id, reporting whether it existed.
func (s *Store) Forget(id string) (bool, error) {
	if s == nil {
		return false, fmt.Errorf("memory: no store configured")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	f, err := s.load()
	if err != nil {
		return false, err
	}
	for i := range f.Entries {
		if f.Entries[i].ID == id {
			f.Entries = append(f.Entries[:i], f.Entries[i+1:]...)
			return true, s.save(f)
		}
	}
	return false, nil
}

// Search returns memories matching every whitespace-separated term in
// query, across text and tags. Substring matching, case-insensitive.
//
// No ranking beyond recency: the store holds at most 200 short facts, so
// the interesting question is "which of these mention X", not "which is
// most relevant". A relevance score over 200 items is machinery that
// cannot pay for itself.
func (s *Store) Search(query string, limit int) []Entry {
	all := s.All()
	terms := strings.Fields(strings.ToLower(query))
	if len(terms) == 0 {
		if limit > 0 && len(all) > limit {
			return all[:limit]
		}
		return all
	}

	var out []Entry
	for _, e := range all {
		hay := strings.ToLower(e.Text + " " + strings.Join(e.Tags, " "))
		matched := true
		for _, t := range terms {
			if !strings.Contains(hay, t) {
				matched = false
				break
			}
		}
		if matched {
			out = append(out, e)
			if limit > 0 && len(out) >= limit {
				break
			}
		}
	}
	return out
}

// Prompt renders the memories for injection into the system prompt, or ""
// when there are none.
//
// Framed explicitly as fallible notes rather than as fact. The model has no
// other way to tell a memory it wrote three weeks ago from something the
// user just said, and a stale note stated as ground truth is how an agent
// insists a file exists after it was deleted.
func (s *Store) Prompt() string {
	entries := s.All()
	if len(entries) == 0 {
		return ""
	}

	var b strings.Builder
	b.WriteString("## Notes from earlier work in this workspace\n\n")
	b.WriteString("You wrote these in previous conversations. They are recollections, not ground truth: " +
		"prefer what you can verify now, and correct one with `memory_write` (or drop it with `memory_forget`) " +
		"when you find it is wrong.\n\n")

	for _, e := range entries {
		line := "- " + e.Text + "\n"
		if b.Len()+len(line) > promptBudgetChars {
			b.WriteString("- (older notes omitted; search them with `memory_read`)\n")
			break
		}
		b.WriteString(line)
	}
	return b.String()
}

// evict drops the least-recently-reinforced entries once over the cap.
func evict(entries []Entry) []Entry {
	if len(entries) <= maxEntries {
		return entries
	}
	sort.SliceStable(entries, func(a, b int) bool {
		return entries[a].UpdatedAt.After(entries[b].UpdatedAt)
	})
	return entries[:maxEntries]
}

func normalize(s string) string {
	return strings.Join(strings.Fields(strings.ToLower(s)), " ")
}

func normalizeTags(tags []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, t := range tags {
		t = strings.ToLower(strings.TrimSpace(t))
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
	}
	sort.Strings(out)
	return out
}

func mergeTags(a, b []string) []string {
	return normalizeTags(append(append([]string(nil), a...), b...))
}

func newID(text string, at time.Time) string {
	sum := sha256.Sum256([]byte(text + at.Format(time.RFC3339Nano)))
	return hex.EncodeToString(sum[:6])
}
