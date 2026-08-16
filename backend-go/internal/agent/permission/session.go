package permission

import "sync"

// Session is what a user has already said "always allow" to, for one
// conversation.
//
// Scoped to a session rather than persisted on purpose. A standing grant
// that outlives the conversation it was given in is a grant the user has
// stopped being able to see: they would have no list to review and no
// moment where it is obviously in force. Making it die with the process is
// the honest version of "for this session" -- and it is what OpenWorker's
// session_allow_tools does.
type Session struct {
	mu       sync.RWMutex
	tools    map[string]bool
	commands map[string]bool
}

func newSession() *Session {
	return &Session{tools: map[string]bool{}, commands: map[string]bool{}}
}

// AllowTool records an "always allow" answer for a tool by name.
func (s *Session) AllowTool(tool string) {
	if s == nil || tool == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tools[tool] = true
}

// AllowCommand records an "always allow" answer for one exact command line.
//
// Exact, not prefix: the user approved the command they read. Widening that
// into a prefix rule would silently extend the grant to commands they never
// saw, which is the same mistake the metacharacter guard exists to prevent.
func (s *Session) AllowCommand(command string) {
	if s == nil || command == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.commands[command] = true
}

func (s *Session) allowsTool(tool string) bool {
	if s == nil {
		return false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.tools[tool]
}

func (s *Session) allowsCommand(command string) bool {
	if s == nil {
		return false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.commands[command]
}

// Store hands out one Session per conversation.
//
// One request cannot hold the grants, because the approval round trip *is*
// a second request: the turn that asks and the turn that resumes are
// different HTTP calls, and "always allow" has to survive between them --
// and then apply to every later turn in the same thread.
type Store struct {
	mu       sync.Mutex
	sessions map[string]*Session
}

func NewStore() *Store { return &Store{sessions: map[string]*Session{}} }

// For returns the session for id, creating it on first use. A nil Store
// returns nil, which every Session method tolerates -- so a Handler built
// without one degrades to "never remembers", not to a panic.
func (s *Store) For(id string) *Session {
	if s == nil || id == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[id]
	if !ok {
		sess = newSession()
		s.sessions[id] = sess
	}
	return sess
}
