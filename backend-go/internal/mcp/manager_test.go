package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/db"
	"amiro/backend/internal/db/models"
	"amiro/backend/internal/db/repository"
)

type fakeMCPEngine struct {
	mu          sync.Mutex
	added       map[string]bifrostai.MCPClientConfig
	states      []bifrostai.MCPClientState
	addErr      error
	addErrForID map[string]error
	callResult  bifrostai.MCPToolCallResult

	// addBlock, when non-nil, makes AddMCPClient block reading from it
	// before doing anything else -- and, deliberately, without selecting on
	// the passed context either. This mirrors bifrost/core's real STDIO
	// transport, which spawns the server subprocess on its own long-lived
	// context rather than the caller's, so a stalled child process can't be
	// unblocked by context cancellation alone. Tests that never close this
	// channel are simulating exactly that stall.
	addBlock chan struct{}
}

func (f *fakeMCPEngine) AddMCPClient(_ context.Context, cfg bifrostai.MCPClientConfig) error {
	if f.addBlock != nil {
		<-f.addBlock
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.addErrForID != nil {
		if err, ok := f.addErrForID[cfg.ID]; ok {
			return err
		}
	}
	if f.addErr != nil {
		return f.addErr
	}
	if f.added == nil {
		f.added = map[string]bifrostai.MCPClientConfig{}
	}
	f.added[cfg.ID] = cfg
	f.states = append(f.states, bifrostai.MCPClientState{ID: cfg.ID, Name: cfg.Name, Status: bifrostai.MCPStatusConnected})
	return nil
}

func (f *fakeMCPEngine) RemoveMCPClient(id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.added, id)
	kept := f.states[:0]
	for _, s := range f.states {
		if s.ID != id {
			kept = append(kept, s)
		}
	}
	f.states = kept
	return nil
}

func (f *fakeMCPEngine) MCPClientStates() []bifrostai.MCPClientState {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]bifrostai.MCPClientState, len(f.states))
	copy(out, f.states)
	return out
}

func (f *fakeMCPEngine) CallMCPTool(_ context.Context, _, _ string, _ json.RawMessage) bifrostai.MCPToolCallResult {
	return f.callResult
}

func newTestManager(t *testing.T) (*Manager, *fakeMCPEngine, *models.User) {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), "test.db")
	gdb, err := db.Open(db.DialectSQLite, dsn)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	u := &models.User{Name: "Ada", Email: "ada@example.com"}
	if err := gdb.Create(u).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}
	repo := repository.NewMcpRepository(gdb)
	engine := &fakeMCPEngine{}
	return NewManager(repo, engine), engine, u
}

func stdioInput(id, name, userID string) SaveInput {
	return SaveInput{ID: id, Name: name, UserID: userID, Config: ServerConfig{Stdio: &StdioConfig{Command: "echo"}}}
}

func TestManager_SaveNewServerConnectsLiveAndPersists(t *testing.T) {
	m, engine, u := newTestManager(t)
	ctx := context.Background()

	server, err := m.Save(ctx, stdioInput("", "my-server", u.ID))
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if server.ID == "" {
		t.Fatal("expected a generated ID")
	}
	cfg, ok := engine.added[server.ID]
	if !ok {
		t.Fatal("expected the engine to have received AddMCPClient")
	}
	if cfg.Name != "my_server" {
		t.Fatalf("bifrost name = %q, want hyphens sanitized to underscores (\"my_server\")", cfg.Name)
	}

	got, err := m.repo.SelectByID(ctx, server.ID)
	if err != nil {
		t.Fatalf("SelectByID: %v", err)
	}
	if got == nil || got.Name != "my-server" {
		t.Fatalf("got %+v, want the original hyphenated name preserved in the DB", got)
	}
}

func TestManager_SaveNewServerRollsBackOnConnectFailure(t *testing.T) {
	m, engine, u := newTestManager(t)
	engine.addErr = errors.New("connection refused")
	ctx := context.Background()

	_, err := m.Save(ctx, stdioInput("", "my-server", u.ID))
	if err == nil {
		t.Fatal("expected an error")
	}

	exists, err := m.repo.ExistsByServerName(ctx, "my-server")
	if err != nil {
		t.Fatalf("ExistsByServerName: %v", err)
	}
	if exists {
		t.Fatal("expected the DB row to be rolled back for a brand-new server that failed to connect")
	}
}

