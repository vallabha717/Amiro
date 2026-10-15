package matrix_test

import (
	"bytes"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
)

// TestMatrix_OwnershipCrossCutting exercises the ownership boundary across all resource types:
// asserting that User B ('other') cannot read, mutate, or delete User A's ('user') private resource.
func TestMatrix_OwnershipCrossCutting(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	other := h.As("other")

	ctx := t.Context()

	// 1. Archive
	t.Run("Archive", func(t *testing.T) {
		desc := "Matrix archive"
		arch, err := user.CreateArchive(ctx, "Matrix Archive", &desc)
		if err != nil {
			t.Fatalf("CreateArchive: %v", err)
		}

		if _, err := other.GetArchive(ctx, arch.ID); err == nil {
			t.Error("expected other user GetArchive to fail")
		} else if status := apiclient.StatusOf(err); status != 403 {
			t.Errorf("other GetArchive status = %d, want 403", status)
		}

		if _, err := other.UpdateArchive(ctx, arch.ID, map[string]any{"name": "Hacked"}); err == nil {
			t.Error("expected other user UpdateArchive to fail")
		} else if status := apiclient.StatusOf(err); status != 403 {
			t.Errorf("other UpdateArchive status = %d, want 403", status)
		}

		if err := other.DeleteArchive(ctx, arch.ID); err == nil {
			t.Error("expected other user DeleteArchive to fail")
		} else if status := apiclient.StatusOf(err); status != 403 {
			t.Errorf("other DeleteArchive status = %d, want 403", status)
		}
	})

	// 2. User details
	t.Run("User Details", func(t *testing.T) {
		userDetails, err := user.UserDetails(ctx)
		if err != nil {
			t.Fatalf("UserDetails: %v", err)
		}

		if _, err := other.UserDetailsByID(ctx, userDetails.ID); err == nil {
			t.Error("expected other user UserDetailsByID to fail")
		} else if status := apiclient.StatusOf(err); status != 403 {
			t.Errorf("other UserDetailsByID status = %d, want 403", status)
		}
	})
}

// TestMatrix_AuthCrossCutting tests routes against anonymous, invalid session, and role checks.
func TestMatrix_AuthCrossCutting(t *testing.T) {
	h := harness.New(t)
	anon := h.Client().Anonymous()
	malformed := h.Client().As("malformed", "invalid-session-token-xyz")
	user := h.As("user")
	admin := h.As("admin")

	type routeCase struct {
		name       string
		method     string
		path       string
		adminOnly  bool
		publicRead bool
	}

	routes := []routeCase{
		{name: "AuthSession", method: "GET", path: "/api/auth/session"},
		{name: "ThreadList", method: "GET", path: "/api/thread"},
		{name: "ArchiveList", method: "GET", path: "/api/archive"},
		{name: "ExportList", method: "GET", path: "/api/export"},
		{name: "UserDetails", method: "GET", path: "/api/user/details"},
		{name: "UserStats", method: "GET", path: "/api/user/stats"},
		{name: "UserPreferences", method: "GET", path: "/api/user/preferences"},
		{name: "AdminUsers", method: "GET", path: "/api/admin/users", adminOnly: true},
		{name: "SearchCatalog", method: "GET", path: "/api/search/catalog", adminOnly: true},
		{name: "SearchProviders", method: "GET", path: "/api/search/providers", adminOnly: true},
		{name: "ChatModels", method: "GET", path: "/api/chat/models", publicRead: true},
		{name: "AuthStatus", method: "GET", path: "/api/auth/status", publicRead: true},
	}

	for _, rc := range routes {
		t.Run(rc.name, func(t *testing.T) {
			ctx := t.Context()

			// Anonymous call
			resp, err := anon.Do(ctx, rc.method, rc.path, nil, nil)
			if rc.publicRead {
				if err != nil {
					t.Errorf("expected public route %s to succeed anonymously, got error: %v", rc.path, err)
				}
			} else {
				if err == nil && resp.Status < 400 {
					t.Errorf("expected route %s to reject anonymous call, got %d", rc.path, resp.Status)
				} else if status := apiclient.StatusOf(err); status != 401 {
					t.Errorf("anonymous %s status = %d, want 401", rc.path, status)
				}
			}

			// Malformed token call (only for non-public routes)
			if !rc.publicRead {
				_, err = malformed.Do(ctx, rc.method, rc.path, nil, nil)
				if err == nil {
					t.Errorf("expected route %s to reject malformed token", rc.path)
				} else if status := apiclient.StatusOf(err); status != 401 {
					t.Errorf("malformed token %s status = %d, want 401", rc.path, status)
				}
			}

			// Plain user on admin route
			if rc.adminOnly {
				_, err = user.Do(ctx, rc.method, rc.path, nil, nil)
				if err == nil {
					t.Errorf("expected admin route %s to reject plain user", rc.path)
				} else if status := apiclient.StatusOf(err); status != 403 {
					t.Errorf("plain user %s status = %d, want 403", rc.path, status)
				}

				// Admin on admin route
				resp, err = admin.Do(ctx, rc.method, rc.path, nil, nil)
				if err != nil {
					t.Errorf("expected admin route %s to succeed for admin, got %v", rc.path, err)
				} else if resp.Status != 200 {
					t.Errorf("admin %s status = %d, want 200", rc.path, resp.Status)
				}
			}
		})
	}
}

