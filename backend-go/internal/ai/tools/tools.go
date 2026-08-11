// Package tools ports lib/ai/tools/tool-kit.ts's APP_DEFAULT_TOOL_KIT: the
// fixed set of built-in tools every chat request can opt into via
// allowedAppDefaultToolkit, independent of any per-user MCP server config.
// Names and toolkit groupings match DefaultToolName/AppDefaultToolkit
// (lib/ai/tools/index.ts) exactly so a request built by the existing,
// already-live frontend (desktop/src/lib/ai/tools/index.ts, prompt-input.tsx's
// ToolSelectDropdown) needs no changes at all -- only the Go backend ever
// lacked this toolkit.
package tools

import (
	"context"
	"encoding/json"
)

// Toolkit names, matching AppDefaultToolkit's string values exactly.
const (
	ToolkitVisualization = "visualization"
	ToolkitWebSearch     = "webSearch"
	ToolkitHttp          = "http"
	ToolkitCode          = "code"
)

// Tool names, matching DefaultToolName's string values exactly (these are
// wire identifiers: they become "tool-<Name>" UI part types the existing
// frontend already switches on in message-parts.tsx).
const (
	NameCreatePieChart      = "createPieChart"
	NameCreateBarChart      = "createBarChart"
	NameCreateLineChart     = "createLineChart"
	NameCreateTable         = "createTable"
	NameWebSearch           = "webSearch"
	NameWebContent          = "webContent"
	NameHttp                = "http"
	NameJavascriptExecution = "mini-javascript-execution"
	NamePythonExecution     = "python-execution"
)

// Definition is one callable tool: its wire schema (Name/Description/
// ParametersSchema, handed to Bifrost as a ChatTool) plus how to run it.
// Execute nil marks a client-executed tool (JavaScript/Python execution --
// see code.go's doc comment): the model's tool call is streamed to the
// frontend as-is and the turn ends there, exactly like
// pythonExecutionTool/jsExecutionTool having no `execute` in the TS source.
type Definition struct {
	Name             string
	Toolkit          string
	Description      string
	ParametersSchema json.RawMessage
	Execute          func(ctx context.Context, input json.RawMessage) (any, error)
}

// Defaults returns every APP_DEFAULT_TOOL_KIT tool, freshly constructed per
// call so a caller can't mutate the shared definitions (Execute closures
// capture no request state, so this is cheap).
func Defaults() []Definition {
	return append(append(append(visualizationTools(), httpFetchTool()), webSearchTools()...), codeExecutionTools()...)
}

// Filter ports loadAppDefaultTools' selection logic (shared.chat.ts):
//   - defaultToolNames non-empty (built from `mentions` entries of type
//     "defaultTool") selects tools by exact name, ignoring toolkits
//     entirely -- matches the TS `mentions.length` branch.
//   - otherwise, allowedToolkits selects whole toolkits; nil means "every
//     toolkit" (TS's `?? Object.values(AppDefaultToolkit)`), a non-nil
//     pointer to an empty slice means none, matching how the frontend
//     explicitly sends `allowedAppDefaultToolkit: []` while mentions are
//     active (chat-bot.tsx's prepareSendMessagesRequest).
func Filter(defs []Definition, allowedToolkits *[]string, defaultToolNames []string) []Definition {
	if len(defaultToolNames) > 0 {
		wanted := make(map[string]bool, len(defaultToolNames))
		for _, n := range defaultToolNames {
			wanted[n] = true
		}
		out := make([]Definition, 0, len(defaultToolNames))
		for _, d := range defs {
			if wanted[d.Name] {
				out = append(out, d)
			}
		}
		return out
	}

	var allowed map[string]bool
	if allowedToolkits != nil {
		allowed = make(map[string]bool, len(*allowedToolkits))
		for _, k := range *allowedToolkits {
			allowed[k] = true
		}
	}

	out := make([]Definition, 0, len(defs))
	for _, d := range defs {
		if allowed == nil || allowed[d.Toolkit] {
			out = append(out, d)
		}
	}
	return out
}

// FindByName returns the first definition whose Name matches, used by the
// chat handler to look up a tool the model just called.
func FindByName(defs []Definition, name string) (Definition, bool) {
	for _, d := range defs {
		if d.Name == name {
			return d, true
		}
	}
	return Definition{}, false
}
