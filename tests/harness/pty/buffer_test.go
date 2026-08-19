package pty

import (
	"strings"
	"testing"
)

func TestBuffer_BasicOutputAndLineBreaks(t *testing.T) {
	b := NewBuffer(40, 10)
	_, _ = b.Write([]byte("Hello, world!\r\nSecond line"))

	lines := b.RawGrid()
	if !strings.HasPrefix(lines[0], "Hello, world!") {
		t.Errorf("line 0 = %q, want prefix 'Hello, world!'", lines[0])
	}
	if !strings.HasPrefix(lines[1], "Second line") {
		t.Errorf("line 1 = %q, want prefix 'Second line'", lines[1])
	}

	plain := b.Plain()
	want := "Hello, world!\nSecond line"
	if plain != want {
		t.Errorf("Plain() = %q, want %q", plain, want)
	}
}

func TestBuffer_CursorPositioningAndErase(t *testing.T) {
	b := NewBuffer(40, 10)
	// Write header, move cursor, overwrite, clear line
	_, _ = b.Write([]byte("Header Line\r\n\x1b[2;5HInserted\x1b[K\r\nLine 3"))

	if !b.Contains("Inserted") {
		t.Errorf("expected buffer to contain 'Inserted', got:\n%s", b.Plain())
	}
	if !b.Contains("Line 3") {
		t.Errorf("expected buffer to contain 'Line 3', got:\n%s", b.Plain())
	}
}

func TestBuffer_LipglossTruecolorAndStyling(t *testing.T) {
	b := NewBuffer(80, 24)
	// Real LipGloss style output sequence with truecolor RGB and 256 colors
	// \x1b[38;2;255;128;0mOrange Text\x1b[0m \x1b[1;4mBold Underline\x1b[0m \x1b[48;5;236mDark BG\x1b[0m
	stream := "\x1b[38;2;255;128;0mOrange Text\x1b[0m \x1b[1;4mBold Underline\x1b[0m \x1b[48;5;236mDark BG\x1b[0m\r\n"
	_, _ = b.Write([]byte(stream))

	plain := b.Plain()
	want := "Orange Text Bold Underline Dark BG"
	if plain != want {
		t.Errorf("Plain() = %q, want %q", plain, want)
	}
}

func TestBuffer_AltScreenAndClear(t *testing.T) {
	b := NewBuffer(80, 24)
	// Write on primary screen
	_, _ = b.Write([]byte("Primary screen content\r\n"))

	// Switch to alt screen (BubbleTea startup)
	_, _ = b.Write([]byte("\x1b[?1049h\x1b[2J\x1b[H"))
	_, _ = b.Write([]byte("Alt screen UI\r\n[1] Option 1"))

	if !b.Contains("Alt screen UI") {
		t.Errorf("alt screen should have 'Alt screen UI', got:\n%s", b.Plain())
	}
	if b.Contains("Primary screen content") {
		t.Errorf("alt screen must not contain primary screen text")
	}

	// Exit alt screen
	_, _ = b.Write([]byte("\x1b[?1049l"))
	if !b.Contains("Primary screen content") {
		t.Errorf("restored primary screen should have 'Primary screen content', got:\n%s", b.Plain())
	}
}

func TestBuffer_RealCapturedBubbleTeaFrame(t *testing.T) {
	b := NewBuffer(80, 24)
	// Real captured Bubble Tea header/body sequence with box borders, status bar, and ANSI escapes
	capturedStream := "\x1b[?25l\x1b[?1049h\x1b[2J\x1b[H" +
		"\x1b[38;2;120;120;120m┌────────────────────────────────────────┐\x1b[0m\r\n" +
		"\x1b[38;2;120;120;120m│\x1b[0m \x1b[1;38;2;255;255;255mAmiro TUI\x1b[0m \x1b[38;2;0;200;100m● interactive\x1b[0m            \x1b[38;2;120;120;120m│\x1b[0m\r\n" +
		"\x1b[38;2;120;120;120m└────────────────────────────────────────┘\x1b[0m\r\n" +
		"\r\n" +
		"  \x1b[1mAssistant:\x1b[0m Hello! How can I help you today?\r\n" +
		"\r\n" +
		"\x1b[38;2;100;100;255m> Type a prompt...\x1b[0m\x1b[?25h"

	_, err := b.Write([]byte(capturedStream))
	if err != nil {
		t.Fatalf("writing captured stream: %v", err)
	}

	plain := b.Plain()
	if !strings.Contains(plain, "Amiro TUI") {
		t.Errorf("missing 'Amiro TUI' in flattened frame:\n%s", plain)
	}
	if !strings.Contains(plain, "● interactive") {
		t.Errorf("missing '● interactive' in flattened frame:\n%s", plain)
	}
	if !strings.Contains(plain, "Hello! How can I help you today?") {
		t.Errorf("missing assistant greeting in flattened frame:\n%s", plain)
	}
	if !strings.Contains(plain, "> Type a prompt...") {
		t.Errorf("missing prompt placeholder in flattened frame:\n%s", plain)
	}
}
