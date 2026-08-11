package tools

import (
	"context"
	"encoding/json"
)

// visualizationTools ports lib/ai/tools/visualization/create-{pie,bar,line}-chart.ts
// and create-table.ts. Each TS execute is `async () => "Success"` -- the
// chart/table is never rendered from the tool's *output*, only from the
// model's *input* (message-parts.tsx reads `input` off the tool-call part
// once state reaches "output-available"), so the Go port keeps the same
// trivial, always-succeeding execute.
func visualizationTools() []Definition {
	success := func(context.Context, json.RawMessage) (any, error) { return "Success", nil }
	return []Definition{
		{
			Name:        NameCreatePieChart,
			Toolkit:     ToolkitVisualization,
			Description: "Create a pie chart",
			ParametersSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"data": {
						"type": "array",
						"items": {
							"type": "object",
							"properties": {
								"label": {"type": "string"},
								"value": {"type": "number"}
							},
							"required": ["label", "value"]
						}
					},
					"title": {"type": "string"},
					"description": {"type": ["string", "null"]},
					"unit": {"type": ["string", "null"]}
				},
				"required": ["data", "title", "description", "unit"]
			}`),
			Execute: success,
		},
		{
			Name:             NameCreateBarChart,
			Toolkit:          ToolkitVisualization,
			Description:      "Create a bar chart with multiple data series",
			ParametersSchema: seriesChartSchema("Label for Y-axis"),
			Execute:          success,
		},
		{
			Name:             NameCreateLineChart,
			Toolkit:          ToolkitVisualization,
			Description:      "Create a line chart with multiple data series",
			ParametersSchema: seriesChartSchema("Label for Y-axis"),
			Execute:          success,
		},
		{
			Name:    NameCreateTable,
			Toolkit: ToolkitVisualization,
			Description: "Create an interactive table with data. The table will automatically have sorting, " +
				"filtering, and search functionality.",
			ParametersSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"title": {"type": "string", "description": "Table title"},
					"description": {"type": ["string", "null"], "description": "Optional table description"},
					"columns": {
						"type": "array",
						"description": "Column configuration array",
						"items": {
							"type": "object",
							"properties": {
								"key": {"type": "string", "description": "Column key that matches the data object keys"},
								"label": {"type": "string", "description": "Display label for the column header"},
								"type": {
									"type": ["string", "null"],
									"enum": ["string", "number", "date", "boolean", null],
									"description": "Data type for proper sorting and formatting"
								}
							},
							"required": ["key", "label"]
						}
					},
					"data": {
						"type": "array",
						"description": "Array of row objects. Each object should have keys matching the column names.",
						"items": {"type": "object"}
					}
				},
				"required": ["title", "description", "columns", "data"]
			}`),
			Execute: success,
		},
	}
}

// seriesChartSchema is shared by createBarChart and createLineChart -- both
// TS tools declare the identical `{data: {xAxisLabel, series: [{seriesName,
// value}]}, title, description, yAxisLabel}` shape.
func seriesChartSchema(yAxisLabelDescription string) json.RawMessage {
	return json.RawMessage(`{
		"type": "object",
		"properties": {
			"data": {
				"type": "array",
				"description": "Chart data with x-axis labels and series values",
				"items": {
					"type": "object",
					"properties": {
						"xAxisLabel": {"type": "string"},
						"series": {
							"type": "array",
							"items": {
								"type": "object",
								"properties": {
									"seriesName": {"type": "string"},
									"value": {"type": "number"}
								},
								"required": ["seriesName", "value"]
							}
						}
					},
					"required": ["xAxisLabel", "series"]
				}
			},
			"title": {"type": "string"},
			"description": {"type": ["string", "null"]},
			"yAxisLabel": {"type": ["string", "null"], "description": "` + yAxisLabelDescription + `"}
		},
		"required": ["data", "title", "description", "yAxisLabel"]
	}`)
}
