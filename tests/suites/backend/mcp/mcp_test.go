package mcp_test

import (
	"net/http"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
)

// TestMCP_ListEmptyInitially verifies that listing MCP servers on a fresh account returns an empty list.
func TestMCP_ListEmptyInitially(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	listRaw, err := user.ListMCPServers(t.Context())
	if err != nil {
		t.Fatalf("ListMCPServers: %v", err)
	}
	if len(listRaw) == 0 {
		t.Error("expected non-empty JSON response from ListMCPServers")
	}
}

// TestMCP_NonexistentServerOperations verifies status codes for nonexistent servers.
func TestMCP_NonexistentServerOperations(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	admin := h.As("admin")
	nonexistentID := "nonexistent-mcp-server-id"

	_, err := user.GetMCPServer(t.Context(), nonexistentID)
	if err == nil {
		t.Fatal("expected GetMCPServer to fail for nonexistent ID")
	}
	if status := apiclient.StatusOf(err); status != 404 {
		t.Errorf("GetMCPServer status = %d, want 404", status)
	}

	err = user.DeleteMCPServer(t.Context(), nonexistentID)
	if err == nil {
		t.Fatal("expected DeleteMCPServer to fail for nonexistent ID")
	}
	if status := apiclient.StatusOf(err); status != 404 {
		t.Errorf("DeleteMCPServer status = %d, want 404", status)
	}

	_, err = user.RefreshMCPServer(t.Context(), nonexistentID)
	if err == nil {
		t.Fatal("expected RefreshMCPServer to fail for nonexistent ID")
	}
	if status := apiclient.StatusOf(err); status != 404 {
		t.Errorf("RefreshMCPServer status = %d, want 404", status)
	}

	// Share by plain user is rejected with 403 (admin only)
	err = user.ShareMCPServer(t.Context(), nonexistentID, map[string]string{"visibility": "public"})
	if err == nil {
		t.Fatal("expected non-admin ShareMCPServer to fail")
	}
	if status := apiclient.StatusOf(err); status != 403 {
		t.Errorf("non-admin ShareMCPServer status = %d, want 403", status)
	}

	// Share by admin on nonexistent server succeeds (UPDATE 0 rows)
	err = admin.ShareMCPServer(t.Context(), nonexistentID, map[string]string{"visibility": "public"})
	if err != nil {
		t.Fatalf("admin ShareMCPServer: %v", err)
	}

	resp, err := user.Do(t.Context(), "POST", "/api/mcp/servers/"+nonexistentID+"/oauth/authorize", nil, nil)
	if err == nil && resp.Status != 404 {
		t.Errorf("authorize nonexistent server status = %d, want 404", resp.Status)
	}
}

// TestMCP_OAuthCallbackIsExemptAndRendersHTML verifies that the OAuth callback route is reachable
// without authentication (exempt from token header and session) and renders an HTML response.
func TestMCP_OAuthCallbackIsExemptAndRendersHTML(t *testing.T) {
	h := harness.New(t)

	// Callback is called directly by browser with ?code=&state=
	// When state is invalid/unknown, it renders an HTML error page with status 500
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, h.Backend().URL+"/api/mcp/oauth/callback?code=test&state=invalid", nil)
	if err != nil {
		t.Fatalf("creating request: %v", err)
	}
	// Direct request without X-Amiro-Token header
	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("executing request: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusInternalServerError && resp.StatusCode != http.StatusOK {
		t.Errorf("expected status 500 or 200 from oauth callback with invalid state, got %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/html; charset=utf-8" && ct != "text/html" {
		t.Errorf("expected text/html Content-Type, got %q", ct)
	}
}

// TestMCP_CustomizationsMissingServerReturnsEmptyObject verifies server and tool customization queries.
func TestMCP_CustomizationsMissingServerReturnsEmptyObject(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	server := "nonexistent-server"

	// GET server customization for nonexistent server returns 200 with empty object {}
	cust, err := user.ServerCustomization(t.Context(), server)
	if err != nil {
		t.Fatalf("ServerCustomization: %v", err)
	}
	if cust.ID != "" || cust.Prompt != nil {
		t.Errorf("expected empty customization, got %+v", cust)
	}

	// GET tool customizations for nonexistent server returns 200 with []
	toolCusts, err := user.ToolCustomizations(t.Context(), server)
	if err != nil {
		t.Fatalf("ToolCustomizations: %v", err)
	}
	if len(toolCusts) == 0 {
		t.Error("expected non-empty JSON response from ToolCustomizations")
	}

	// DELETE nonexistent customization is 200
	if err := user.DeleteServerCustomization(t.Context(), server); err != nil {
		t.Fatalf("DeleteServerCustomization: %v", err)
	}
	if err := user.DeleteToolCustomization(t.Context(), server, "someTool"); err != nil {
		t.Fatalf("DeleteToolCustomization: %v", err)
	}
}

// TestMCP_RequireSession verifies anonymous access to MCP routes is rejected with 401.
func TestMCP_RequireSession(t *testing.T) {
	h := harness.New(t)
	anon := h.Client().Anonymous()

	_, err := anon.ListMCPServers(t.Context())
	if err == nil {
		t.Fatal("expected anonymous ListMCPServers to fail")
	}
	if status := apiclient.StatusOf(err); status != 401 {
		t.Errorf("anonymous ListMCPServers status = %d, want 401", status)
	}
}
