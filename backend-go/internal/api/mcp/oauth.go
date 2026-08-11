package mcp

import (
	"encoding/json"
	"fmt"
	"html"
	"net/http"

	"betterchatbot/backend/internal/auth"
	"betterchatbot/backend/internal/mcp"
)

// Authorize ports authorizeMcpClientAction (mcp/actions.ts:140): POST
// /api/mcp/servers/{id}/oauth/authorize, called when the frontend's
// "Authorize" button is clicked (mcp-card.tsx's handleAuthorize) --
// returns the URL to open in a popup window.
func (h *Handler) Authorize(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	id := r.PathValue("id")

	info, err := h.manager.Get(r.Context(), id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if info == nil {
		http.Error(w, "MCP server not found", http.StatusNotFound)
		return
	}
	if !mcp.CanManage(authedUser, info.UserID, info.Visibility) {
		http.Error(w, "Unauthorized", http.StatusForbidden)
		return
	}

	authURL, err := h.manager.StartOAuth(r.Context(), id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"authorizationUrl": authURL})
}

// OAuthCallback ports mcp/oauth/callback/route.ts's GET handler: where the
// authorization server redirects the user's browser back to after they
// approve or deny access. Not session-gated -- the browser arrives here
// with no session cookie or bearer token, only ?code=&state=, the same
// way /storage/{token} is exempted (see httpserver/router.go's
// tokenExemptPrefixes). Renders a small HTML page that postMessages the
// result to window.opener and closes itself, matching
// oauth-redirect.ts's client-side listener exactly (byte-identical
// contract: MCP_OAUTH_SUCCESS / MCP_OAUTH_ERROR).
func (h *Handler) OAuthCallback(w http.ResponseWriter, r *http.Request) {
	code := r.URL.Query().Get("code")
	state := r.URL.Query().Get("state")
	oauthErr := r.URL.Query().Get("error")
	errDescription := r.URL.Query().Get("error_description")

	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	if oauthErr != "" {
		writeOAuthResultPage(w, http.StatusBadRequest, "Authentication Failed",
			fmt.Sprintf("Error: %s. %s", oauthErr, orDefault(errDescription, "Unknown error occurred")),
			"MCP_OAUTH_ERROR", oauthErr, orDefault(errDescription, "Unknown error"))
		return
	}
	if code == "" || state == "" {
		writeOAuthResultPage(w, http.StatusBadRequest, "Authentication Failed", "Missing required parameters",
			"MCP_OAUTH_ERROR", "invalid_request", "Missing authorization code or state parameter")
		return
	}

	if err := h.manager.CompleteOAuth(r.Context(), state, code); err != nil {
		writeOAuthResultPage(w, http.StatusInternalServerError, "Authentication Failed",
			err.Error(), "MCP_OAUTH_ERROR", "auth_failed", "Failed to complete authentication")
		return
	}

	writeOAuthResultPage(w, http.StatusOK, "Authentication Successful!", "You can now close this window.",
		"MCP_OAUTH_SUCCESS", "", "")
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

// writeOAuthResultPage ports createOAuthResponsePage
// (mcp/oauth/callback/route.ts): a minimal self-closing HTML page.
// heading/message can carry query-string-controlled text (the OAuth
// error/error_description params, or an upstream error message) and this
// route is deliberately not session-gated (an external browser redirect
// target, like /storage/{token}) -- html.EscapeString runs on both before
// they're spliced into the body, unlike the TS version's raw template
// interpolation (which only got away with it because it never actually
// needed HTML-escaping for its own test cases; worth being stricter here
// rather than porting a latent reflected-XSS risk). The postMessage
// payload uses jsString (JSON-encoding) for the same untrusted values,
// safe inside a script context independently of the HTML-escaping above.
//
// targetOrigin is "*", not window.location.origin like the TS version:
// there the popup and the opener are the same Next.js app, so its own
// origin IS the opener's. Here this page is served by the Go sidecar
// (e.g. http://127.0.0.1:8787), a different origin than the frontend
// that opened the popup (e.g. http://127.0.0.1:3210, or a Tauri webview
// origin in the real desktop build) -- window.location.origin would be
// the wrong target and the message would silently never arrive. The
// popup can't read window.opener.location.origin to target it precisely
// either (cross-origin window proxies block that). "*" is safe here
// specifically because the payload never carries a token or any other
// secret (only a type/success/error tag), and every process able to
// receive it is on this same loopback machine to begin with.
func writeOAuthResultPage(w http.ResponseWriter, status int, heading, message, postMessageType, errCode, errDescription string) {
	success := postMessageType == "MCP_OAUTH_SUCCESS"
	colorClass, color := "error", "#ef4444"
	if success {
		colorClass, color = "success", "#22c55e"
	}
	title := "OAuth Error"
	if success {
		title = "OAuth Success"
	}

	payload := "{ type: " + jsString(postMessageType) + ", success: " + fmt.Sprintf("%v", success)
	if !success {
		payload += ", error: " + jsString(errCode) + ", error_description: " + jsString(errDescription)
	}
	payload += " }"

	page := `<!DOCTYPE html>
<html>
<head>
  <title>` + title + `</title>
  <style>
    body { font-family: system-ui, sans-serif; text-align: center; padding: 2rem; }
    .` + colorClass + ` { color: ` + color + `; }
  </style>
</head>
<body>
  <script>
    try {
      window.opener && window.opener.postMessage(` + payload + `, '*');
    } catch (e) {
      console.error('Failed to post message:', e);
    }
    setTimeout(function() { window.close(); }, 1000);
  </script>
  <div class="` + colorClass + `">
    <h2>` + html.EscapeString(heading) + `</h2>
    <p>` + html.EscapeString(message) + `</p>
    <p>This window will close automatically.</p>
  </div>
</body>
</html>`

	w.WriteHeader(status)
	_, _ = w.Write([]byte(page))
}

func jsString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
