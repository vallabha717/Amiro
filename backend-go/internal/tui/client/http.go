package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"amiro/backend/internal/ai/uimessage"
)

// Config is everything an HTTPClient needs to reach a server -- embedded or
// attached, the two look identical from here (plan §2.2's point exactly).
type Config struct {
	// BaseURL is the server's loopback origin, e.g. "http://127.0.0.1:51234".
	BaseURL string
	// AuthToken is the sidecar-level shared secret (X-Amiro-Token) --
	// middleware.RequireToken's gate, proving this process, not who is
	// signed in.
	AuthToken string
	// SessionToken is the signed-in user's bearer token
	// (Authorization: Bearer <token>) -- auth.RequireSession's gate. Empty
	// until a caller has logged in; Login and Register are the only calls
	// that work without one.
	SessionToken string
}

// HTTPClient implements Client over HTTP + SSE against an embedded or
// attached server. It also exposes the auth calls cmd/amiro's `auth`
// subcommand needs -- those aren't part of the Client interface because no
// page calls them; only the CLI login flow does, before a page exists.
type HTTPClient struct {
	cfg Config
	hc  *http.Client
}

// New returns an HTTPClient for cfg. The zero SessionToken is valid --
// exactly what a caller has before Login.
func New(cfg Config) *HTTPClient {
	return &HTTPClient{cfg: cfg, hc: &http.Client{}}
}

// WithSessionToken returns a client identical to c but authenticated as
// token. c itself is unmodified -- a copy, not a mutation, so a caller that
// just logged in doesn't invalidate a reference something else is holding.
func (c *HTTPClient) WithSessionToken(token string) *HTTPClient {
	cfg := c.cfg
	cfg.SessionToken = token
	return New(cfg)
}

var _ Client = (*HTTPClient)(nil)

type wireMessage struct {
	ID    string            `json:"id"`
	Role  string            `json:"role"`
	Parts []json.RawMessage `json:"parts"`
}

// chatModelDTO mirrors chatapi's unexported type of the same name.
type chatModelDTO struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
}

// mentionWire mirrors chatapi's unexported mentionDTO field-for-field.
type mentionWire struct {
	Type       string `json:"type"`
	Name       string `json:"name,omitempty"`
	ServerID   string `json:"serverId,omitempty"`
	WorkflowID string `json:"workflowId,omitempty"`
}

// chatRequest mirrors internal/api/chat's unexported chatRequest -- the two
// have to agree on field names and JSON tags, but that struct is
// intentionally unexported (it is route.go's wire contract, not a type this
// package should import and depend on staying compatible). Fields this
// package never sets (ToolChoice, AllowedAppDefaultToolkit,
// AllowedMcpServers, ProjectDir) default to their zero value, which
// chat.RunTurn already treats as "no restriction beyond WorkspaceRoot."
type chatRequest struct {
	ID             string        `json:"id"`
	Message        wireMessage   `json:"message"`
	ChatModel      *chatModelDTO `json:"chatModel,omitempty"`
	Mentions       []mentionWire `json:"mentions,omitempty"`
	PermissionMode string        `json:"permissionMode,omitempty"`
	WorkspaceRoot  string        `json:"workspaceRoot,omitempty"`
	CompactNow     bool          `json:"compactNow,omitempty"`
}

func textPart(text string) json.RawMessage {
	b, _ := json.Marshal(map[string]string{"type": "text", "text": text})
	return b
}

func mentionWires(mentions []Mention) []mentionWire {
	if len(mentions) == 0 {
		return nil
	}
	out := make([]mentionWire, len(mentions))
	for i, m := range mentions {
		out[i] = mentionWire{Type: m.Type, Name: m.Name, ServerID: m.ServerID, WorkflowID: m.WorkflowID}
	}
	return out
}

