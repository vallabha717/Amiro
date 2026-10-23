---
name: openui
description: Render live-streaming, interactive Generative UI surfaces in chat using OpenUI Lang (KPI metric cards, interactive Recharts bar/line/pie charts, sortable status tables, interactive budget/workload sliders and switches, tabbed comparisons, step trackers, and clickable follow-up chips). Load proactively when the user asks for an interactive dashboard, daily briefing, sprint command center, cost/budget planner, comparison table, or structured status view.
allowed-tools: mcp, skill_manage
metadata:
  emoji: "✨"
  amiro:
    display-name: "OpenUI Generative UI"
    category: "content"
---

# OpenUI Generative UI for Amiro

Emit structured, streaming-first interactive UI directly in your assistant reply using a fenced ```` ```openui ```` block (or call the `ui_render_openui` MCP tool on the `amiro` server).

Unlike static Markdown or sandboxed HTML iframes, ```` ```openui ```` blocks stream progressively into native Amiro React components (`src/components/openui/`), honor light and dark themes, let the user adjust interactive sliders/switches/tabs, and provide 1-click follow-up chips that send the next turn back into chat.

**Security rule**: Never ask for or render API keys, passwords, or tokens inside an OpenUI surface. Always use `ui_prompt_secret` or an OAuth card for secrets.

## 1. Fast Presets (`ui_render_openui` MCP tool)

For common daily workflows, you can invoke `amiro` MCP's `ui_render_openui` tool with a `preset`:
- `preset: "daily_brief"` — **Daily Executive & Engineering Command Center** (KPIs, tabbed traffic bar chart + subsystem health matrix + action steps, and follow-up chips).
- `preset: "budget_planner"` — **Cloud AI Cost & Capacity Planner** (KPIs, interactive workload sliders + smart-routing switch with live recalculation, monthly spend bar chart, and follow-up chips).
- `preset: "sprint_tracker"` — **Sprint Release Command Center** (KPIs, release readiness step tracker, tabbed priority PR table + burnup line chart + risk callout, and follow-up chips).

## 2. Authoring Custom ```` ```openui ```` Blocks Inline

Every OpenUI Lang program assigns `root = Stack([...])` and defines child statements line by line. Forward references resolve automatically as tokens stream.

### Supported Components & Signatures

- `Stack(children: Component[])` — Vertical container for the surface.
- `CardHeader(title: string, subtitle?: string, badge?: string)` — Top header with optional status badge.
- `MetricGrid(metrics: Metric[])` — Responsive 2-to-4 column KPI grid.
- `Metric(label: string, value: string, change?: string, tone?: "positive" | "negative" | "warning" | "info" | "neutral")` — Single KPI tile.
- `Tabs(items: TabItem[])` & `TabItem(label: string, content: Component)` — Interactive tabbed sections.
- `BarChart(title: string, labels: string[], series: ChartSeries[])` — Native Recharts bar chart.
- `LineChart(title: string, labels: string[], series: ChartSeries[])` — Native Recharts line chart.
- `PieChart(title: string, slices: PieSlice[])` & `PieSlice(label: string, value: number, color?: string)` — Native Recharts donut/pie chart.
- `ChartSeries(name: string, data: number[], color?: string)` — Series for `BarChart` or `LineChart`.
- `DataTable(columns: string[], rows: string[][], caption?: string)` — Filterable/interactive status table with automatic status badge styling.
- `Steps(items: StepItem[])` & `StepItem(title: string, status: "completed" | "in_progress" | "pending", description?: string)` — Step progress tracker.
- `Callout(variant: "info" | "success" | "warning" | "danger", title: string, message: string)` — Highlighted alert banner.
- `InteractiveForm(title: string, fields: FormField[], submitLabel?: string, promptTemplate?: string)` — Interactive simulator/triage form that dispatches user selections back to chat.
- `FormSlider(name: string, label: string, min: number, max: number, defaultValue: number, unit?: string)` — Interactive range slider.
- `FormSwitch(name: string, label: string, defaultChecked?: boolean)` — Interactive boolean switch.
- `FormSelect(name: string, label: string, options: string[], defaultValue?: string)` — Interactive dropdown select.
- `FollowUpBlock(items: FollowUpItem[], title?: string)` & `FollowUpItem(label: string, prompt: string)` — Clickable follow-up prompt chips at the bottom of the surface.

### Example Inline Block

````markdown
Here is your live Cloud Cost & Sprint Command Center:

```openui
root = Stack([header, kpis, controls, chart, followUps])
header = CardHeader("Cloud AI Cost & Capacity Planner", "Interactive workload & routing simulator", "Live OpenUI")
kpis = MetricGrid([mSpend, mReq, mCache, mSave])
mSpend = Metric("Monthly Run-Rate", "$4,820", "-14% vs last month", "positive")
mReq = Metric("Daily Requests", "184K", "+22% this week", "info")
mCache = Metric("Prompt Cache Hit", "68.4%", "+9.1% efficiency", "positive")
mSave = Metric("Annualized Savings", "$19,400", "With hybrid routing", "positive")
controls = InteractiveForm("Simulate Workload & Routing Policy", [fRpm, fCache, fRoute], "Apply & Recalculate", "Recalculate AI budget plan")
fRpm = FormSlider("requests_per_day", "Peak Daily Requests (K)", 50, 500, 180, "K req/day")
fCache = FormSlider("cache_target", "Target Cache Hit Rate (%)", 20, 90, 70, "%")
fRoute = FormSwitch("smart_routing", "Auto-route routine tasks to Flash tier", true)
chart = BarChart("Monthly Spend by Model Tier ($ USD)", ["Jan", "Feb", "Mar", "Apr"], [s1, s2])
s1 = ChartSeries("Frontier Reasoning", [3400, 3150, 2890, 2420], "#6366f1")
s2 = ChartSeries("Fast Workhorse", [1200, 1480, 1790, 2400], "#10b981")
followUps = FollowUpBlock([fu1, fu2])
fu1 = FollowUpItem("Apply hybrid routing policy", "Configure hybrid model routing to cap monthly spend at $4,500")
fu2 = FollowUpItem("Schedule weekly budget check", "Schedule a weekly Monday 9am cost anomaly digest")
```
````
