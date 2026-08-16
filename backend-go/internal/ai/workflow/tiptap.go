package workflow

import (
	"encoding/json"
	"strings"

	bifrostai "amiro/backend/internal/ai/bifrost"
)

// GetOutputFunc resolves a mention/reference into whatever value a prior
// node produced, matching WorkflowRuntimeState.getOutput's role in
// shared.workflow.ts's tiptap converters.
type GetOutputFunc func(key OutputSchemaSourceKey) interface{}

type mentionParserFunc func(attrs map[string]interface{}) string

// ConvertTiptapJSONToText ports convertTiptapJsonToText (shared.workflow.ts:200)
// with its default mention parser: a mention resolves to its raw output
// (JSON-stringified if an object, else its string form).
func ConvertTiptapJSONToText(raw json.RawMessage, getOutput GetOutputFunc) string {
	return convertTiptap(raw, getOutput, defaultMentionParser(getOutput))
}

// ConvertTiptapJSONToMessage ports convertTiptapJsonToAiMessage
// (shared.workflow.ts:282): its mention parser fences object values in a
// json code block instead of JSON-stringifying them inline.
func ConvertTiptapJSONToMessage(role string, raw json.RawMessage, getOutput GetOutputFunc) bifrostai.Message {
	text := convertTiptap(raw, getOutput, messageMentionParser(getOutput))
	bRole := bifrostai.RoleUser
	switch role {
	case "assistant":
		bRole = bifrostai.RoleAssistant
	case "system":
		bRole = bifrostai.RoleSystem
	}
	return bifrostai.Message{Role: bRole, Text: text}
}

func convertTiptap(raw json.RawMessage, getOutput GetOutputFunc, parser mentionParserFunc) string {
	if len(raw) == 0 {
		return ""
	}
	var doc struct {
		Content []interface{} `json:"content"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return ""
	}
	return processTiptapContent(doc.Content, parser)
}

func asContentList(v interface{}) []interface{} {
	if v == nil {
		return nil
	}
	list, ok := v.([]interface{})
	if !ok {
		return nil
	}
	return list
}

// processTiptapContent ports the recursive processContent closure inside
// convertTiptapJsonToText (shared.workflow.ts:223). It trims at every
// recursion level, not just the outermost call, matching the TS join+trim
// happening inside the same recursive function.
func processTiptapContent(content []interface{}, parser mentionParserFunc) string {
	parts := make([]string, 0, len(content))
	for _, raw := range content {
		item, ok := raw.(map[string]interface{})
		if !ok || item == nil {
			parts = append(parts, "")
			continue
		}
		itemType, _ := item["type"].(string)
		switch itemType {
		case "paragraph":
			sub := asContentList(item["content"])
			if sub == nil {
				parts = append(parts, "")
				continue
			}
			parts = append(parts, processTiptapContent(sub, parser))
		case "text":
			text, _ := item["text"].(string)
			parts = append(parts, text)
		case "mention":
			attrs, _ := item["attrs"].(map[string]interface{})
			parts = append(parts, parser(attrs))
		case "hardBreak":
			parts = append(parts, "\n\n")
		case "bulletList":
			sub := asContentList(item["content"])
			if sub == nil {
				parts = append(parts, "")
				continue
			}
			lines := make([]string, 0, len(sub))
			for _, liRaw := range sub {
				liMap, _ := liRaw.(map[string]interface{})
				liContent := asContentList(liMap["content"])
				itemText := processTiptapContent(liContent, parser)
				lines = append(lines, "• "+strings.TrimSpace(itemText))
			}
			parts = append(parts, strings.Join(lines, "\n")+"\n")
		case "listItem":
			sub := asContentList(item["content"])
			if sub == nil {
				parts = append(parts, "")
				continue
			}
			parts = append(parts, processTiptapContent(sub, parser))
		default:
			if sub := asContentList(item["content"]); sub != nil {
				parts = append(parts, processTiptapContent(sub, parser))
			} else {
				parts = append(parts, "")
			}
		}
	}
	return strings.TrimSpace(strings.Join(parts, ""))
}

// mentionSourceKey parses a mention's attrs.label field, which stores the
// referenced OutputSchemaSourceKey as a JSON string (mention.attrs.label in
// the TipTap editor's own encoding).
func mentionSourceKey(attrs map[string]interface{}) (OutputSchemaSourceKey, bool) {
	label, _ := attrs["label"].(string)
	if label == "" {
		return OutputSchemaSourceKey{}, false
	}
	var key OutputSchemaSourceKey
	if err := json.Unmarshal([]byte(label), &key); err != nil {
		return OutputSchemaSourceKey{}, false
	}
	return key, true
}

func defaultMentionParser(getOutput GetOutputFunc) mentionParserFunc {
	return func(attrs map[string]interface{}) string {
		key, ok := mentionSourceKey(attrs)
		if !ok {
			return ""
		}
		value := getOutput(key)
		return stringifyMentionValue(value)
	}
}

func messageMentionParser(getOutput GetOutputFunc) mentionParserFunc {
	return func(attrs map[string]interface{}) string {
		key, ok := mentionSourceKey(attrs)
		if !ok {
			return ""
		}
		value := getOutput(key)
		if value == nil {
			return ""
		}
		if isObjectLike(value) {
			b, _ := json.MarshalIndent(value, "", "  ")
			return "\n```json\n" + string(b) + "\n```\n"
		}
		return toDisplayString(value)
	}
}

func stringifyMentionValue(value interface{}) string {
	if value == nil {
		return ""
	}
	if isObjectLike(value) {
		b, _ := json.Marshal(value)
		return string(b)
	}
	return toDisplayString(value)
}

func isObjectLike(v interface{}) bool {
	switch v.(type) {
	case map[string]interface{}, []interface{}:
		return true
	default:
		return false
	}
}