// SendMessage implements Client.
func (c *HTTPClient) SendMessage(ctx context.Context, req SendMessageRequest) (<-chan uimessage.Frame, func() error) {
	creq := chatRequest{
		ID: req.ThreadID,
		Message: wireMessage{
			ID:    req.MessageID,
			Role:  "user",
			Parts: []json.RawMessage{textPart(req.Text)},
		},
		Mentions:       mentionWires(req.Mentions),
		PermissionMode: req.PermissionMode,
		WorkspaceRoot:  req.WorkspaceRoot,
		CompactNow:     req.CompactNow,
	}
	if req.ChatModel != nil {
		creq.ChatModel = &chatModelDTO{Provider: req.ChatModel.Provider, Model: req.ChatModel.Model}
	}
	return c.stream(ctx, creq)
}

// SubmitApproval implements Client.
func (c *HTTPClient) SubmitApproval(ctx context.Context, req AssistantResubmission) (<-chan uimessage.Frame, func() error) {
	return c.stream(ctx, chatRequest{
		ID:             req.ThreadID,
		Message:        wireMessage{ID: req.MessageID, Role: "assistant", Parts: req.Parts},
		PermissionMode: req.PermissionMode,
		WorkspaceRoot:  req.WorkspaceRoot,
	})
}

// stream is SendMessage and SubmitApproval's shared body: both are exactly
// "encode a chatRequest, stream the response" once the message shape is
// built, and only that shape (a fresh user turn vs. a resubmitted
// assistant one) differs between them.
func (c *HTTPClient) stream(ctx context.Context, creq chatRequest) (<-chan uimessage.Frame, func() error) {
	frames := make(chan uimessage.Frame)

	body, err := json.Marshal(creq)
	if err != nil {
		close(frames)
		return frames, func() error { return fmt.Errorf("client: encode request: %w", err) }
	}

	done := make(chan error, 1)
	go func() {
		defer close(frames)
		err := c.streamInto(ctx, body, frames)
		done <- err
	}()

	var waitResult error
	var waited bool
	wait := func() error {
		if !waited {
			waitResult = <-done
			waited = true
		}
		return waitResult
	}
	return frames, wait
}

