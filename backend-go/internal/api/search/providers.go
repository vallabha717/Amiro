// Package search serves the admin UI for web-search providers.
//
// # Three rules that shape every handler here
//
//  1. **Admin only, except GetActive.** Every endpoint that can read or
//     write a provider's API key requires admin, because they sit behind an
//     /admin/search screen. Gating on a session alone -- which is what this
//     package used to do -- meant any registered user could list, rewrite or
//     delete them. GetActive is the deliberate exception: see its own
//     comment for why "which engine is answering my search" is not the same
//     kind of fact as the key behind it.
//
//  2. **Keys never leave the server.** A stored key is reported as a masked
//     hint (`sk-…9f2c`) and never in full. The editor round-trips by sending
//     an empty apiKey to mean "keep the stored one", so the browser never
//     needs the real value, and an XSS or a shared screen cannot leak what
//     was never sent.
//
//  3. **The active provider's label lives in one table.** GetStatuses,
//     GetActive and the editor's picker all resolve a provider kind to its
//     display label through search.SpecFor, never a copy of the name.
package search

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"amiro/backend/internal/api/httpjson"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/db/repository"
	"amiro/backend/internal/search"
)

type Handler struct {
	repo *repository.SearchProviderRepository
}

func NewHandler(repo *repository.SearchProviderRepository) *Handler {
	return &Handler{repo: repo}
}

// requireAdmin mirrors internal/api/admin's own check.
//
// Duplicated rather than exported from there for the reason that package's
// comment already gives: it is a three-line inline check that several
// packages make independently, and a shared helper would put an import edge
// between every admin surface and the user-management API.
func requireAdmin(w http.ResponseWriter, r *http.Request) bool {
	user, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return false
	}
	if user.Role != "admin" {
		httpjson.Forbidden(w)
		return false
	}
	return true
}

// ProviderConfigDTO is what the editor submits.
type ProviderConfigDTO struct {
	ID       string `json:"id,omitempty"`
	Name     string `json:"name"`
	Provider string `json:"provider"`
	// APIKey empty on an update means "keep the stored key". See the
	// package comment.
	APIKey string `json:"apiKey"`
}

// ProviderStatusDTO is what the list returns. Note the absence of a full
// APIKey field -- that is the point, not an oversight.
type ProviderStatusDTO struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Provider   string `json:"provider"`
	Configured bool   `json:"configured"`
	APIKeyHint string `json:"apiKeyHint,omitempty"`
	IsActive   bool   `json:"isActive"`
	// Extracts tells the UI whether choosing this provider keeps the
	// web_content tool working, so that trade-off is visible at the moment
	// of choosing rather than discovered when a tool call fails.
	Extracts bool `json:"extracts"`
}

// maskKey renders a key as a recognisable hint.
//
// Enough to tell two keys apart when you have several -- which is the only
// thing the admin screen needs it for -- and not enough to use.
func maskKey(key string) string {
	if key == "" {
		return ""
	}
	if len(key) <= 8 {
		return strings.Repeat("•", len(key))
	}
	return key[:3] + "…" + key[len(key)-4:]
}

func (h *Handler) GetStatuses(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}

	configs, err := h.repo.List(r.Context())
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}

	statuses := make([]ProviderStatusDTO, 0, len(configs))
	for _, c := range configs {
		spec, known := search.SpecFor(c.Provider)
		statuses = append(statuses, ProviderStatusDTO{
			ID:       c.ID,
			Name:     c.Name,
			Provider: c.Provider,
			// Every surviving provider needs a key, so "configured" is
			// exactly "has one" -- no per-provider special cases left.
			Configured: c.APIKey != "",
			APIKeyHint: maskKey(c.APIKey),
			IsActive:   c.IsActive,
			Extracts:   known && spec.Extracts,
		})
	}

	httpjson.OK(w, statuses)
}

// ActiveProviderDTO is what GetActive reports: enough to label a search in
// the chat UI, and nothing that was ever a secret.
type ActiveProviderDTO struct {
	Configured bool   `json:"configured"`
	Provider   string `json:"provider,omitempty"`
	// Label is the human name ("Brave Search"), not the wire id ("brave") --
	// the chat UI shows this directly next to "Searched the web", and a
	// user reading "via brave" learns less than "via Brave Search".
	Label string `json:"label,omitempty"`
	// Extracts tells the composer's tools menu whether web_content will
	// work with the current provider, same as ProviderStatusDTO.Extracts.
	Extracts bool `json:"extracts,omitempty"`
}

