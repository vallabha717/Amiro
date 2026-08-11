package workflow

import "testing"

func sourceOf(vals map[string]interface{}) GetSourceValue {
	return func(key OutputSchemaSourceKey) interface{} {
		return vals[key.NodeID]
	}
}

func TestCheckConditionBranch_EqualsStringMatch(t *testing.T) {
	branch := ConditionBranch{
		LogicalOperator: "AND",
		Conditions: []ConditionRule{
			{Source: OutputSchemaSourceKey{NodeID: "n1"}, Operator: "equals", Value: "hello"},
		},
	}
	get := sourceOf(map[string]interface{}{"n1": "hello"})
	if !CheckConditionBranch(branch, get) {
		t.Fatal("expected equals match to be true")
	}
}

func TestCheckConditionBranch_EqualsNumberCoercion(t *testing.T) {
	branch := ConditionBranch{
		LogicalOperator: "AND",
		Conditions: []ConditionRule{
			{Source: OutputSchemaSourceKey{NodeID: "n1"}, Operator: "equals", Value: float64(5)},
		},
	}
	get := sourceOf(map[string]interface{}{"n1": float64(5)})
	if !CheckConditionBranch(branch, get) {
		t.Fatal("expected numeric equals to match after string coercion")
	}
}

func TestCheckConditionBranch_ANDRequiresAll(t *testing.T) {
	branch := ConditionBranch{
		LogicalOperator: "AND",
		Conditions: []ConditionRule{
			{Source: OutputSchemaSourceKey{NodeID: "a"}, Operator: "equals", Value: "x"},
			{Source: OutputSchemaSourceKey{NodeID: "b"}, Operator: "equals", Value: "y"},
		},
	}
	get := sourceOf(map[string]interface{}{"a": "x", "b": "not-y"})
	if CheckConditionBranch(branch, get) {
		t.Fatal("expected AND with one false condition to be false")
	}
}

func TestCheckConditionBranch_ORRequiresAny(t *testing.T) {
	branch := ConditionBranch{
		LogicalOperator: "OR",
		Conditions: []ConditionRule{
			{Source: OutputSchemaSourceKey{NodeID: "a"}, Operator: "equals", Value: "x"},
			{Source: OutputSchemaSourceKey{NodeID: "b"}, Operator: "equals", Value: "y"},
		},
	}
	get := sourceOf(map[string]interface{}{"a": "not-x", "b": "y"})
	if !CheckConditionBranch(branch, get) {
		t.Fatal("expected OR with one true condition to be true")
	}
}

func TestCheckConditionBranch_NoConditionsIsFalse(t *testing.T) {
	branch := ConditionBranch{LogicalOperator: "AND"}
	if CheckConditionBranch(branch, sourceOf(nil)) {
		t.Fatal("expected a branch with zero conditions to be false, matching TS's [false] fallback")
	}
}

func TestCheckConditionRule_NumericComparisons(t *testing.T) {
	cases := []struct {
		op       string
		source   interface{}
		target   string
		expected bool
	}{
		{"greater_than", float64(10), "5", true},
		{"greater_than", float64(3), "5", false},
		{"less_than", float64(3), "5", true},
		{"greater_than_or_equal", float64(5), "5", true},
		{"less_than_or_equal", float64(5), "5", true},
		{"greater_than", "not-a-number", "5", false}, // NaN comparisons are always false
	}
	for _, c := range cases {
		got := checkConditionRule(c.op, c.target, c.source)
		if got != c.expected {
			t.Errorf("%s(%v, %q) = %v, want %v", c.op, c.source, c.target, got, c.expected)
		}
	}
}

func TestCheckConditionRule_StringOperators(t *testing.T) {
	cases := []struct {
		op       string
		source   interface{}
		target   string
		expected bool
	}{
		{"contains", "hello world", "world", true},
		{"not_contains", "hello world", "xyz", true},
		{"starts_with", "hello world", "hello", true},
		{"ends_with", "hello world", "world", true},
		{"is_empty", "", "", true},
		{"is_empty", "not empty", "", false},
		{"is_not_empty", "not empty", "", true},
	}
	for _, c := range cases {
		got := checkConditionRule(c.op, c.target, c.source)
		if got != c.expected {
			t.Errorf("%s(%v, %q) = %v, want %v", c.op, c.source, c.target, got, c.expected)
		}
	}
}

func TestCheckConditionRule_BooleanOperators(t *testing.T) {
	if !checkConditionRule("is_true", "", true) {
		t.Error("is_true(true) should be true")
	}
	if checkConditionRule("is_true", "", false) {
		t.Error("is_true(false) should be false")
	}
	if !checkConditionRule("is_false", "", false) {
		t.Error("is_false(false) should be true")
	}
}

func TestCheckConditionRule_UnknownOperatorIsFalse(t *testing.T) {
	if checkConditionRule("bogus_operator", "x", "x") {
		t.Fatal("expected an unrecognized operator to fail closed")
	}
}
