package tinygo

import "testing"

func TestAdd(t *testing.T) {
	if Add(2, 3) != 5 {
		t.Fatal("Add is wrong")
	}
}

func TestSubtract(t *testing.T) {
	if Subtract(5, 3) != 2 {
		t.Fatalf("Subtract(5,3) = %d, want 2", Subtract(5, 3))
	}
}