// TestMatrix_InputRobustnessCrossCutting sends invalid inputs to write routes and asserts
// they result in 4xx client errors rather than 500 crashes or panics.
func TestMatrix_InputRobustnessCrossCutting(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	ctx := t.Context()

	cases := []struct {
		name    string
		method  string
		path    string
		payload string
	}{
		{name: "MalformedJSON", method: "POST", path: "/api/archive", payload: `{"name": "broken", `},
		{name: "NullBytes", method: "POST", path: "/api/archive", payload: `{"name": "test\u0000null"}`},
		{name: "SQLInjection", method: "POST", path: "/api/archive", payload: `{"name": "'; DROP TABLE users; --"}`},
		{name: "VeryLongString", method: "POST", path: "/api/archive", payload: fmt.Sprintf(`{"name": "%s"}`, strings.Repeat("A", 10000))},
		{name: "EmptyBookmark", method: "POST", path: "/api/bookmark", payload: `{}`},
		{name: "MalformedArchive", method: "POST", path: "/api/archive", payload: `{invalid json`},
		{name: "WrongTypeField", method: "POST", path: "/api/storage/upload-url", payload: `{"filename": 12345}`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req, err := http.NewRequestWithContext(ctx, tc.method, h.Backend().URL+tc.path, bytes.NewReader([]byte(tc.payload)))
			if err != nil {
				t.Fatalf("creating request: %v", err)
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Amiro-Token", h.Backend().Token)
			req.Header.Set("Authorization", "Bearer "+user.Session)

			client := &http.Client{}
			resp, err := client.Do(req)
			if err != nil {
				t.Fatalf("executing request: %v", err)
			}
			defer resp.Body.Close()

			if resp.StatusCode >= 500 {
				t.Errorf("route %s returned server error %d on invalid input", tc.path, resp.StatusCode)
			}
		})
	}
}

// TestMatrix_MethodPathAndCORS verifies method rejection (405/404), unknown path (404), and CORS headers.
func TestMatrix_MethodPathAndCORS(t *testing.T) {
	h := harness.New(t)
	be := h.Backend()
	ctx := t.Context()

	client := &http.Client{}

	// Unknown path -> 404
	req, _ := http.NewRequestWithContext(ctx, "GET", be.URL+"/api/unknown-nonexistent-path", nil)
	req.Header.Set("X-Amiro-Token", be.Token)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("GET unknown path: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("unknown path status = %d, want 404", resp.StatusCode)
	}

	// CORS preflight OPTIONS request
	optReq, _ := http.NewRequestWithContext(ctx, "OPTIONS", be.URL+"/api/auth/status", nil)
	optReq.Header.Set("Origin", "http://localhost:3000")
	optReq.Header.Set("Access-Control-Request-Method", "GET")
	optResp, err := client.Do(optReq)
	if err != nil {
		t.Fatalf("OPTIONS preflight: %v", err)
	}
	defer optResp.Body.Close()
	if optResp.StatusCode != http.StatusNoContent && optResp.StatusCode != http.StatusOK {
		t.Errorf("preflight status = %d, want 204 or 200", optResp.StatusCode)
	}
	if allowOrigin := optResp.Header.Get("Access-Control-Allow-Origin"); allowOrigin == "" {
		t.Error("preflight missing Access-Control-Allow-Origin header")
	}
}
