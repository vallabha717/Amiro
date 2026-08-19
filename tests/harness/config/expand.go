package config

import (
	"bufio"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

// Expander resolves ${VAR} and ${VAR:-fallback} in configuration strings.
//
// Values come from the process environment first and from tests/.env
// second, so a CI job that exports ANTHROPIC_API_KEY from a secret store
// wins over a stale .env sitting on a laptop.
//
// An unset ${VAR} with no fallback expands to the empty string and is
// treated as "not configured", NOT as an error. That is deliberate: a
// config.yaml listing six providers on a machine holding one key should do
// the obvious thing, which is run with one provider. validate.go reports
// which entries were dropped and why.
type Expander struct {
	vars map[string]string
	// Used records every variable actually referenced, so run.json can say
	// which environment the run depended on without recording the values.
	Used map[string]bool
	// Missing records referenced variables that resolved to nothing and had
	// no fallback -- the input to the "dropped an unconfigured provider"
	// note in the run summary.
	Missing map[string]bool
}

// NewExpander builds an expander from the process environment, overlaid
// with envFile if it exists. A missing envFile is not an error.
func NewExpander(envFile string) (*Expander, error) {
	e := &Expander{
		vars:    map[string]string{},
		Used:    map[string]bool{},
		Missing: map[string]bool{},
	}
	if envFile != "" {
		fileVars, err := readDotEnv(envFile)
		if err != nil {
			return nil, err
		}
		for k, v := range fileVars {
			e.vars[k] = v
		}
	}
	// The process environment is applied second so it wins.
	for _, kv := range os.Environ() {
		if k, v, ok := strings.Cut(kv, "="); ok {
			e.vars[k] = v
		}
	}
	return e, nil
}

// Expand rewrites every ${VAR} and ${VAR:-fallback} in s.
//
// Written by hand rather than with os.Expand because os.Expand has no
// notion of `:-` and would silently turn "${VAR:-x}" into "" -- the exact
// difference between "this provider has no key" and "this provider uses the
// default endpoint".
func (e *Expander) Expand(s string) string {
	if !strings.Contains(s, "${") {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); {
		if s[i] != '$' || i+1 >= len(s) || s[i+1] != '{' {
			b.WriteByte(s[i])
			i++
			continue
		}
		end := strings.IndexByte(s[i:], '}')
		if end < 0 {
			// An unterminated ${ is literal text, not a parse error. A
			// config file is not a shell script and should not fail to
			// load over a stray brace in a comment-like string.
			b.WriteString(s[i:])
			break
		}
		ref := s[i+2 : i+end]
		i += end + 1
		b.WriteString(e.resolve(ref))
	}
	return b.String()
}

func (e *Expander) resolve(ref string) string {
	name, fallback, hasFallback := strings.Cut(ref, ":-")
	name = strings.TrimSpace(name)
	if name == "" {
		return ""
	}
	e.Used[name] = true
	if v, ok := e.vars[name]; ok && v != "" {
		return v
	}
	if hasFallback {
		return fallback
	}
	e.Missing[name] = true
	return ""
}

// readDotEnv parses a KEY=VALUE file. Deliberately minimal: no `export`
// keyword handling beyond stripping it, no multi-line values, no command
// substitution. tests/.env exists to hold API keys out of config.yaml, and
// a fuller dotenv dialect would be a source of surprises rather than
// convenience.
func readDotEnv(path string) (map[string]string, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()

	vars := map[string]string{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		v = strings.TrimSpace(v)
		if len(v) >= 2 && (v[0] == '"' && v[len(v)-1] == '"' || v[0] == '\'' && v[len(v)-1] == '\'') {
			v = v[1 : len(v)-1]
		}
		vars[k] = v
	}
	return vars, sc.Err()
}

// ExpandNode rewrites every string scalar in a parsed YAML document.
//
// Done on the node tree rather than on the raw bytes so that ${...} inside
// a comment, or inside a key name, is left alone -- expansion is a property
// of values, and a config file whose comments changed meaning when a
// variable was exported would be a genuinely confusing thing to debug.
func (e *Expander) ExpandNode(node *yaml.Node) {
	if node == nil {
		return
	}
	if node.Kind == yaml.ScalarNode {
		// Only plain and quoted strings. Expanding inside an int or bool
		// scalar cannot produce anything valid, and pretending otherwise
		// would turn a typo into a type error one layer away from its cause.
		if node.Tag == "!!str" || node.Tag == "" {
			node.Value = e.Expand(node.Value)
		}
		return
	}
	start := 0
	if node.Kind == yaml.MappingNode {
		// Skip keys, expand values.
		for i := 1; i < len(node.Content); i += 2 {
			e.ExpandNode(node.Content[i])
		}
		return
	}
	for i := start; i < len(node.Content); i++ {
		e.ExpandNode(node.Content[i])
	}
}