// streamInto does the actual request and pushes every decoded frame onto
// out, stopping at [DONE], ctx cancellation, or a transport error.
func (c *HTTPClient) streamInto(ctx context.Context, body []byte, out chan<- uimessage.Frame) error {
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.BaseURL+"/api/chat", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("client: build request: %w", err)
	}
	c.setHeaders(httpReq)
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.hc.Do(httpReq)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("client: POST /api/chat: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		return fmt.Errorf("client: /api/chat: %s: %s", resp.Status, bytes.TrimSpace(msg))
	}

	sc := uimessage.NewScanner(resp.Body)
	for sc.Scan() {
		select {
		case out <- sc.Frame():
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return nil
}

func (c *HTTPClient) setHeaders(r *http.Request) {
	if c.cfg.AuthToken != "" {
		r.Header.Set("X-Amiro-Token", c.cfg.AuthToken)
	}
	if c.cfg.SessionToken != "" {
		r.Header.Set("Authorization", "Bearer "+c.cfg.SessionToken)
	}
}

func (c *HTTPClient) do(ctx context.Context, method, path string, reqBody, respBody any) (int, error) {
	var reader io.Reader
	if reqBody != nil {
		b, err := json.Marshal(reqBody)
		if err != nil {
			return 0, fmt.Errorf("client: encode %s %s: %w", method, path, err)
		}
		reader = bytes.NewReader(b)
	}
	httpReq, err := http.NewRequestWithContext(ctx, method, c.cfg.BaseURL+path, reader)
	if err != nil {
		return 0, fmt.Errorf("client: build %s %s: %w", method, path, err)
	}
	c.setHeaders(httpReq)
	if reqBody != nil {
		httpReq.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.hc.Do(httpReq)
	if err != nil {
		return 0, fmt.Errorf("client: %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	if respBody != nil && resp.StatusCode < 300 {
		if err := json.NewDecoder(resp.Body).Decode(respBody); err != nil && err != io.EOF {
			return resp.StatusCode, fmt.Errorf("client: decode %s %s response: %w", method, path, err)
		}
	}
	return resp.StatusCode, nil
}

type sessionResponse struct {
	User struct {
		Name  string `json:"name"`
		Email string `json:"email"`
	} `json:"user"`
	Token string `json:"token"`
}

// Login exchanges credentials for a session token, the one `amiro auth
// login` persists via internal/secrets.
func (c *HTTPClient) Login(ctx context.Context, email, password string) (token string, err error) {
	var resp sessionResponse
	status, err := c.do(ctx, http.MethodPost, "/api/auth/login",
		map[string]string{"email": email, "password": password}, &resp)
	if err != nil {
		return "", err
	}
	if status != http.StatusOK {
		return "", fmt.Errorf("client: login: server returned %d", status)
	}
	return resp.Token, nil
}

// Register creates an account and returns its session token, for a first
// run against a server with no accounts yet (Status.IsFirstUser).
func (c *HTTPClient) Register(ctx context.Context, name, email, password string) (token string, err error) {
	var resp sessionResponse
	status, err := c.do(ctx, http.MethodPost, "/api/auth/register",
		map[string]string{"name": name, "email": email, "password": password}, &resp)
	if err != nil {
		return "", err
	}
	if status != http.StatusCreated {
		return "", fmt.Errorf("client: register: server returned %d", status)
	}
	return resp.Token, nil
}

// Whoami reports the signed-in user for c's configured SessionToken.
func (c *HTTPClient) Whoami(ctx context.Context) (name, email string, err error) {
	var resp struct {
		Name  string `json:"name"`
		Email string `json:"email"`
	}
	status, err := c.do(ctx, http.MethodGet, "/api/auth/session", nil, &resp)
	if err != nil {
		return "", "", err
	}
	if status != http.StatusOK {
		return "", "", fmt.Errorf("client: whoami: not signed in (status %d)", status)
	}
	return resp.Name, resp.Email, nil
}

// Logout invalidates c's configured SessionToken.
func (c *HTTPClient) Logout(ctx context.Context) error {
	status, err := c.do(ctx, http.MethodPost, "/api/auth/logout", nil, nil)
	if err != nil {
		return err
	}
	if status != http.StatusNoContent {
		return fmt.Errorf("client: logout: server returned %d", status)
	}
	return nil
}

// IsFirstUser reports whether the server has no accounts yet -- `amiro auth
// login` uses this to offer registration instead of a login prompt destined
// to fail.
func (c *HTTPClient) IsFirstUser(ctx context.Context) (bool, error) {
	var resp struct {
		IsFirstUser bool `json:"isFirstUser"`
	}
	status, err := c.do(ctx, http.MethodGet, "/api/auth/status", nil, &resp)
	if err != nil {
		return false, err
	}
	if status != http.StatusOK {
		return false, fmt.Errorf("client: auth status: server returned %d", status)
	}
	return resp.IsFirstUser, nil
}

// Health round-trips /health with c's AuthToken -- the liveness check
// discover.go uses to decide a lock file's server is still real.
func (c *HTTPClient) Health(ctx context.Context) bool {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	status, err := c.do(ctx, http.MethodGet, "/health", nil, nil)
	return err == nil && status == http.StatusOK
}

// threadResponseWire mirrors threadapi's unexported threadResponse (GET
// /api/thread's row shape).
type threadResponseWire struct {
	ID            string    `json:"id"`
	Title         string    `json:"title"`
	CreatedAt     time.Time `json:"createdAt"`
	LastMessageAt int64     `json:"lastMessageAt"`
}

// ListThreads implements Client.
func (c *HTTPClient) ListThreads(ctx context.Context) ([]ThreadSummary, error) {
	var rows []threadResponseWire
	status, err := c.do(ctx, http.MethodGet, "/api/thread", nil, &rows)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("client: list threads: server returned %d", status)
	}
	out := make([]ThreadSummary, len(rows))
	for i, r := range rows {
		out[i] = ThreadSummary{ID: r.ID, Title: r.Title, CreatedAt: r.CreatedAt, LastMessageAt: r.LastMessageAt}
	}
	return out, nil
}

// threadMessageWire mirrors threadapi's unexported messageResponse.
type threadMessageWire struct {
	ID       string            `json:"id"`
	Role     string            `json:"role"`
	Parts    []json.RawMessage `json:"parts"`
	Metadata json.RawMessage   `json:"metadata,omitempty"`
}

// threadWithMessagesWire mirrors threadapi's unexported
// threadWithMessagesResponse (GET /api/thread/{id}'s shape).
type threadWithMessagesWire struct {
	ID       string              `json:"id"`
	Title    string              `json:"title"`
	Messages []threadMessageWire `json:"messages"`
}

// GetThread implements Client.
func (c *HTTPClient) GetThread(ctx context.Context, id string) (ThreadDetail, error) {
	var resp threadWithMessagesWire
	status, err := c.do(ctx, http.MethodGet, "/api/thread/"+id, nil, &resp)
	if err != nil {
		return ThreadDetail{}, err
	}
	if status != http.StatusOK {
		return ThreadDetail{}, fmt.Errorf("client: get thread: server returned %d", status)
	}
	messages := make([]ThreadMessage, len(resp.Messages))
	for i, m := range resp.Messages {
		messages[i] = ThreadMessage{ID: m.ID, Role: m.Role, Parts: m.Parts, Metadata: m.Metadata}
	}
	return ThreadDetail{ID: resp.ID, Title: resp.Title, Messages: messages}, nil
}

// DeleteThread implements Client.
func (c *HTTPClient) DeleteThread(ctx context.Context, id string) error {
	status, err := c.do(ctx, http.MethodDelete, "/api/thread/"+id, nil, nil)
	if err != nil {
		return err
	}
	if status >= 300 {
		return fmt.Errorf("client: delete thread: server returned %d", status)
	}
	return nil
}

// modelInfoWire mirrors bifrostai.ModelInfo.
type modelInfoWire struct {
	Name string `json:"name"`
}

// providerModelsWire mirrors bifrostai.ProviderModelsInfo -- GET
// /api/chat/models's element shape, already filtered server-side to
// providers with a configured key (models.go's Handler.Models).
type providerModelsWire struct {
	Provider     string          `json:"provider"`
	ProviderName string          `json:"providerName"`
	Models       []modelInfoWire `json:"models"`
	HasAPIKey    bool            `json:"hasAPIKey"`
}

// ListModels implements Client.
func (c *HTTPClient) ListModels(ctx context.Context) ([]ProviderModels, error) {
	var rows []providerModelsWire
	status, err := c.do(ctx, http.MethodGet, "/api/chat/models", nil, &rows)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("client: list models: server returned %d", status)
	}
	out := make([]ProviderModels, 0, len(rows))
	for _, r := range rows {
		if !r.HasAPIKey {
			continue
		}
		models := make([]string, len(r.Models))
		for i, m := range r.Models {
			models[i] = m.Name
		}
		out = append(out, ProviderModels{Provider: r.Provider, ProviderName: r.ProviderName, Models: models})
	}
	return out, nil
}

// mcpToolInfoWire mirrors bifrostai.MCPToolInfo, reduced to its name.
type mcpToolInfoWire struct {
	Name string `json:"name"`
}

// mcpServerWire mirrors mcp.ServerInfo, reduced to what a mention needs.
type mcpServerWire struct {
	ID       string            `json:"id"`
	Name     string            `json:"name"`
	ToolInfo []mcpToolInfoWire `json:"toolInfo"`
}

// ListMCPServers implements Client.
func (c *HTTPClient) ListMCPServers(ctx context.Context) ([]MCPServer, error) {
	var rows []mcpServerWire
	status, err := c.do(ctx, http.MethodGet, "/api/mcp/list", nil, &rows)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("client: list mcp servers: server returned %d", status)
	}
	out := make([]MCPServer, len(rows))
	for i, r := range rows {
		tools := make([]string, len(r.ToolInfo))
		for j, ti := range r.ToolInfo {
			tools[j] = ti.Name
		}
		out[i] = MCPServer{ID: r.ID, Name: r.Name, Tools: tools}
	}
	return out, nil
}

