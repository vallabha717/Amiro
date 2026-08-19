package pty

import (
	"fmt"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"
)

// Cell is one character position on screen.
type Cell struct {
	Rune  rune
	Style Style
}

// Style captures SGR attributes.
type Style struct {
	FgColor   string
	BgColor   string
	Bold      bool
	Faint     bool
	Italic    bool
	Underline bool
	Inverse   bool
}

// Buffer is a virtual ANSI terminal screen.
type Buffer struct {
	mu     sync.RWMutex
	width  int
	height int

	cursorX int
	cursorY int

	scrollTop int
	scrollBot int

	currentStyle Style
	altScreen    bool

	primaryGrid [][]Cell
	altGrid     [][]Cell

	cursorVisible bool
	lastChangeSeq int64
	pending       []byte
}

// NewBuffer creates a virtual screen buffer of width x height.
func NewBuffer(width, height int) *Buffer {
	if width <= 0 {
		width = 80
	}
	if height <= 0 {
		height = 24
	}
	b := &Buffer{
		width:         width,
		height:        height,
		scrollBot:     height - 1,
		cursorVisible: true,
		primaryGrid:   makeGrid(width, height),
		altGrid:       makeGrid(width, height),
	}
	return b
}

func makeGrid(w, h int) [][]Cell {
	g := make([][]Cell, h)
	for y := 0; y < h; y++ {
		g[y] = make([]Cell, w)
		for x := 0; x < w; x++ {
			g[y][x] = Cell{Rune: ' '}
		}
	}
	return g
}

func (b *Buffer) activeGrid() [][]Cell {
	if b.altScreen {
		return b.altGrid
	}
	return b.primaryGrid
}

// Resize changes the terminal dimensions, reflowing or clipping content.
func (b *Buffer) Resize(width, height int) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if width <= 0 {
		width = 80
	}
	if height <= 0 {
		height = 24
	}
	b.width = width
	b.height = height
	b.scrollTop = 0
	b.scrollBot = height - 1

	b.primaryGrid = resizeGrid(b.primaryGrid, width, height)
	b.altGrid = resizeGrid(b.altGrid, width, height)

	if b.cursorX >= width {
		b.cursorX = width - 1
	}
	if b.cursorY >= height {
		b.cursorY = height - 1
	}
	b.lastChangeSeq++
}

func resizeGrid(old [][]Cell, w, h int) [][]Cell {
	newGrid := makeGrid(w, h)
	copyH := len(old)
	if copyH > h {
		copyH = h
	}
	for y := 0; y < copyH; y++ {
		copyW := len(old[y])
		if copyW > w {
			copyW = w
		}
		copy(newGrid[y][:copyW], old[y][:copyW])
	}
	return newGrid
}

// ChangeSeq returns the current change sequence counter, incremented on every write.
func (b *Buffer) ChangeSeq() int64 {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.lastChangeSeq
}

// Write applies raw terminal output to the virtual screen.
func (b *Buffer) Write(p []byte) (n int, err error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	data := p
	if len(b.pending) > 0 {
		data = append(b.pending, p...)
		b.pending = nil
	}

	i := 0
	length := len(data)

	for i < length {
		if !utf8.FullRune(data[i:]) && length-i < 4 {
			b.pending = append([]byte(nil), data[i:]...)
			break
		}

		r, size := utf8.DecodeRune(data[i:])
		if r == utf8.RuneError && size == 1 {
			i += size
			continue
		}

		if r == '\x1b' {
			// Escape sequence
			consumed := b.parseEscape(string(data[i:]))
			if consumed == 0 {
				// Incomplete escape sequence at the end of chunk
				b.pending = append([]byte(nil), data[i:]...)
				break
			}
			i += consumed
			b.lastChangeSeq++
			continue
		}

		switch r {
		case '\r':
			b.cursorX = 0
		case '\n':
			b.lineFeed()
		case '\b':
			if b.cursorX > 0 {
				b.cursorX--
			}
		case '\t':
			nextTab := (b.cursorX/8 + 1) * 8
			if nextTab >= b.width {
				nextTab = b.width - 1
			}
			for b.cursorX < nextTab {
				b.setCell(b.cursorX, b.cursorY, ' ', b.currentStyle)
				b.cursorX++
			}
		case '\a', '\x00':
			// Bell or NUL, ignore
		default:
			if r >= 32 {
				rw := runeWidth(r)
				b.setCell(b.cursorX, b.cursorY, r, b.currentStyle)
				if rw == 2 && b.cursorX+1 < b.width {
					b.setCell(b.cursorX+1, b.cursorY, 0, b.currentStyle)
				}
				b.cursorX += rw
				if b.cursorX >= b.width {
					b.cursorX = 0
					b.lineFeed()
				}
			}
		}
		b.lastChangeSeq++
		i += size
	}

	return len(p), nil
}

