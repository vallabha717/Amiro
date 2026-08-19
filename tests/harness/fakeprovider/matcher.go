package fakeprovider

import (
	"regexp"
	"strings"
)

// Matcher evaluates whether an incoming LLM prompt or message list matches a rule.
type Matcher interface {
	Match(prompt string, messages []Message) bool
	Description() string
}

// Message is a parsed message from an inbound OpenAI or Anthropic request.
type Message struct {
	Role       string `json:"role"`
	Content    string `json:"content"`
	ToolCallID string `json:"tool_call_id,omitempty"`
}

type exactMatcher struct {
	text string
}

func (m exactMatcher) Match(prompt string, _ []Message) bool {
	return prompt == m.text
}

func (m exactMatcher) Description() string {
	return "exact: " + m.text
}

// Exact matches prompt text exactly.
func Exact(text string) Matcher {
	return exactMatcher{text: text}
}

type containsMatcher struct {
	substr string
}

func (m containsMatcher) Match(prompt string, _ []Message) bool {
	return strings.Contains(prompt, m.substr)
}

func (m containsMatcher) Description() string {
	return "contains: " + m.substr
}

// Contains matches if the prompt contains substr.
func Contains(substr string) Matcher {
	return containsMatcher{substr: substr}
}

type regexMatcher struct {
	re *regexp.Regexp
}

func (m regexMatcher) Match(prompt string, _ []Message) bool {
	return m.re.MatchString(prompt)
}

func (m regexMatcher) Description() string {
	return "regex: " + m.re.String()
}

// Regex matches if the prompt matches re pattern.
func Regex(pattern string) Matcher {
	re := regexp.MustCompile(pattern)
	return regexMatcher{re: re}
}

type anyMatcher struct{}

func (anyMatcher) Match(_ string, _ []Message) bool {
	return true
}

func (anyMatcher) Description() string {
	return "any"
}

// Any matches any prompt.
func Any() Matcher {
	return anyMatcher{}
}