func TestManager_SaveExistingServerKeepsRowWithErrorStatusOnConnectFailure(t *testing.T) {
	m, engine, u := newTestManager(t)
	ctx := context.Background()

	server, err := m.Save(ctx, stdioInput("", "my-server", u.ID))
	if err != nil {
		t.Fatalf("initial Save: %v", err)
	}

	engine.addErr = errors.New("connection refused")
	_, err = m.Save(ctx, stdioInput(server.ID, "my-server", u.ID))
	if err == nil {
		t.Fatal("expected an error on the reconnect")
	}

	got, err := m.repo.SelectByID(ctx, server.ID)
	if err != nil {
		t.Fatalf("SelectByID: %v", err)
	}
	if got == nil {
		t.Fatal("expected the existing server's row to survive a failed update-reconnect")
	}
	if got.LastConnectionStatus == nil || *got.LastConnectionStatus != "error" {
		t.Fatalf("last_connection_status = %v, want \"error\"", got.LastConnectionStatus)
	}
}

// TestManager_NeverConnectedServerHasEmptyNotNilToolInfo is a regression
// test: List/Get must never return a nil ToolInfo (which marshals to JSON
// `null`) for a server with no live connection and nothing cached yet --
// found live via the OAuth "authorizing" case (oauth_flow_test.go's twin
// of this test), but the underlying bug applies to any never-connected
// server, OAuth or not.
func TestManager_NeverConnectedServerHasEmptyNotNilToolInfo(t *testing.T) {
	m, engine, u := newTestManager(t)
	ctx := context.Background()

	server, err := m.Save(ctx, stdioInput("", "my-server", u.ID))
	if err != nil {
		t.Fatalf("initial Save: %v", err)
	}
	engine.addErr = errors.New("connection refused")
	_, _ = m.Save(ctx, stdioInput(server.ID, "my-server", u.ID))

	got, err := m.Get(ctx, server.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.ToolInfo == nil {
		t.Fatal("Get()'s ToolInfo is nil, want a non-nil (possibly empty) slice")
	}

	list, err := m.List(ctx, u.ID)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 || list[0].ToolInfo == nil {
		t.Fatalf("List()'s ToolInfo is nil, want a non-nil (possibly empty) slice: %+v", list)
	}
}

func TestManager_SaveRejectsInvalidName(t *testing.T) {
	m, _, u := newTestManager(t)
	_, err := m.Save(context.Background(), stdioInput("", "not a valid name!", u.ID))
	if !errors.Is(err, ErrInvalidName) {
		t.Fatalf("err = %v, want ErrInvalidName", err)
	}
}

func TestManager_SaveRejectsDuplicatePublicName(t *testing.T) {
	m, _, u := newTestManager(t)
	ctx := context.Background()

	first := stdioInput("", "shared-server", u.ID)
	first.Visibility = "public"
	if _, err := m.Save(ctx, first); err != nil {
		t.Fatalf("first Save: %v", err)
	}

	second := stdioInput("", "shared-server", u.ID)
	second.Visibility = "public"
	_, err := m.Save(ctx, second)
	if !errors.Is(err, ErrDuplicateName) {
		t.Fatalf("err = %v, want ErrDuplicateName", err)
	}
}

func TestManager_RemoveDeletesRowAndDisconnectsLive(t *testing.T) {
	m, engine, u := newTestManager(t)
	ctx := context.Background()
	server, err := m.Save(ctx, stdioInput("", "my-server", u.ID))
	if err != nil {
		t.Fatalf("Save: %v", err)
	}

	if err := m.Remove(ctx, server.ID); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	got, err := m.repo.SelectByID(ctx, server.ID)
	if err != nil {
		t.Fatalf("SelectByID: %v", err)
	}
	if got != nil {
		t.Fatal("expected the DB row to be gone")
	}
	if _, stillThere := engine.added[server.ID]; stillThere {
		t.Fatal("expected the live client to be removed")
	}
}

func TestManager_ListHidesConfigFromNonOwnerButShowsItToOwner(t *testing.T) {
	m, _, u := newTestManager(t)
	ctx := context.Background()
	server, err := m.Save(ctx, stdioInput("", "my-server", u.ID))
	if err != nil {
		t.Fatalf("Save: %v", err)
	}

	ownerList, err := m.List(ctx, u.ID)
	if err != nil {
		t.Fatalf("List (owner): %v", err)
	}
	if len(ownerList) != 1 || ownerList[0].Config == nil {
		t.Fatalf("owner's list = %+v, want config visible", ownerList)
	}

	otherList, err := m.List(ctx, "someone-else")
	if err != nil {
		t.Fatalf("List (other): %v", err)
	}
	for _, s := range otherList {
		if s.ID == server.ID {
			t.Fatal("a private server owned by someone else must not appear in another user's list")
		}
	}
}

func TestManager_ListIncludesPublicServersFromOtherUsersWithConfigHidden(t *testing.T) {
	m, _, u := newTestManager(t)
	ctx := context.Background()
	input := stdioInput("", "shared-server", u.ID)
	input.Visibility = "public"
	server, err := m.Save(ctx, input)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}

	otherList, err := m.List(ctx, "someone-else")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	var found *ServerInfo
	for i := range otherList {
		if otherList[i].ID == server.ID {
			found = &otherList[i]
		}
	}
	if found == nil {
		t.Fatal("expected the public server to be visible to a non-owner")
	}
	if found.Config != nil {
		t.Fatal("expected the config to be hidden from a non-owner even for a public server")
	}
}