func runeWidth(r rune) int {
	if r == 0 {
		return 0
	}
	if (r >= 0x1100 && r <= 0x115F) || // Hangul Jamo
		(r >= 0x2E80 && r <= 0xA4CF && r != 0x303F) || // CJK Radicals, Kangxi, CJK
		(r >= 0xAC00 && r <= 0xD7A3) || // Hangul Syllables
		(r >= 0xF900 && r <= 0xFAFF) || // CJK Compatibility Ideographs
		(r >= 0xFE10 && r <= 0xFE19) || // Vertical forms
		(r >= 0xFE30 && r <= 0xFE6F) || // CJK Compatibility Forms
		(r >= 0xFF00 && r <= 0xFF60) || // Fullwidth Forms
		(r >= 0xFFE0 && r <= 0xFFE6) ||
		(r >= 0x1F300 && r <= 0x1F64F) || // Miscellaneous Symbols and Pictographs
		(r >= 0x1F680 && r <= 0x1F6FF) || // Transport and Map
		(r >= 0x20000 && r <= 0x3FFFD) {
		return 2
	}
	return 1
}

func (b *Buffer) setCell(x, y int, r rune, style Style) {
	if y < 0 || y >= b.height || x < 0 || x >= b.width {
		return
	}
	grid := b.activeGrid()
	grid[y][x] = Cell{Rune: r, Style: style}
}

func (b *Buffer) lineFeed() {
	if b.cursorY == b.scrollBot {
		b.scrollUp(1)
	} else if b.cursorY < b.height-1 {
		b.cursorY++
	}
}

func (b *Buffer) scrollUp(lines int) {
	if lines <= 0 {
		return
	}
	grid := b.activeGrid()
	top := b.scrollTop
	bot := b.scrollBot
	if top < 0 {
		top = 0
	}
	if bot >= b.height {
		bot = b.height - 1
	}

	for y := top; y <= bot-lines; y++ {
		copy(grid[y], grid[y+lines])
	}
	for y := bot - lines + 1; y <= bot; y++ {
		if y >= 0 && y < b.height {
			for x := 0; x < b.width; x++ {
				grid[y][x] = Cell{Rune: ' '}
			}
		}
	}
}

func (b *Buffer) parseEscape(s string) int {
	if len(s) < 2 {
		return 0 // Incomplete escape
	}

	if s[1] == '[' {
		// CSI sequence
		return b.parseCSI(s)
	}
	if s[1] == ']' {
		// OSC sequence: \x1b]...\x07 or \x1b]...\x1b\\
		for i := 2; i < len(s); i++ {
			if s[i] == '\a' {
				return i + 1
			}
			if s[i] == '\x1b' && i+1 < len(s) && s[i+1] == '\\' {
				return i + 2
			}
		}
		return 0 // Incomplete OSC sequence
	}
	if s[1] == 'M' {
		// Reverse index (scroll down / cursor up)
		if b.cursorY == b.scrollTop {
			b.scrollDown(1)
		} else if b.cursorY > 0 {
			b.cursorY--
		}
		return 2
	}
	if s[1] == 'c' {
		// Reset terminal
		b.reset()
		return 2
	}

	return 2
}

