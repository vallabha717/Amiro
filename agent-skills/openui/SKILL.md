---
name: openui
description: Render live-streaming, interactive Generative UI surfaces in chat using OpenUI Lang (KPI metric cards, interactive Recharts bar/line/pie charts, sortable status tables, interactive Q&A choice cards, user value-pasting forms, encrypted API key/password vault cards, tabbed comparisons, step trackers, and clickable follow-up chips). Load proactively when the user asks for an interactive dashboard, daily briefing, sprint command center, cost/budget planner, interactive question/intake form, or structured status view.
allowed-tools: mcp, skill_manage
metadata:
  emoji: "✨"
  amiro:
    display-name: "OpenUI Generative UI"
    category: "content"
---

# OpenUI Generative UI for Amiro

Emit structured, streaming-first interactive UI directly in your assistant reply using a fenced ```` ```openui ```` block (or call the `ui_render_openui` MCP tool on the `amiro` server).

Unlike static Markdown or sandboxed HTML iframes, ```` ```openui ```` blocks stream progressively into native Amiro React components (`src/components/openui/`), honor light and dark themes, let the user answer structured questions, paste configuration values/snippets, save API keys or passwords directly into the encrypted vault, adjust interactive sliders/switches/tabs, and click 1-click follow-up chips that send the next turn back into chat.

**Security rule**: Never ask for or echo raw API keys, passwords, or tokens in plain chat text. Use `SecretVaultCard(...)` inside an OpenUI surface (or `ui_prompt_secret`) so the secret is encrypted directly into Amiro's local vault (`$AMIRO_CRED_<SERVICE>_<FIELD>`).

## 1. Fast Presets (`ui_render_openui` MCP tool)

For common daily workflows, invoke `amiro` MCP's `ui_render_openui` tool with a `preset`:
- `preset: "daily_brief"` — **Daily Executive & Engineering Command Center** (KPIs, tabbed traffic bar chart + subsystem health matrix + action steps, and follow-up chips).
- `preset: "budget_planner"` — **Cloud AI Cost & Capacity Planner** (KPIs, interactive workload sliders + smart-routing switch with live recalculation, monthly spend bar chart, and follow-up chips).
- `preset: "sprint_tracker"` — **Sprint Release Command Center** (KPIs, release readiness step tracker, tabbed priority PR table + burnup line chart + risk callout, and follow-up chips).
- `preset: "agent_data_intake"` — **Interactive Deployment & Credential Intake** (Vellum-style interactive `QuestionCard` where the user picks an answer + custom note, an `InteractiveForm` where the user pastes endpoints/JSON/ENV values, and a `SecretVaultCard` where the user pastes an API key or password into the encrypted vault).
- `preset: "inbox_cleanup_setup"` — **Inbox Cleanup Schedule Studio** (step tracker for mail connection + rules + schedule activation, `QuestionCard` for cleanup action mode, `InteractiveForm` with toggles for clearing promotions/unwanted notifications/social clutter while keeping this month's reservations and the last 2 months' bills, plus 1-click activation chips).

## 2. Authoring Custom ```` ```openui ```` Blocks Inline

Every OpenUI Lang program assigns `root = Stack([...])` and defines child statements line by line. Forward references resolve automatically as tokens stream.

### Supported Components & Signatures

- `Stack(children: Component[])` — Vertical container for the surface.
- `CardHeader(title: string, subtitle?: string, badge?: string)` — Top header with optional status badge.
- `QuestionCard(question: string, options: QuestionOption[], submitLabel?: string)` & `QuestionOption(label: string, description?: string, badge?: string)` — Interactive Vellum-style question card where the user clicks an option (and optional note) to answer the agent's question.
- `InteractiveForm(title: string, fields: FormField[], submitLabel?: string, promptTemplate?: string)` — Interactive form for pasting values, editing inputs, or adjusting sliders/switches.
- `FormInput(name: string, label: string, placeholder?: string, defaultValue?: string)` — Single-line text/URL/value input where the user can type or paste a value.
- `FormTextarea(name: string, label: string, placeholder?: string, defaultValue?: string)` — Multi-line textarea where the user can paste JSON, YAML, `.env` lines, or logs.
- `FormSlider(name: string, label: string, min: number, max: number, defaultValue: number, unit?: string)` — Interactive range slider.
- `FormSwitch(name: string, label: string, defaultChecked?: boolean)` — Interactive boolean switch.
- `FormSelect(name: string, label: string, options: string[], defaultValue?: string)` — Interactive dropdown select.
- `SecretVaultCard(service: string, field: string, label: string, description?: string, placeholder?: string, purpose?: string)` — Renders Amiro's encrypted `SecretPromptCard` inline so the user can paste an API key, token, or password directly into the encrypted vault without ever exposing it in chat.
- `MetricGrid(metrics: Metric[])` & `Metric(label: string, value: string, change?: string, tone?: "positive" | "negative" | "warning" | "info" | "neutral")` — Responsive KPI tiles.
- `Tabs(items: TabItem[])` & `TabItem(label: string, content: Component)` — Interactive tabbed sections.
- `BarChart(title: string, labels: string[], series: ChartSeries[])`, `LineChart(title: string, labels: string[], series: ChartSeries[])`, `PieChart(title: string, slices: PieSlice[])`, `ChartSeries(name: string, data: number[], color?: string)`, `PieSlice(label: string, value: number, color?: string)` — Native Recharts visualizations.
- `DataTable(columns: string[], rows: string[][], caption?: string)` — Filterable status table with automatic status badges.
- `Steps(items: StepItem[])` & `StepItem(title: string, status: "completed" | "in_progress" | "pending", description?: string)` — Step progress tracker.
- `Callout(variant: "info" | "success" | "warning" | "danger", title: string, message: string)` — Highlighted alert banner.
- `FollowUpBlock(items: FollowUpItem[], title?: string)` & `FollowUpItem(label: string, prompt: string)` — Clickable follow-up prompt chips.
