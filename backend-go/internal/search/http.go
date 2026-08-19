package search

import (
	"fmt"
	"html"
	"mime"
	"net/http"
	"regexp"
	"strings"
)

// requireJSON rejects a 2xx response that is not actually JSON.
//
// This exists because of a specific, previously-shipped bug class rather
// than out of caution. An interstitial -- a bot challenge, a captive portal,
// a provider's HTML error page -- is commonly served as 200 with an HTML
// body. A client that checks only the status code then hands that HTML to
// the JSON decoder and reports `invalid character '<' looking for beginning
// of value`, which tells the user nothing about being blocked and sends
// whoever debugs it looking for a parser bug.
//
// Checking the content type turns that into one sentence naming the actual
// problem, before a single byte is parsed.
func requireJSON(provider string, resp *http.Response) error {
	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		// No content type at all is unusual but not proof of anything;
		// let the decoder speak rather than inventing a failure.
		return nil
	}
	mediaType, _, err := mime.ParseMediaType(ct)
	if err != nil {
		return nil
	}
	if mediaType == "application/json" || strings.HasSuffix(mediaType, "+json") {
		return nil
	}
	if mediaType == "text/html" {
		return fmt.Errorf("%s returned an HTML page instead of JSON -- the request was most likely intercepted by a bot check or an error page, not answered by the API", provider)
	}
	return fmt.Errorf("%s returned %s instead of JSON", provider, mediaType)
}

var tagPattern = regexp.MustCompile(`<[^>]*>`)

// stripTags removes inline markup from a snippet and decodes entities.
//
// Several providers bold the matched query terms in their snippets. Those
// tags are presentation for a search results page; passed through to a model
// they become literal `<strong>` it echoes into its answer.
func stripTags(s string) string {
	return strings.TrimSpace(html.UnescapeString(tagPattern.ReplaceAllString(s, "")))
}

// truncate caps extracted page text at the caller's requested budget.
//
// Cut on a rune boundary: slicing a UTF-8 string at an arbitrary byte
// produces invalid UTF-8, which survives Go's string type and then fails at
// the JSON encoder -- a whole tool call lost to a multi-byte character
// landing on the limit.
func truncate(s string, max int) string {
	if max <= 0 || len(s) <= max {
		return s
	}
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max])
}