// workflowWire mirrors workflowapi's unexported workflowSummaryResponse,
// reduced to what a mention needs.
type workflowWire struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// ListWorkflows implements Client.
func (c *HTTPClient) ListWorkflows(ctx context.Context) ([]Workflow, error) {
	var rows []workflowWire
	status, err := c.do(ctx, http.MethodGet, "/api/workflow", nil, &rows)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("client: list workflows: server returned %d", status)
	}
	out := make([]Workflow, len(rows))
	for i, r := range rows {
		out[i] = Workflow{ID: r.ID, Name: r.Name}
	}
	return out, nil
}

// exportRequestWire mirrors chatapi's unexported exportRequest.
type exportRequestWire struct {
	ThreadID string `json:"threadId"`
}

// ExportThread implements Client.
func (c *HTTPClient) ExportThread(ctx context.Context, threadID string) (string, error) {
	var exportID string
	status, err := c.do(ctx, http.MethodPost, "/api/chat/export", exportRequestWire{ThreadID: threadID}, &exportID)
	if err != nil {
		return "", err
	}
	if status != http.StatusOK {
		return "", fmt.Errorf("client: export thread: server returned %d", status)
	}
	return exportID, nil
}

// providerStatusWire mirrors aiapi's unexported ProviderStatusDTO, reduced
// to what the settings page shows.
type providerStatusWire struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Provider   string `json:"provider"`
	Configured bool   `json:"configured"`
}

