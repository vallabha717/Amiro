package config

import (
	"fmt"
	"reflect"
	"strings"

	"gopkg.in/yaml.v3"
)

// applyYAML overlays one document onto an already-populated Config.
//
// yaml.v3's decoder gives us the merge semantics docs/testing/02-config.md
// specifies for free, which is why there is no hand-written deep-merge here:
// decoding into a non-zero value touches only the keys the document
// actually contains, adds to existing maps, and REPLACES slices wholesale.
// That last one is the behaviour we want and the one most likely to be
// mistaken for a bug later, so it is stated here rather than discovered.
func applyYAML(cfg *Config, data []byte) error {
	return yaml.Unmarshal(data, cfg)
}

// UnknownKeys walks a parsed YAML document against Config's shape and
// reports every key that does not exist, with the line it is on and the
// nearest valid key at that level.
//
// This is a separate pass rather than yaml.Decoder.KnownFields(true)
// because KnownFields stops at the first offending key. A config file with
// three typos should report three typos; making the user re-run four times
// to find them all is exactly the experience validate.go exists to avoid.
func UnknownKeys(doc *yaml.Node, file string) []Problem {
	if doc == nil {
		return nil
	}
	root := doc
	if root.Kind == yaml.DocumentNode {
		if len(root.Content) == 0 {
			return nil
		}
		root = root.Content[0]
	}
	var problems []Problem
	walkKeys(root, reflect.TypeOf(Config{}), "", file, &problems)
	return problems
}

func walkKeys(node *yaml.Node, typ reflect.Type, prefix, file string, problems *[]Problem) {
	if node == nil {
		return
	}
	switch node.Kind {
	case yaml.MappingNode:
		if typ.Kind() == reflect.Map {
			// map[string]string (backend.env) -- any key is valid by
			// design; it is passed through to the spawned process.
			return
		}
		if typ.Kind() != reflect.Struct {
			return
		}
		known := fieldNames(typ)
		for i := 0; i+1 < len(node.Content); i += 2 {
			keyNode, valNode := node.Content[i], node.Content[i+1]
			name := keyNode.Value
			field, ok := fieldByYAMLName(typ, name)
			if !ok {
				*problems = append(*problems, Problem{
					File:       file,
					Line:       keyNode.Line,
					Key:        joinPath(prefix, name),
					Message:    fmt.Sprintf("unknown key %q", joinPath(prefix, name)),
					Suggestion: suggest(name, known),
				})
				continue
			}
			walkKeys(valNode, field.Type, joinPath(prefix, name), file, problems)
		}
	case yaml.SequenceNode:
		if typ.Kind() != reflect.Slice {
			return
		}
		for idx, item := range node.Content {
			walkKeys(item, typ.Elem(), fmt.Sprintf("%s[%d]", prefix, idx), file, problems)
		}
	}
}

func joinPath(prefix, name string) string {
	if prefix == "" {
		return name
	}
	return prefix + "." + name
}

func fieldByYAMLName(typ reflect.Type, name string) (reflect.StructField, bool) {
	for i := 0; i < typ.NumField(); i++ {
		f := typ.Field(i)
		if yamlName(f) == name {
			return f, true
		}
	}
	return reflect.StructField{}, false
}

func yamlName(f reflect.StructField) string {
	tag := f.Tag.Get("yaml")
	if tag == "" {
		return strings.ToLower(f.Name)
	}
	name, _, _ := strings.Cut(tag, ",")
	if name == "" {
		return strings.ToLower(f.Name)
	}
	return name
}

func fieldNames(typ reflect.Type) []string {
	names := make([]string, 0, typ.NumField())
	for i := 0; i < typ.NumField(); i++ {
		names = append(names, yamlName(typ.Field(i)))
	}
	return names
}

// suggest returns the nearest candidate to got, or "" when nothing is close
// enough to be worth guessing. The threshold scales with the word length so
// that "prallel" suggests "parallel" but "mode" does not suggest "models".
func suggest(got string, candidates []string) string {
	best, bestDist := "", 1<<30
	limit := len(got)/3 + 1
	for _, c := range candidates {
		if strings.EqualFold(c, got) {
			return c
		}
		d := levenshtein(strings.ToLower(got), strings.ToLower(c))
		if d < bestDist {
			best, bestDist = c, d
		}
	}
	if bestDist > limit {
		return ""
	}
	return best
}

func levenshtein(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	prev := make([]int, len(rb)+1)
	cur := make([]int, len(rb)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(ra); i++ {
		cur[0] = i
		for j := 1; j <= len(rb); j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev, cur = cur, prev
	}
	return prev[len(rb)]
}
