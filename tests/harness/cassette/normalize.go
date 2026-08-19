package cassette

import (
	"bytes"
	"encoding/json"
	"regexp"
	"sort"
	"strings"
)

var (
	uuidRegex       = regexp.MustCompile(`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`)
	callIDRegex     = regexp.MustCompile(`call_[0-9a-zA-Z_]+`)
	workspacePathRe = regexp.MustCompile(`/(tmp|home|var|private)/[^\s"':]+`)
	dateRegex       = regexp.MustCompile(`\b\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2}))?\b`)
)

// Normalize canonicalizes a method, path, and request body for cassette matching.
// It removes non-deterministic identifiers, dynamic dates/paths, and sorts map keys.
func Normalize(method, path string, bodyBytes []byte) (string, error) {
	method = strings.ToUpper(strings.TrimSpace(method))
	path = strings.TrimSpace(path)

	if len(bodyBytes) == 0 {
		return method + " " + path, nil
	}

	var raw any
	if err := json.Unmarshal(bodyBytes, &raw); err != nil {
		// Not valid JSON, return cleaned raw string
		return method + " " + path + "\n" + cleanString(string(bodyBytes)), nil
	}

	normalized := normalizeValue(raw)
	canonicalJSON, err := json.Marshal(normalized)
	if err != nil {
		return "", err
	}

	return method + " " + path + "\n" + string(canonicalJSON), nil
}

func normalizeValue(v any) any {
	switch val := v.(type) {
	case map[string]any:
		res := make(map[string]any)
		for k, item := range val {
			// Strip volatile parameters that vary per request run
			lowerKey := strings.ToLower(k)
			if lowerKey == "max_tokens" || lowerKey == "created" || lowerKey == "timestamp" || lowerKey == "request_id" || lowerKey == "stream_options" {
				continue
			}
			res[k] = normalizeValue(item)
		}
		return res
	case []any:
		res := make([]any, len(val))
		for i, item := range val {
			res[i] = normalizeValue(item)
		}
		return res
	case string:
		return cleanString(val)
	default:
		return v
	}
}

func cleanString(s string) string {
	// Normalize dynamic system-prompt lines
	lines := strings.Split(s, "\n")
	cleanedLines := make([]string, 0, len(lines))
	for _, l := range lines {
		trimmed := strings.TrimSpace(l)
		if strings.HasPrefix(trimmed, "Current date/time:") ||
			strings.HasPrefix(trimmed, "Today is") ||
			strings.HasPrefix(trimmed, "Date:") ||
			strings.HasPrefix(trimmed, "Working directory:") ||
			strings.HasPrefix(trimmed, "Workspace root:") {
			cleanedLines = append(cleanedLines, "<DYNAMIC_SYSTEM_PROMPT_LINE>")
			continue
		}
		cleanedLines = append(cleanedLines, l)
	}
	s = strings.Join(cleanedLines, "\n")

	s = uuidRegex.ReplaceAllString(s, "<UUID>")
	s = callIDRegex.ReplaceAllString(s, "<CALL_ID>")
	s = dateRegex.ReplaceAllString(s, "<DATE>")
	s = workspacePathRe.ReplaceAllString(s, "<PATH>")
	return strings.TrimSpace(s)
}

// CanonicalizeJSON ensures JSON keys are sorted and formatted identically.
func CanonicalizeJSON(data []byte) ([]byte, error) {
	var val any
	if err := json.Unmarshal(data, &val); err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(val); err != nil {
		return nil, err
	}
	return bytes.TrimSpace(buf.Bytes()), nil
}

// SortedKeys returns sorted keys of a map.
func SortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
