package ingest

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseCsvPreview_SplitsHeaderAndRows(t *testing.T) {
	preview := ParseCsvPreview([]byte("a,b\n1,2\n3,4\n"), Options{})

	if !reflect.DeepEqual(preview.Header, []string{"a", "b"}) {
		t.Fatalf("header = %#v", preview.Header)
	}
	if !reflect.DeepEqual(preview.Rows, [][]string{{"1", "2"}, {"3", "4"}}) {
		t.Fatalf("rows = %#v", preview.Rows)
	}
	if preview.Columns != 2 {
		t.Fatalf("columns = %d, want 2", preview.Columns)
	}
	// totalRows counts the header row too (csv.ts:66 reads rows.length
	// before slicing the header off).
	if preview.TotalRows != 3 {
		t.Fatalf("totalRows = %d, want 3", preview.TotalRows)
	}
}

func TestParseCsvPreview_TrailingNewlineDoesNotProduceAPhantomRow(t *testing.T) {
	withNewline := ParseCsvPreview([]byte("a,b\n1,2\n"), Options{})
	withoutNewline := ParseCsvPreview([]byte("a,b\n1,2"), Options{})

	if withNewline.TotalRows != withoutNewline.TotalRows {
		t.Fatalf("totalRows differ: %d vs %d", withNewline.TotalRows, withoutNewline.TotalRows)
	}
	if withNewline.TotalRows != 2 {
		t.Fatalf("totalRows = %d, want 2", withNewline.TotalRows)
	}
}

func TestParseCsvPreview_HandlesCRLFLineEndings(t *testing.T) {
	preview := ParseCsvPreview([]byte("a,b\r\n1,2\r\n"), Options{})

	if !reflect.DeepEqual(preview.Rows, [][]string{{"1", "2"}}) {
		t.Fatalf("rows = %#v -- CR should be dropped, not kept in the field", preview.Rows)
	}
}

func TestParseCsvPreview_QuotedFieldKeepsCommasAndNewlines(t *testing.T) {
	preview := ParseCsvPreview([]byte("a,b\n\"x,y\",\"line1\nline2\"\n"), Options{})

	want := [][]string{{"x,y", "line1\nline2"}}
	if !reflect.DeepEqual(preview.Rows, want) {
		t.Fatalf("rows = %#v, want %#v", preview.Rows, want)
	}
}

func TestParseCsvPreview_DoubledQuoteInsideQuotesBecomesOneQuote(t *testing.T) {
	preview := ParseCsvPreview([]byte("a\n\"he said \"\"hi\"\"\"\n"), Options{})

	want := [][]string{{`he said "hi"`}}
	if !reflect.DeepEqual(preview.Rows, want) {
		t.Fatalf("rows = %#v, want %#v", preview.Rows, want)
	}
}

// encoding/csv rejects both of these; the TS scanner accepts them, and a
// preview must never fail on a messy upload -- which is the whole reason
// the parser is hand-rolled (see the package doc comment).
func TestParseCsvPreview_AcceptsRaggedRowsAndBareQuotes(t *testing.T) {
	preview := ParseCsvPreview([]byte("a,b,c\n1,2\n4,5,6,7\n"), Options{})

	if preview.TotalRows != 3 {
		t.Fatalf("totalRows = %d, want 3", preview.TotalRows)
	}
	if len(preview.Rows[0]) != 2 || len(preview.Rows[1]) != 4 {
		t.Fatalf("rows = %#v -- ragged rows should survive as-is", preview.Rows)
	}
}

func TestParseCsvPreview_ClampsToMaxRowsAndMaxCols(t *testing.T) {
	var b strings.Builder
	b.WriteString("c1,c2,c3\n")
	for i := 0; i < 10; i++ {
		b.WriteString("1,2,3\n")
	}

	preview := ParseCsvPreview([]byte(b.String()), Options{MaxRows: 3, MaxCols: 2})

	if len(preview.Rows) != 3 {
		t.Fatalf("rows = %d, want 3", len(preview.Rows))
	}
	if len(preview.Header) != 2 || len(preview.Rows[0]) != 2 {
		t.Fatalf("header/row width = %d/%d, want 2/2", len(preview.Header), len(preview.Rows[0]))
	}
	// totalRows reports the true count, not the clamped one -- the preview
	// text tells the model how much it isn't seeing.
	if preview.TotalRows != 11 {
		t.Fatalf("totalRows = %d, want 11", preview.TotalRows)
	}
}

func TestParseCsvPreview_EmptyContentYieldsEmptyPreview(t *testing.T) {
	preview := ParseCsvPreview(nil, Options{})

	if preview.TotalRows != 0 || len(preview.Header) != 0 || len(preview.Rows) != 0 {
		t.Fatalf("preview = %#v", preview)
	}
	// Non-nil slices so the JSON body is [] rather than null.
	if preview.Header == nil || preview.Rows == nil {
		t.Fatalf("header/rows must serialize as [], got nil")
	}
}

func TestParseCsvPreview_MarkdownEscapesPipesInBodyCells(t *testing.T) {
	preview := ParseCsvPreview([]byte("a\nx|y\n"), Options{})

	if !strings.Contains(preview.MarkdownTable, `x\|y`) {
		t.Fatalf("markdown = %q -- body pipe should be escaped", preview.MarkdownTable)
	}
}

func TestFormatCsvPreviewText_ReportsCountsAndTable(t *testing.T) {
	preview := ParseCsvPreview([]byte("a,b\n1,2\n"), Options{})
	text := FormatCsvPreviewText("data.csv", preview)

	if !strings.HasPrefix(text, "Here is a preview of data.csv (rows: 2, cols: 2).") {
		t.Fatalf("text = %q", text)
	}
	if !strings.Contains(text, preview.MarkdownTable) {
		t.Fatalf("text does not embed the markdown table: %q", text)
	}
}