func (b *Buffer) scrollDown(lines int) {
	if lines <= 0 {
		return
	}
	grid := b.activeGrid()
	top := b.scrollTop
	bot := b.scrollBot
	for y := bot; y >= top+lines; y-- {
		copy(grid[y], grid[y-lines])
	}
	for y := top; y < top+lines && y <= bot; y++ {
		for x := 0; x < b.width; x++ {
			grid[y][x] = Cell{Rune: ' '}
		}
	}
}

func (b *Buffer) reset() {
	b.cursorX = 0
	b.cursorY = 0
	b.scrollTop = 0
	b.scrollBot = b.height - 1
	b.currentStyle = Style{}
	b.altScreen = false
	b.primaryGrid = makeGrid(b.width, b.height)
	b.altGrid = makeGrid(b.width, b.height)
}

func (b *Buffer) parseCSI(s string) int {
	// Look for terminating character [0x40-0x7E]
	i := 2
	for i < len(s) && (s[i] < 0x40 || s[i] > 0x7E) {
		i++
	}
	if i >= len(s) {
		return 0 // Incomplete sequence
	}


	final := s[i]
	content := s[2:i]
	consumed := i + 1

	isPrivate := strings.HasPrefix(content, "?")
	if isPrivate {
		content = content[1:]
	}

	params := parseParams(content)

	switch final {
	case 'H', 'f': // Cursor Position
		row := 1
		col := 1
		if len(params) > 0 && params[0] > 0 {
			row = params[0]
		}
		if len(params) > 1 && params[1] > 0 {
			col = params[1]
		}
		b.cursorY = clamp(row-1, 0, b.height-1)
		b.cursorX = clamp(col-1, 0, b.width-1)

	case 'A': // Cursor Up
		n := paramOrDefault(params, 0, 1)
		b.cursorY = clamp(b.cursorY-n, 0, b.height-1)

	case 'B': // Cursor Down
		n := paramOrDefault(params, 0, 1)
		b.cursorY = clamp(b.cursorY+n, 0, b.height-1)

	case 'C': // Cursor Forward
		n := paramOrDefault(params, 0, 1)
		b.cursorX = clamp(b.cursorX+n, 0, b.width-1)

	case 'D': // Cursor Back
		n := paramOrDefault(params, 0, 1)
		b.cursorX = clamp(b.cursorX-n, 0, b.width-1)

	case 'G': // Cursor Horizontal Absolute
		col := paramOrDefault(params, 0, 1)
		b.cursorX = clamp(col-1, 0, b.width-1)

	case 'd': // Line Position Absolute
		row := paramOrDefault(params, 0, 1)
		b.cursorY = clamp(row-1, 0, b.height-1)

	case 'J': // Erase in Display
		mode := paramOrDefault(params, 0, 0)
		grid := b.activeGrid()
		switch mode {
		case 0: // Cursor to end
			for x := b.cursorX; x < b.width; x++ {
				grid[b.cursorY][x] = Cell{Rune: ' '}
			}
			for y := b.cursorY + 1; y < b.height; y++ {
				for x := 0; x < b.width; x++ {
					grid[y][x] = Cell{Rune: ' '}
				}
			}
		case 1: // Start to cursor
			for y := 0; y < b.cursorY; y++ {
				for x := 0; x < b.width; x++ {
					grid[y][x] = Cell{Rune: ' '}
				}
			}
			for x := 0; x <= b.cursorX && x < b.width; x++ {
				grid[b.cursorY][x] = Cell{Rune: ' '}
			}
		case 2, 3: // Clear all
			for y := 0; y < b.height; y++ {
				for x := 0; x < b.width; x++ {
					grid[y][x] = Cell{Rune: ' '}
				}
			}
		}

	case 'K': // Erase in Line
		mode := paramOrDefault(params, 0, 0)
		grid := b.activeGrid()
		y := b.cursorY
		if y >= 0 && y < b.height {
			switch mode {
			case 0: // Cursor to end of line
				for x := b.cursorX; x < b.width; x++ {
					grid[y][x] = Cell{Rune: ' '}
				}
			case 1: // Start to cursor
				for x := 0; x <= b.cursorX && x < b.width; x++ {
					grid[y][x] = Cell{Rune: ' '}
				}
			case 2: // Entire line
				for x := 0; x < b.width; x++ {
					grid[y][x] = Cell{Rune: ' '}
				}
			}
		}

	case 'L': // Insert Line
		n := paramOrDefault(params, 0, 1)
		b.scrollDown(n)

	case 'M': // Delete Line
		n := paramOrDefault(params, 0, 1)
		b.scrollUp(n)

	case 'P': // Delete Character
		n := paramOrDefault(params, 0, 1)
		grid := b.activeGrid()
		y := b.cursorY
		if y >= 0 && y < b.height {
			for x := b.cursorX; x < b.width-n; x++ {
				grid[y][x] = grid[y][x+n]
			}
			for x := b.width - n; x < b.width; x++ {
				if x >= 0 {
					grid[y][x] = Cell{Rune: ' '}
				}
			}
		}

	case 'r': // Set Scrolling Region
		top := 1
		bot := b.height
		if len(params) > 0 && params[0] > 0 {
			top = params[0]
		}
		if len(params) > 1 && params[1] > 0 {
			bot = params[1]
		}
		b.scrollTop = clamp(top-1, 0, b.height-1)
		b.scrollBot = clamp(bot-1, 0, b.height-1)
		b.cursorX = 0
		b.cursorY = 0

	case 'm': // SGR (Select Graphic Rendition)
		b.applySGR(params)

	case 'h': // Set Mode
		if isPrivate {
			for _, p := range params {
				switch p {
				case 25:
					b.cursorVisible = true
				case 1049, 47:
					b.altScreen = true
				}
			}
		}

	case 'l': // Reset Mode
		if isPrivate {
			for _, p := range params {
				switch p {
				case 25:
					b.cursorVisible = false
				case 1049, 47:
					b.altScreen = false
				}
			}
		}
	}

	return consumed
}

