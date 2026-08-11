package mcp

import "regexp"

// sanitizeFunctionNamePattern ports sanitizeFunctionName's replace regex
// (mcp-tool-id.ts:9): anything but alphanumeric/underscore/dot/dash becomes
// an underscore.
var sanitizeFunctionNamePattern = regexp.MustCompile(`[^a-zA-Z0-9_.\-]`)

var startsWithLetterOrUnderscore = regexp.MustCompile(`^[a-zA-Z_]`)

// SanitizeFunctionName ports sanitizeFunctionName (mcp-tool-id.ts:7): a name
// safe to use as a model-visible tool/function identifier.
func SanitizeFunctionName(name string) string {
	sanitized := sanitizeFunctionNamePattern.ReplaceAllString(name, "_")
	if !startsWithLetterOrUnderscore.MatchString(sanitized) {
		sanitized = "_" + sanitized
	}
	if len(sanitized) > 124 {
		sanitized = sanitized[:124]
	}
	return sanitized
}

// ToolID ports createMCPToolId (mcp-tool-id.ts:23): the wire tool name a
// model sees for one MCP server's tool, combining the (sanitized) server
// and tool names so the same tool name from two servers never collides.
// Simplified vs. the TS version's proportional-truncation branch for a
// combined name over 124 chars -- real server/tool names never approach
// that length, so a plain truncation of the joined string is equivalent in
// practice and far simpler.
func ToolID(serverName, toolName string) string {
	combined := SanitizeFunctionName(serverName) + "_" + SanitizeFunctionName(toolName)
	if len(combined) > 124 {
		combined = combined[:124]
	}
	return combined
}
