package db

import "testing"

func TestOpen_RejectsUnknownDriver(t *testing.T) {
	_, err := Open("mysql", "irrelevant")
	if err == nil {
		t.Fatal("expected an error for an unknown driver, got nil")
	}
}