// GetActive reports which provider currently answers web_search and
// web_content, without exposing anything that identifies or authenticates
// it beyond that.
//
// Deliberately open to any authenticated user, not gated to admin like
// every other handler in this file. "Which engine answered this search" is
// a fact about a message the user is looking at, the same way a citation is
// -- withholding it from a non-admin would make every web search a black
// box for anyone but the person who configured it, while giving up nothing:
// the API key is precisely what this response never carries.
func (h *Handler) GetActive(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.UserFromContext(r.Context()); !ok {
		httpjson.Unauthorized(w)
		return
	}

	cfg, err := h.repo.GetActive(r.Context())
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	if cfg == nil {
		httpjson.OK(w, ActiveProviderDTO{Configured: false})
		return
	}

	spec, _ := search.SpecFor(cfg.Provider)
	httpjson.OK(w, ActiveProviderDTO{
		Configured: true,
		Provider:   cfg.Provider,
		Label:      spec.Label,
		Extracts:   spec.Extracts,
	})
}

// GetCatalog lists the providers this build supports.
//
// Served rather than hardcoded in the frontend so that adding a provider to
// internal/search.Specs is the whole change: the picker, the free-tier note
// and the "extracts content" badge all follow from the one table that the
// adapters live next to.
func (h *Handler) GetCatalog(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	httpjson.OK(w, search.Specs)
}

func (h *Handler) SetConfig(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}

	var req ProviderConfigDTO
	if !httpjson.Decode(w, r, &req) {
		return
	}

	req.Name = strings.TrimSpace(req.Name)
	req.Provider = strings.TrimSpace(req.Provider)
	req.APIKey = strings.TrimSpace(req.APIKey)

	if req.Name == "" {
		httpjson.BadRequest(w, "name is required")
		return
	}
	// Validated against the registry, not merely non-empty. An unrecognised
	// provider string used to be storable and then resolved to a silent
	// default at search time; rejecting it here is the only place the user
	// is still on screen to fix it.
	if _, ok := search.SpecFor(req.Provider); !ok {
		httpjson.BadRequest(w, "unknown provider -- supported: "+search.SupportedList())
		return
	}
	// A new config with no key would be saved as unusable and only report
	// that on the first search.
	if req.ID == "" && req.APIKey == "" {
		httpjson.BadRequest(w, "an API key is required")
		return
	}

	id, err := h.repo.Set(r.Context(), req.ID, req.Provider, req.Name, req.APIKey)
	if err != nil {
		if errors.Is(err, repository.ErrSearchProviderNotFound) {
			httpjson.NotFound(w, "provider not found")
			return
		}
		httpjson.ServerError(w, err)
		return
	}

	httpjson.OK(w, map[string]string{"id": id})
}

func (h *Handler) DeleteConfig(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}

	id := r.PathValue("id")
	if id == "" {
		httpjson.BadRequest(w, "id required")
		return
	}

	if err := h.repo.Delete(r.Context(), id); err != nil {
		if errors.Is(err, repository.ErrSearchProviderNotFound) {
			httpjson.NotFound(w, "provider not found")
			return
		}
		httpjson.ServerError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) Activate(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}

	id := r.PathValue("id")
	if id == "" {
		httpjson.BadRequest(w, "id required")
		return
	}

	if err := h.repo.SetActive(r.Context(), id); err != nil {
		if errors.Is(err, repository.ErrSearchProviderNotFound) {
			httpjson.NotFound(w, "provider not found")
			return
		}
		httpjson.ServerError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type TestResult struct {
	OK        bool   `json:"ok"`
	Provider  string `json:"provider"`
	LatencyMs int64  `json:"latencyMs"`
	Count     int    `json:"count"`
	Error     string `json:"error,omitempty"`
}

// testTimeout bounds a Ping. Shorter than the provider clients' own timeout
// so the button always resolves rather than appearing to hang.
const testTimeout = 15 * time.Second

func (h *Handler) TestProvider(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}

	id := r.PathValue("id")
	if id == "" {
		httpjson.BadRequest(w, "id required")
		return
	}

	cfg, err := h.repo.Get(r.Context(), id)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	if cfg == nil {
		httpjson.NotFound(w, "provider not found")
		return
	}

	provider, err := search.New(cfg.Provider, cfg.APIKey)
	if err != nil {
		// A 200 carrying ok:false, not a 4xx. This is the *result of the
		// test*, which the page renders in place; an error status would
		// send the client's fetch down its failure path and show a toast
		// instead of the panel the user pressed the button to see.
		httpjson.OK(w, TestResult{Provider: cfg.Name, Error: err.Error()})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), testTimeout)
	defer cancel()

	started := time.Now()
	results, searchErr := provider.Search(ctx, "latest technology news", 3)
	result := TestResult{
		Provider:  cfg.Name,
		LatencyMs: time.Since(started).Milliseconds(),
	}
	if searchErr != nil {
		result.Error = searchErr.Error()
	} else {
		result.OK = true
		result.Count = len(results)
	}

	httpjson.OK(w, result)
}
