package oauth

import "net/url"

// BuildAuthorizationURL ports redirectToAuthorization's URL construction
// (RFC 6749 §4.1.1 + RFC 7636 §4.3): the authorization-code grant with a
// PKCE S256 challenge attached. scope may be empty -- omitted from the
// query string entirely rather than sent blank, matching how most
// authorization servers treat an empty scope param as "explicitly no
// scopes" rather than "use the default."
func BuildAuthorizationURL(authorizationEndpoint, clientID, redirectURI, state, codeChallenge, scope string) (string, error) {
	u, err := url.Parse(authorizationEndpoint)
	if err != nil {
		return "", err
	}
	q := u.Query()
	q.Set("response_type", "code")
	q.Set("client_id", clientID)
	q.Set("redirect_uri", redirectURI)
	q.Set("state", state)
	q.Set("code_challenge", codeChallenge)
	q.Set("code_challenge_method", "S256")
	if scope != "" {
		q.Set("scope", scope)
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}
