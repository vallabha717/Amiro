package workflow

import (
	"fmt"
	"strconv"
	"strings"
)

// ConditionRule ports ConditionRule (condition.ts:71). Value is decoded as
// interface{} since the wire value can be a string, number, or boolean.
type ConditionRule struct {
	Source   OutputSchemaSourceKey `json:"source"`
	Operator string                `json:"operator"`
	Value    interface{}           `json:"value,omitempty"`
}

// ConditionBranch ports ConditionBranch (condition.ts:81).
type ConditionBranch struct {
	ID              string          `json:"id"`
	Type            string          `json:"type"` // "if" | "elseIf" | "else"
	Conditions      []ConditionRule `json:"conditions"`
	LogicalOperator string          `json:"logicalOperator"` // "AND" | "OR"
}

// ConditionBranches ports ConditionBranches (condition.ts:92).
type ConditionBranches struct {
	If     ConditionBranch   `json:"if"`
	ElseIf []ConditionBranch `json:"elseIf,omitempty"`
	Else   ConditionBranch   `json:"else"`
}

// GetSourceValue resolves one condition rule's source into a comparable
// value, matching the getSourceValue callback checkConditionBranch expects.
type GetSourceValue func(source OutputSchemaSourceKey) interface{}

// CheckConditionBranch ports checkConditionBranch (condition.ts:105).
func CheckConditionBranch(branch ConditionBranch, getSourceValue GetSourceValue) bool {
	if len(branch.Conditions) == 0 {
		return false
	}
	results := make([]bool, 0, len(branch.Conditions))
	for _, condition := range branch.Conditions {
		target := ""
		if condition.Value != nil {
			target = toDisplayString(condition.Value)
		}
		results = append(results, checkConditionRule(condition.Operator, target, getSourceValue(condition.Source)))
	}
	if branch.LogicalOperator == "AND" {
		for _, r := range results {
			if !r {
				return false
			}
		}
		return true
	}
	for _, r := range results {
		if r {
			return true
		}
	}
	return false
}

// checkConditionRule ports checkConditionRule (condition.ts:133). source may
// be nil (JS undefined), a string, a float64/int, or a bool -- whatever
// getSourceValue produced from a node's stored output.
func checkConditionRule(operator, target string, source interface{}) bool {
	sourceStr := toDisplayString(source)
	switch operator {
	case "equals":
		return sourceStr == target
	case "not_equals":
		return sourceStr != target
	case "contains":
		return strings.Contains(sourceStr, target)
	case "not_contains":
		return !strings.Contains(sourceStr, target)
	case "starts_with":
		return strings.HasPrefix(sourceStr, target)
	case "ends_with":
		return strings.HasSuffix(sourceStr, target)
	case "is_empty":
		return !isTruthy(source)
	case "is_not_empty":
		return isTruthy(source)
	case "greater_than":
		return toFloat(source) > toFloat(target)
	case "less_than":
		return toFloat(source) < toFloat(target)
	case "greater_than_or_equal":
		return toFloat(source) >= toFloat(target)
	case "less_than_or_equal":
		return toFloat(source) <= toFloat(target)
	case "is_true":
		return isTruthy(source)
	case "is_false":
		return !isTruthy(source)
	default:
		return false
	}
}

// toDisplayString mirrors JS's implicit String(x) coercion closely enough
// for equality/contains comparisons: numbers print without trailing zeros,
// booleans as "true"/"false", nil as "".
func toDisplayString(v interface{}) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case bool:
		return strconv.FormatBool(t)
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case int:
		return strconv.Itoa(t)
	default:
		return fmt.Sprintf("%v", t)
	}
}

// toFloat mirrors JS's Number(x) coercion for the numeric comparison
// operators: a non-numeric value becomes NaN, which every comparison
// against it evaluates false -- matching checkConditionRule's ts-safe
// .ifFail(() => false) catch-all for a throwing/NaN comparison.
func toFloat(v interface{}) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case int:
		return float64(t)
	case string:
		f, err := strconv.ParseFloat(t, 64)
		if err != nil {
			return nan()
		}
		return f
	case bool:
		if t {
			return 1
		}
		return 0
	default:
		return nan()
	}
}

func nan() float64 {
	var zero float64
	return zero / zero
}

// isTruthy mirrors JS truthiness for the values a node output/condition
// value can actually hold (string, float64, bool, nil) -- used by
// is_empty/is_not_empty/is_true/is_false.
func isTruthy(v interface{}) bool {
	switch t := v.(type) {
	case nil:
		return false
	case string:
		return t != ""
	case bool:
		return t
	case float64:
		return t != 0
	case int:
		return t != 0
	default:
		return true
	}
}