func (b *Buffer) applySGR(params []int) {
	if len(params) == 0 {
		b.currentStyle = Style{}
		return
	}

	for i := 0; i < len(params); i++ {
		p := params[i]
		switch p {
		case 0:
			b.currentStyle = Style{}
		case 1:
			b.currentStyle.Bold = true
		case 2:
			b.currentStyle.Faint = true
		case 3:
			b.currentStyle.Italic = true
		case 4:
			b.currentStyle.Underline = true
		case 7:
			b.currentStyle.Inverse = true
		case 22:
			b.currentStyle.Bold = false
			b.currentStyle.Faint = false
		case 23:
			b.currentStyle.Italic = false
		case 24:
			b.currentStyle.Underline = false
		case 27:
			b.currentStyle.Inverse = false
		case 30, 31, 32, 33, 34, 35, 36, 37:
			b.currentStyle.FgColor = fmt.Sprintf("ansi:%d", p-30)
		case 39:
			b.currentStyle.FgColor = ""
		case 40, 41, 42, 43, 44, 45, 46, 47:
			b.currentStyle.BgColor = fmt.Sprintf("ansi:%d", p-40)
		case 49:
			b.currentStyle.BgColor = ""
		case 90, 91, 92, 93, 94, 95, 96, 97:
			b.currentStyle.FgColor = fmt.Sprintf("ansi-bright:%d", p-90)
		case 100, 101, 102, 103, 104, 105, 106, 107:
			b.currentStyle.BgColor = fmt.Sprintf("ansi-bright:%d", p-100)
		case 38: // Extended FG: 38;5;n or 38;2;r;g;b
			if i+2 < len(params) && params[i+1] == 5 {
				b.currentStyle.FgColor = fmt.Sprintf("color256:%d", params[i+2])
				i += 2
			} else if i+4 < len(params) && params[i+1] == 2 {
				b.currentStyle.FgColor = fmt.Sprintf("rgb(%d,%d,%d)", params[i+2], params[i+3], params[i+4])
				i += 4
			}
		case 48: // Extended BG: 48;5;n or 48;2;r;g;b
			if i+2 < len(params) && params[i+1] == 5 {
				b.currentStyle.BgColor = fmt.Sprintf("color256:%d", params[i+2])
				i += 2
			} else if i+4 < len(params) && params[i+1] == 2 {
				b.currentStyle.BgColor = fmt.Sprintf("rgb(%d,%d,%d)", params[i+2], params[i+3], params[i+4])
				i += 4
			}
		}
	}
}

