// Package seed applies declarative fixtures through the REAL API.
//
// Not by writing rows. That is slower, and it is the right trade: seeding
// through POST /api/auth/register means the seed itself exercises the
// endpoints, so a seed that breaks is a genuine signal rather than a
// fixture that quietly drifted out of the shape the app expects.
package seed

import (
	"context"
	"fmt"

	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/config"
)

// Identity is one seeded account and the session it holds.
type Identity struct {
	Key      string // "admin", "user", "other"
	Name     string
	Email    string
	Password string
	UserID   string
	Role     string
	Token    string

	client *apiclient.Client
}

// Client returns an API client acting as this identity.
func (i *Identity) Client() *apiclient.Client { return i.client }

// State is what seeds read and write. It accumulates, so seeds compose.
type State struct {
	Ctx      context.Context
	Base     *apiclient.Client
	Config   *config.Config
	Accounts map[string]*Identity
	ProxyURL string

	// Created records ids by kind, so a later seed (or the test) can refer
	// to what an earlier one made without threading return values through.
	Created map[string][]string
}

// Record notes a created object.
func (s *State) Record(kind, id string) {
	if s.Created == nil {
		s.Created = map[string][]string{}
	}
	s.Created[kind] = append(s.Created[kind], id)
}

// Identity returns a seeded account by key, or nil.
func (s *State) Identity(key string) *Identity { return s.Accounts[key] }

// Seed is one composable fixture.
type Seed struct {
	Name  string
	Apply func(s *State) error
}

// Apply runs seeds in order against a fresh backend.
func Apply(ctx context.Context, base *apiclient.Client, cfg *config.Config, seeds ...Seed) (*State, error) {
	return ApplyWithProxy(ctx, base, cfg, "", seeds...)
}

// ApplyWithProxy runs seeds with a provider proxy base URL.
func ApplyWithProxy(ctx context.Context, base *apiclient.Client, cfg *config.Config, proxyURL string, seeds ...Seed) (*State, error) {
	state := &State{
		Ctx:      ctx,
		Base:     base,
		Config:   cfg,
		Accounts: map[string]*Identity{},
		Created:  map[string][]string{},
		ProxyURL: proxyURL,
	}
	for _, s := range seeds {
		if s.Apply == nil {
			continue
		}
		if err := s.Apply(state); err != nil {
			return state, fmt.Errorf("seed %q: %w", s.Name, err)
		}
	}
	return state, nil
}

// Default registers admin, user and other, IN THAT ORDER.
//
// The order is load-bearing: backend-go/internal/auth makes the FIRST
// registered account the admin. A test that wants to verify that rule uses
// harness.NoSeed() and registers by hand -- which is also why this is a
// seed rather than something harness.New does unconditionally.
var Default = Seed{Name: "default-accounts", Apply: func(s *State) error {
	status, err := s.Base.AuthStatus(s.Ctx)
	if err != nil {
		return fmt.Errorf("reading /api/auth/status: %w", err)
	}
	if !status.IsFirstUser {
		// Seeding a database that already has accounts would silently make
		// `admin` a plain user, and every permission assertion downstream
		// would then be testing the wrong thing. Fail loudly instead.
		return fmt.Errorf("the database is not empty (isFirstUser=false); seed.Default requires a fresh one")
	}
	accounts := []struct {
		key string
		acc config.Account
	}{
		{"admin", s.Config.Accounts.Admin},
		{"user", s.Config.Accounts.User},
		{"other", s.Config.Accounts.Other},
	}
	for _, a := range accounts {
		id, err := register(s, a.key, a.acc)
		if err != nil {
			return err
		}
		s.Accounts[a.key] = id
	}
	if s.Accounts["admin"].Role != "admin" {
		return fmt.Errorf("the first registered account has role %q, expected \"admin\"; "+
			"either the database was not empty or internal/auth's first-user rule changed",
			s.Accounts["admin"].Role)
	}

	// Seed AI provider pointing to cassette proxy if available
	if s.ProxyURL != "" {
		adminClient := s.Accounts["admin"].Client()
		_, _ = adminClient.SaveProvider(s.Ctx, apiclient.ProviderInput{
			Name:     "OpenAI",
			Provider: "openai",
			APIKey:   "test-fake-key",
			BaseURL:  s.ProxyURL + "/openai",
			Models:   []string{"gpt-4.1", "gpt-4.1-mini", "o4-mini", "o3"},
		})
		_, _ = adminClient.SaveProvider(s.Ctx, apiclient.ProviderInput{
			Name:     "Anthropic",
			Provider: "anthropic",
			APIKey:   "test-fake-key",
			BaseURL:  s.ProxyURL + "/anthropic",
			Models:   []string{"claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-5"},
		})
	}
	return nil
}}

func register(s *State, key string, acc config.Account) (*Identity, error) {
	name := key
	session, err := s.Base.Register(s.Ctx, name, acc.Email, acc.Password)
	if err != nil {
		return nil, fmt.Errorf("registering %s (%s): %w", key, acc.Email, err)
	}
	return &Identity{
		Key: key, Name: name, Email: acc.Email, Password: acc.Password,
		UserID: session.User.ID, Role: session.User.Role, Token: session.Token,
		client: s.Base.As(key, session.Token),
	}, nil
}


// Archives creates n archives owned by the `user` account.
func Archives(n int) Seed {
	return Seed{Name: fmt.Sprintf("archives(%d)", n), Apply: func(s *State) error {
		owner := s.Identity("user")
		if owner == nil {
			return fmt.Errorf("requires seed.Default to have run first (no `user` account)")
		}
		for i := 0; i < n; i++ {
			a, err := owner.Client().CreateArchive(s.Ctx, fmt.Sprintf("seed-archive-%d", i+1), nil)
			if err != nil {
				return err
			}
			s.Record("archive", a.ID)
		}
		return nil
	}}
}

// As returns a seed that runs body as one identity, for one-off fixtures a
// test needs but does not want to spell out inline.
func As(key string, name string, body func(s *State, c *apiclient.Client) error) Seed {
	return Seed{Name: name, Apply: func(s *State) error {
		id := s.Identity(key)
		if id == nil {
			return fmt.Errorf("no seeded identity %q", key)
		}
		return body(s, id.Client())
	}}
}