// ListProviders implements Client.
func (c *HTTPClient) ListProviders(ctx context.Context) ([]ProviderStatus, error) {
	var rows []providerStatusWire
	status, err := c.do(ctx, http.MethodGet, "/api/ai/providers", nil, &rows)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("client: list providers: server returned %d", status)
	}
	out := make([]ProviderStatus, len(rows))
	for i, r := range rows {
		out[i] = ProviderStatus{ID: r.ID, Name: r.Name, Provider: r.Provider, Configured: r.Configured}
	}
	return out, nil
}

// providerConfigWire mirrors aiapi's unexported ProviderConfigDTO -- the
// request shape for setting or updating a provider's key.
type providerConfigWire struct {
	ID       string `json:"id,omitempty"`
	Name     string `json:"name"`
	Provider string `json:"provider"`
	APIKey   string `json:"apiKey"`
	BaseURL  string `json:"baseUrl"`
}

// SetProviderKey implements Client. It updates an existing connection for
// provider in place when one already exists (found via ListProviders,
// matched by provider slug), and creates a new one otherwise --
// ProviderRepository.Set (the endpoint's own backing store) takes an empty
// id to mean "always create," with no dedup of its own, so a client that
// always sent an empty id would grow a duplicate row on every re-save
// of the same provider. The settings page's own scope (Phase 4) is
// "add/update a key", not editing base URLs or model allowlists, which
// stay the desktop settings screen's job.
func (c *HTTPClient) SetProviderKey(ctx context.Context, provider, name, apiKey string) error {
	existingID := ""
	if rows, err := c.ListProviders(ctx); err == nil {
		for _, r := range rows {
			if r.Provider == provider {
				existingID = r.ID
				break
			}
		}
	}

	status, err := c.do(ctx, http.MethodPost, "/api/ai/providers", providerConfigWire{
		ID: existingID, Name: name, Provider: provider, APIKey: apiKey,
	}, nil)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return fmt.Errorf("client: set provider key: server returned %d", status)
	}
	return nil
}

