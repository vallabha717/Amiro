// Package workflow ports src/lib/ai/workflow/**'s node-execution logic
// (Phase 5): node/branch/tool types, the runtime state store, per-kind
// executors, and the graph engine. The @xyflow/react graph UI, node
// validation, cycle detection, and dependency-schema helpers all stay
// client-side per the plan (section 6, Phase 5) -- nothing here is reachable
// from the frontend's editor, only from workflowRepository reads and the
// execute route.
package workflow

import "encoding/json"

// NodeKind ports NodeKind (workflow.interface.ts:16). Values are the exact
// wire strings stored in WorkflowNode.Kind and referenced by name from the
// frontend, which stays unchanged.
type NodeKind string

const (
	NodeKindInput     NodeKind = "input"
	NodeKindLLM       NodeKind = "llm"
	NodeKindCondition NodeKind = "condition"
	NodeKindNote      NodeKind = "note"
	NodeKindTool      NodeKind = "tool"
	NodeKindHttp      NodeKind = "http"
	NodeKindTemplate  NodeKind = "template"
	NodeKindCode      NodeKind = "code"
	NodeKindOutput    NodeKind = "output"
)

// OutputSchemaSourceKey ports OutputSchemaSourceKey (workflow.interface.ts:52).
type OutputSchemaSourceKey struct {
	NodeID string   `json:"nodeId"`
	Path   []string `json:"path"`
}

// ChatModelRef ports the ChatModel shape (types/chat.ts:15) as embedded in
// LLM/Tool node config.
type ChatModelRef struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
}

// WorkflowToolKey ports WorkflowToolKey (workflow.interface.ts:74): a
// discriminated union (MCPTool | DefaultTool) flattened into one struct
// since Go has no native union types -- Type selects which of
// ServerID/ServerName are meaningful.
type WorkflowToolKey struct {
	ID              string          `json:"id"`
	Description     string          `json:"description"`
	ParameterSchema json.RawMessage `json:"parameterSchema,omitempty"`
	ReturnSchema    json.RawMessage `json:"returnSchema,omitempty"`
	Type            string          `json:"type"` // "mcp-tool" | "app-tool"
	ServerID        string          `json:"serverId,omitempty"`
	ServerName      string          `json:"serverName,omitempty"`
}

// HttpValue ports HttpValue (workflow.interface.ts:155): a union of a
// literal string or an OutputSchemaSourceKey reference. Exactly one of
// Literal/Source is set after Unmarshal.
type HttpValue struct {
	Literal *string
	Source  *OutputSchemaSourceKey
}

func (v HttpValue) MarshalJSON() ([]byte, error) {
	if v.Literal != nil {
		return json.Marshal(*v.Literal)
	}
	if v.Source != nil {
		return json.Marshal(v.Source)
	}
	return json.Marshal(nil)
}

func (v *HttpValue) UnmarshalJSON(data []byte) error {
	if string(data) == "null" {
		return nil
	}
	var s string
	if err := json.Unmarshal(data, &s); err == nil {
		v.Literal = &s
		return nil
	}
	var src OutputSchemaSourceKey
	if err := json.Unmarshal(data, &src); err != nil {
		return err
	}
	v.Source = &src
	return nil
}

// InputNodeConfig ports InputNodeData's node_config (workflow.interface.ts:87).
type InputNodeConfig struct {
	OutputSchema json.RawMessage `json:"outputSchema"`
}

// OutputDataItem ports OutputNodeData.outputData's element type
// (workflow.interface.ts:99).
type OutputDataItem struct {
	Key    string                 `json:"key"`
	Source *OutputSchemaSourceKey `json:"source,omitempty"`
}

// OutputNodeConfig ports OutputNodeData's node_config (workflow.interface.ts:95).
type OutputNodeConfig struct {
	OutputData []OutputDataItem `json:"outputData"`
}

// LLMMessage ports LLMNodeData.messages' element type (workflow.interface.ts:131).
// Content is TipTapMentionJsonContent, decoded lazily by the tiptap helpers.
type LLMMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content,omitempty"`
}

// LLMNodeConfig ports LLMNodeData's node_config (workflow.interface.ts:127).
type LLMNodeConfig struct {
	Model        ChatModelRef    `json:"model"`
	Messages     []LLMMessage    `json:"messages"`
	OutputSchema json.RawMessage `json:"outputSchema"`
}

// ConditionNodeConfig ports ConditionNodeData's node_config (workflow.interface.ts:141).
type ConditionNodeConfig struct {
	Branches ConditionBranches `json:"branches"`
}

// ToolNodeConfig ports ToolNodeData's node_config (workflow.interface.ts:116).
type ToolNodeConfig struct {
	Tool    *WorkflowToolKey `json:"tool,omitempty"`
	Model   ChatModelRef     `json:"model"`
	Message json.RawMessage  `json:"message,omitempty"`
}

// HttpHeader/HttpQuery port HttpNodeData.headers/.query's element types
// (workflow.interface.ts:166,170).
type HttpHeader struct {
	Key   string     `json:"key"`
	Value *HttpValue `json:"value,omitempty"`
}

type HttpQuery struct {
	Key   string     `json:"key"`
	Value *HttpValue `json:"value,omitempty"`
}

// HttpNodeConfig ports HttpNodeData's node_config (workflow.interface.ts:161).
type HttpNodeConfig struct {
	URL     *HttpValue   `json:"url,omitempty"`
	Method  string       `json:"method"`
	Headers []HttpHeader `json:"headers"`
	Query   []HttpQuery  `json:"query"`
	Body    *HttpValue   `json:"body,omitempty"`
	Timeout *int         `json:"timeout,omitempty"`
}

// TemplateNodeConfig ports TemplateNodeData's node_config (workflow.interface.ts:182).
type TemplateNodeConfig struct {
	Template struct {
		Type   string          `json:"type"`
		TipTap json.RawMessage `json:"tiptap"`
	} `json:"template"`
}

// DefaultObjectJSONSchema ports defaultObjectJsonSchema (shared.workflow.ts:18).
var DefaultObjectJSONSchema = json.RawMessage(`{"type":"object","properties":{}}`)