func parseParams(s string) []int {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ";")
	var params []int
	for _, p := range parts {
		if p == "" {
			params = append(params, 0)
			continue
		}
		val, err := strconv.Atoi(p)
		if err != nil {
			params = append(params, 0)
		} else {
			params = append(params, val)
		}
	}
	return params
}

func paramOrDefault(params []int, idx, def int) int {
	if idx < len(params) && params[idx] > 0 {
		return params[idx]
	}
	return def
}

func clamp(v, min, max int) int {
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}

// Plain returns the plain text screen representation, trimming trailing blank lines and spaces.
func (b *Buffer) Plain() string {
	b.mu.RLock()
	defer b.mu.RUnlock()

	grid := b.activeGrid()
	lines := make([]string, b.height)
	for y := 0; y < b.height; y++ {
		var row strings.Builder
		for x := 0; x < b.width; x++ {
			r := grid[y][x].Rune
			if r == 0 {
				continue
			}
			row.WriteRune(r)
		}
		lines[y] = strings.TrimRight(row.String(), " ")
	}

	// Trim trailing blank lines for clean comparison
	lastNonEmpty := -1
	for y := len(lines) - 1; y >= 0; y-- {
		if lines[y] != "" {
			lastNonEmpty = y
			break
		}
	}
	if lastNonEmpty == -1 {
		return ""
	}
	return strings.Join(lines[:lastNonEmpty+1], "\n")
}

// String implements fmt.Stringer.
func (b *Buffer) String() string {
	return b.Plain()
}

// RawGrid returns full un-trimmed lines of the grid.
func (b *Buffer) RawGrid() []string {
	b.mu.RLock()
	defer b.mu.RUnlock()

	grid := b.activeGrid()
	lines := make([]string, b.height)
	for y := 0; y < b.height; y++ {
		var row strings.Builder
		for x := 0; x < b.width; x++ {
			r := grid[y][x].Rune
			if r == 0 {
				continue
			}
			row.WriteRune(r)
		}
		lines[y] = row.String()
	}
	return lines
}

// Line returns the plain text of a specific line (0-indexed).
func (b *Buffer) Line(y int) string {
	b.mu.RLock()
	defer b.mu.RUnlock()

	if y < 0 || y >= b.height {
		return ""
	}
	grid := b.activeGrid()
	var row strings.Builder
	for x := 0; x < b.width; x++ {
		r := grid[y][x].Rune
		if r == 0 {
			continue
		}
		row.WriteRune(r)
	}
	return strings.TrimRight(row.String(), " ")
}


// Contains reports whether s appears anywhere in the rendered plain text.
func (b *Buffer) Contains(s string) bool {
	return strings.Contains(b.Plain(), s)
}

// Cursor returns the cursor position (x, y) and visibility.
func (b *Buffer) Cursor() (x, y int, visible bool) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.cursorX, b.cursorY, b.cursorVisible
}