type shadowedSkillWire struct {
	Name     string `json:"name"`
	Scope    string `json:"scope"`
	Source   string `json:"source"`
	Path     string `json:"path"`
	RealPath string `json:"realPath,omitempty"`
	Reason   string `json:"reason"`
}

type skillDiagnosticWire struct {
	Path     string `json:"path"`
	Skill    string `json:"skill,omitempty"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
}

type skillSummaryWire struct {
	Name                   string              `json:"name"`
	Description            string              `json:"description"`
	Scope                  string              `json:"scope"`
	Source                 string              `json:"source"`
	Path                   string              `json:"path"`
	RealPath               string              `json:"realPath,omitempty"`
	Writable               bool                `json:"writable"`
	DisableModelInvocation bool                `json:"disableModelInvocation,omitempty"`
	Shadows                []shadowedSkillWire `json:"shadows,omitempty"`
}

type skillsListResponseWire struct {
	Items       []skillSummaryWire    `json:"items"`
	Diagnostics []skillDiagnosticWire `json:"diagnostics"`
	Truncated   bool                  `json:"truncated"`
}

// ListSkills implements Client.
func (c *HTTPClient) ListSkills(ctx context.Context, project string) (SkillListResult, error) {
	reqPath := "/api/skills"
	if project != "" {
		reqPath += "?project=" + url.QueryEscape(project)
	}
	var resp skillsListResponseWire
	status, err := c.do(ctx, http.MethodGet, reqPath, nil, &resp)
	if err != nil {
		return SkillListResult{}, err
	}
	if status != http.StatusOK {
		return SkillListResult{}, fmt.Errorf("client: list skills: server returned %d", status)
	}

	items := make([]SkillSummary, len(resp.Items))
	for i, it := range resp.Items {
		var shadows []ShadowedSkill
		for _, sh := range it.Shadows {
			shadows = append(shadows, ShadowedSkill{
				Name:     sh.Name,
				Scope:    sh.Scope,
				Source:   sh.Source,
				Path:     sh.Path,
				RealPath: sh.RealPath,
				Reason:   sh.Reason,
			})
		}
		items[i] = SkillSummary{
			Name:                   it.Name,
			Description:            it.Description,
			Scope:                  it.Scope,
			Source:                 it.Source,
			Path:                   it.Path,
			RealPath:               it.RealPath,
			Writable:               it.Writable,
			DisableModelInvocation: it.DisableModelInvocation,
			Shadows:                shadows,
		}
	}

	diags := make([]SkillDiagnostic, len(resp.Diagnostics))
	for i, d := range resp.Diagnostics {
		diags[i] = SkillDiagnostic{
			Path:     d.Path,
			Skill:    d.Skill,
			Severity: d.Severity,
			Message:  d.Message,
		}
	}

	return SkillListResult{
		Items:       items,
		Diagnostics: diags,
		Truncated:   resp.Truncated,
	}, nil
}

// workspaceTrustStatusWire mirrors workspacetrustapi's unexported
// statusResponse.
type workspaceTrustStatusWire struct {
	Trusted      bool   `json:"trusted"`
	ResolvedRoot string `json:"resolvedRoot"`
}

// WorkspaceTrustStatus implements Client.
func (c *HTTPClient) WorkspaceTrustStatus(ctx context.Context, root string) (bool, string, error) {
	reqPath := "/api/workspace-trust/status?root=" + url.QueryEscape(root)
	var resp workspaceTrustStatusWire
	status, err := c.do(ctx, http.MethodGet, reqPath, nil, &resp)
	if err != nil {
		return false, "", err
	}
	if status != http.StatusOK {
		return false, "", fmt.Errorf("client: workspace trust status: server returned %d", status)
	}
	return resp.Trusted, resp.ResolvedRoot, nil
}

// workspaceTrustGrantWire mirrors workspacetrustapi's unexported
// grantRequest.
type workspaceTrustGrantWire struct {
	Root string `json:"root"`
}

// GrantWorkspaceTrust implements Client.
func (c *HTTPClient) GrantWorkspaceTrust(ctx context.Context, root string) error {
	status, err := c.do(ctx, http.MethodPost, "/api/workspace-trust/grant", workspaceTrustGrantWire{Root: root}, nil)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return fmt.Errorf("client: grant workspace trust: server returned %d", status)
	}
	return nil
}

// checkpointFileWire mirrors checkpointapi's unexported fileResponse.
type checkpointFileWire struct {
	Path          string `json:"path"`
	ExistedBefore bool   `json:"existedBefore"`
}

// checkpointFilesWire mirrors checkpointapi's unexported filesResponse.
type checkpointFilesWire struct {
	TurnID string               `json:"turnId"`
	Files  []checkpointFileWire `json:"files"`
}

// LatestCheckpoint implements Client.
func (c *HTTPClient) LatestCheckpoint(ctx context.Context, threadID string) (string, []CheckpointFile, error) {
	reqPath := "/api/checkpoint/latest?threadId=" + url.QueryEscape(threadID)
	var resp checkpointFilesWire
	status, err := c.do(ctx, http.MethodGet, reqPath, nil, &resp)
	if err != nil {
		return "", nil, err
	}
	if status != http.StatusOK {
		return "", nil, fmt.Errorf("client: latest checkpoint: server returned %d", status)
	}
	files := make([]CheckpointFile, len(resp.Files))
	for i, f := range resp.Files {
		files[i] = CheckpointFile{Path: f.Path, ExistedBefore: f.ExistedBefore}
	}
	return resp.TurnID, files, nil
}

// checkpointRestoreRequestWire mirrors checkpointapi's unexported
// restoreRequest.
type checkpointRestoreRequestWire struct {
	ThreadID string `json:"threadId"`
	TurnID   string `json:"turnId"`
}

// checkpointRestoreFileWire mirrors checkpointapi's unexported
// restoreFileResponse.
type checkpointRestoreFileWire struct {
	Path          string `json:"path"`
	ExistedBefore bool   `json:"existedBefore"`
	Restored      bool   `json:"restored"`
	Error         string `json:"error,omitempty"`
}

// checkpointRestoreResponseWire mirrors checkpointapi's unexported
// restoreResponse.
type checkpointRestoreResponseWire struct {
	TurnID string                      `json:"turnId"`
	Files  []checkpointRestoreFileWire `json:"files"`
}

// RestoreCheckpoint implements Client.
func (c *HTTPClient) RestoreCheckpoint(ctx context.Context, threadID, turnID string) ([]CheckpointRestoreResult, error) {
	var resp checkpointRestoreResponseWire
	status, err := c.do(ctx, http.MethodPost, "/api/checkpoint/restore",
		checkpointRestoreRequestWire{ThreadID: threadID, TurnID: turnID}, &resp)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("client: restore checkpoint: server returned %d", status)
	}
	results := make([]CheckpointRestoreResult, len(resp.Files))
	for i, f := range resp.Files {
		results[i] = CheckpointRestoreResult{Path: f.Path, ExistedBefore: f.ExistedBefore, Restored: f.Restored, Error: f.Error}
	}
	return results, nil
}

// sandboxStatusWire mirrors sandboxapi's unexported statusResponse.
type sandboxStatusWire struct {
	Backend   string `json:"backend"`
	Sandboxed bool   `json:"sandboxed"`
}

// SandboxStatus implements Client.
func (c *HTTPClient) SandboxStatus(ctx context.Context) (string, bool, error) {
	var resp sandboxStatusWire
	status, err := c.do(ctx, http.MethodGet, "/api/sandbox/status", nil, &resp)
	if err != nil {
		return "", false, err
	}
	if status != http.StatusOK {
		return "", false, fmt.Errorf("client: sandbox status: server returned %d", status)
	}
	return resp.Backend, resp.Sandboxed, nil
}

// githubStatusWire mirrors githubapi's unexported statusResponse.
type githubStatusWire struct {
	Connected bool `json:"connected"`
}

// GitHubStatus implements Client.
func (c *HTTPClient) GitHubStatus(ctx context.Context) (bool, error) {
	var resp githubStatusWire
	status, err := c.do(ctx, http.MethodGet, "/api/github/status", nil, &resp)
	if err != nil {
		return false, err
	}
	if status != http.StatusOK {
		return false, fmt.Errorf("client: github status: server returned %d", status)
	}
	return resp.Connected, nil
}

// ConnectGitHub implements Client.
func (c *HTTPClient) ConnectGitHub(ctx context.Context, token string) error {
	status, err := c.do(ctx, http.MethodPost, "/api/github/connect", map[string]string{"token": token}, nil)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return fmt.Errorf("client: connect github: server returned %d", status)
	}
	return nil
}

// DisconnectGitHub implements Client.
func (c *HTTPClient) DisconnectGitHub(ctx context.Context) error {
	status, err := c.do(ctx, http.MethodPost, "/api/github/disconnect", nil, nil)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return fmt.Errorf("client: disconnect github: server returned %d", status)
	}
	return nil
}

// backgroundJobWire mirrors backgroundjobapi's unexported jobResponse.
type backgroundJobWire struct {
	ID            string `json:"id"`
	ThreadID      string `json:"threadId"`
	WorkspaceRoot string `json:"workspaceRoot"`
	Prompt        string `json:"prompt"`
	Mode          string `json:"mode"`
	Status        string `json:"status"`
	AutoPR        bool   `json:"autoPr"`
	Error         string `json:"error,omitempty"`
	StartedAt     string `json:"startedAt"`
	FinishedAt    string `json:"finishedAt,omitempty"`
}

func (w backgroundJobWire) toJob() BackgroundJob {
	return BackgroundJob{
		ID: w.ID, ThreadID: w.ThreadID, WorkspaceRoot: w.WorkspaceRoot,
		Prompt: w.Prompt, Mode: w.Mode, Status: w.Status, AutoPR: w.AutoPR,
		Error: w.Error, StartedAt: w.StartedAt, FinishedAt: w.FinishedAt,
	}
}

// CreateBackgroundJob implements Client.
func (c *HTTPClient) CreateBackgroundJob(ctx context.Context, req CreateBackgroundJobRequest) (BackgroundJob, error) {
	body := map[string]any{
		"prompt": req.Prompt, "mode": req.Mode,
		"workspaceRoot": req.WorkspaceRoot, "autoPr": req.AutoPR,
	}
	var resp backgroundJobWire
	status, err := c.do(ctx, http.MethodPost, "/api/background-jobs", body, &resp)
	if err != nil {
		return BackgroundJob{}, err
	}
	if status != http.StatusCreated {
		return BackgroundJob{}, fmt.Errorf("client: create background job: server returned %d", status)
	}
	return resp.toJob(), nil
}

// ListBackgroundJobs implements Client.
func (c *HTTPClient) ListBackgroundJobs(ctx context.Context) ([]BackgroundJob, error) {
	var resp struct {
		Jobs []backgroundJobWire `json:"jobs"`
	}
	status, err := c.do(ctx, http.MethodGet, "/api/background-jobs", nil, &resp)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("client: list background jobs: server returned %d", status)
	}
	jobs := make([]BackgroundJob, 0, len(resp.Jobs))
	for _, w := range resp.Jobs {
		jobs = append(jobs, w.toJob())
	}
	return jobs, nil
}

// GetBackgroundJob implements Client.
func (c *HTTPClient) GetBackgroundJob(ctx context.Context, id string) (BackgroundJob, error) {
	var resp backgroundJobWire
	status, err := c.do(ctx, http.MethodGet, fmt.Sprintf("/api/background-jobs/%s", id), nil, &resp)
	if err != nil {
		return BackgroundJob{}, err
	}
	if status != http.StatusOK {
		return BackgroundJob{}, fmt.Errorf("client: get background job: server returned %d", status)
	}
	return resp.toJob(), nil
}