func TestManager_CallToolConnectsLazilyWhenNotCurrentlyLive(t *testing.T) {
	m, engine, u := newTestManager(t)
	ctx := context.Background()
	server, err := m.Save(ctx, stdioInput("", "my-server", u.ID))
	if err != nil {
		t.Fatalf("Save: %v", err)
	}

	// Simulate the live connection having dropped without the DB row changing.
	_ = engine.RemoveMCPClient(server.ID)
	engine.callResult = bifrostai.MCPToolCallResult{Content: "42"}

	result := m.CallTool(ctx, server.ID, "add", nil)
	if result.IsError {
		t.Fatalf("got error result: %+v", result)
	}
	if result.Content != "42" {
		t.Fatalf("content = %q, want \"42\"", result.Content)
	}
	if _, ok := engine.added[server.ID]; !ok {
		t.Fatal("expected CallTool to have reconnected the client lazily")
	}
}

func TestManager_CallToolTimesOutInsteadOfHangingForeverWhenConnectStalls(t *testing.T) {
	m, engine, u := newTestManager(t)
	ctx := context.Background()
	server, err := m.Save(ctx, stdioInput("", "my-server", u.ID))
	if err != nil {
		t.Fatalf("Save: %v", err)
	}

	orig := mcpConnectTimeout
	mcpConnectTimeout = 50 * time.Millisecond
	t.Cleanup(func() { mcpConnectTimeout = orig })

	_ = engine.RemoveMCPClient(server.ID)
	engine.addBlock = make(chan struct{}) // never closed: simulates a stalled `npx` spawn

	start := time.Now()
	result := m.CallTool(ctx, server.ID, "add", nil)
	elapsed := time.Since(start)

	if !result.IsError {
		t.Fatalf("got success result %+v, want an error once connectBounded's timeout fires", result)
	}
	if elapsed > time.Second {
		t.Fatalf("CallTool took %s, want it bounded by mcpConnectTimeout instead of hanging on the stalled connect", elapsed)
	}
}

func TestManager_CallToolReturnsPromptlyWhenContextIsCanceledDuringConnect(t *testing.T) {
	m, engine, u := newTestManager(t)
	ctx := context.Background()
	server, err := m.Save(ctx, stdioInput("", "my-server", u.ID))
	if err != nil {
		t.Fatalf("Save: %v", err)
	}

	orig := mcpConnectTimeout
	mcpConnectTimeout = time.Minute // long enough that only cancellation can end the test
	t.Cleanup(func() { mcpConnectTimeout = orig })

	_ = engine.RemoveMCPClient(server.ID)
	engine.addBlock = make(chan struct{}) // never closed

	callCtx, cancel := context.WithCancel(ctx)
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel() // simulates the user clicking Stop, which aborts the fetch and cancels r.Context()
	}()

	start := time.Now()
	result := m.CallTool(callCtx, server.ID, "add", nil)
	elapsed := time.Since(start)

	if !result.IsError {
		t.Fatalf("got success result %+v, want an error once ctx is canceled", result)
	}
	if elapsed > time.Second {
		t.Fatalf("CallTool took %s, want it to return promptly on context cancellation instead of waiting out mcpConnectTimeout", elapsed)
	}
}

func TestManager_CallToolReturnsErrorResultForUnknownServer(t *testing.T) {
	m, _, _ := newTestManager(t)
	result := m.CallTool(context.Background(), "does-not-exist", "add", nil)
	if !result.IsError {
		t.Fatal("expected an error result for an unknown server id")
	}
}

func TestManager_ShareVisibilityRejectsInvalidValue(t *testing.T) {
	m, _, u := newTestManager(t)
	ctx := context.Background()
	server, err := m.Save(ctx, stdioInput("", "my-server", u.ID))
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := m.ShareVisibility(ctx, server.ID, "invisible"); err == nil {
		t.Fatal("expected an error for an invalid visibility value")
	}
}

func TestManager_InitConnectsEveryStoredServer(t *testing.T) {
	m, engine, u := newTestManager(t)
	ctx := context.Background()
	s1, _ := m.Save(ctx, stdioInput("", "server-one", u.ID))
	s2, _ := m.Save(ctx, stdioInput("", "server-two", u.ID))
	// Simulate a restart: nothing live yet, but both rows exist.
	_ = engine.RemoveMCPClient(s1.ID)
	_ = engine.RemoveMCPClient(s2.ID)

	m.Init(ctx)

	if _, ok := engine.added[s1.ID]; !ok {
		t.Fatal("expected server-one to be reconnected by Init")
	}
	if _, ok := engine.added[s2.ID]; !ok {
		t.Fatal("expected server-two to be reconnected by Init")
	}
}
