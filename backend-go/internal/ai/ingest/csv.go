// Package ingest ports src/lib/file-ingest/csv.ts and the parts of
// src/lib/ai/ingest/csv-ingest.ts that run server-side: turning an
// uploaded CSV into a bounded preview plus the markdown table the chat
// model actually reads.
//
// The CSV parser is hand-rolled rather than encoding/csv-backed on
// purpose. encoding/csv is stricter than the TS scanner in ways that
// change behavior on real user uploads: it errors on a bare quote inside
// an unquoted field and on rows with a varying field count, where the TS
// parser silently accepts both. A preview feature must never fail on a
// messy file, so the port keeps the TS scanner's exact character-by-
// character semantics instead of inheriting Go's stricter ones.
package ingest

import (
	"fmt"
	"strings"
)

// Preview ports CsvPreview (csv.ts:3).
type Preview struct {
	Header        []string   `json:"header"`
	Rows          [][]string `json:"rows"`
	Columns       int        `json:"columns"`
	TotalRows     int        `json:"totalRows"`
	MarkdownTable string     `json:"markdownTable"`
}

// Options ports parseCsvPreview's opts parameter (csv.ts:13).
type Options struct {
	MaxRows int
	MaxCols int
}

// ParseCsvPreview ports parseCsvPreview (csv.ts:11).
func ParseCsvPreview(content []byte, opts Options) Preview {
	maxRows := opts.MaxRows
	if maxRows < 1 {
		maxRows = 50
	}
	maxCols := opts.MaxCols
	if maxCols < 1 {
		maxCols = 12
	}

	rows := scanCSV(string(content))

	totalRows := len(rows)
	var header []string
	if totalRows > 0 {
		header = rows[0]
	}
	limitedHeader := clampRow(header, maxCols)

	var limitedRows [][]string
	if totalRows > 1 {
		dataRows := rows[1:]
		if len(dataRows) > maxRows {
			dataRows = dataRows[:maxRows]
		}
		limitedRows = make([][]string, 0, len(dataRows))
		for _, row := range dataRows {
			limitedRows = append(limitedRows, clampRow(row, maxCols))
		}
	}
	if limitedRows == nil {
		limitedRows = [][]string{}
	}
	if limitedHeader == nil {
		limitedHeader = []string{}
	}

	return Preview{
		Header:        limitedHeader,
		Rows:          limitedRows,
		Columns:       len(limitedHeader),
		TotalRows:     totalRows,
		MarkdownTable: markdownTable(limitedHeader, limitedRows),
	}
}

// scanCSV is the character scanner from csv.ts:34-64, transcribed. The
// trailing-row rule is the subtle part: the last field is always flushed,
// but the row it belongs to is only kept when at least one of its fields
// is non-empty -- which is what stops a trailing newline from producing a
// phantom final row.
func scanCSV(text string) [][]string {
	var rows [][]string
	var row []string
	var field strings.Builder
	inQuotes := false

	pushField := func() {
		row = append(row, field.String())
		field.Reset()
	}
	pushRow := func() {
		rows = append(rows, row)
		row = nil
	}

	runes := []rune(text)
	for i := 0; i < len(runes); i++ {
		ch := runes[i]
		if inQuotes {
			if ch == '"' {
				if i+1 < len(runes) && runes[i+1] == '"' {
					field.WriteRune('"')
					i++
				} else {
					inQuotes = false
				}
			} else {
				field.WriteRune(ch)
			}
			continue
		}
		switch ch {
		case '"':
			inQuotes = true
		case ',':
			pushField()
		case '\n':
			pushField()
			pushRow()
		case '\r':
			// ignore CR (handle CRLF)
		default:
			field.WriteRune(ch)
		}
	}

	pushField()
	for _, f := range row {
		if f != "" {
			pushRow()
			break
		}
	}
	return rows
}

func clampRow(row []string, maxCols int) []string {
	if len(row) > maxCols {
		return row[:maxCols]
	}
	return row
}

// markdownTable ports the mdHeader/mdSep/mdBody join (csv.ts:75-82),
// including the pipe escaping applied to body cells only.
func markdownTable(header []string, rows [][]string) string {
	separators := make([]string, len(header))
	for i := range separators {
		separators[i] = "---"
	}

	lines := []string{
		"| " + strings.Join(header, " | ") + " |",
		"| " + strings.Join(separators, " | ") + " |",
	}

	body := make([]string, 0, len(rows))
	for _, row := range rows {
		cells := make([]string, 0, len(row))
		for _, cell := range row {
			cells = append(cells, strings.ReplaceAll(cell, "|", `\|`))
		}
		body = append(body, "| "+strings.Join(cells, " | ")+" |")
	}
	lines = append(lines, strings.Join(body, "\n"))

	return strings.Join(lines, "\n")
}

// FormatCsvPreviewText ports formatCsvPreviewText (csv.ts:93).
func FormatCsvPreviewText(name string, preview Preview) string {
	return fmt.Sprintf(
		"Here is a preview of %s (rows: %d, cols: %d). Summarize or analyze as needed.\n\n%s",
		name, preview.TotalRows, preview.Columns, preview.MarkdownTable,
	)
}
