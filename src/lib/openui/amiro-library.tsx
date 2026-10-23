"use client";

import {
  createLibrary,
  defineComponent,
  useIsStreaming,
  useTriggerAction,
} from "@openuidev/react-lang";
import { cn } from "lib/utils";
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  ClockIcon,
  InfoIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  TrendingDownIcon,
  TrendingUpIcon,
  XCircleIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart as RechartsLineChart,
  Pie,
  PieChart as RechartsPieChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import { Input } from "ui/input";
import { Switch } from "ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "ui/table";
import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Built-in Daily-Use Presets (matching backend/src/agent_mcp.rs)
// ---------------------------------------------------------------------------

export const OPENUI_PRESETS: Record<
  "daily_brief" | "budget_planner" | "sprint_tracker",
  { title: string; code: string }
> = {
  daily_brief: {
    title: "Daily Executive & Engineering Command Center",
    code: `root = Stack([header, kpis, tabs, followUps])
header = CardHeader("Daily Executive & Engineering Command Center", "Live snapshot of system health, sprint delivery, and AI operations", "Live Briefing")
kpis = MetricGrid([mUptime, mDeploy, mLatency, mCost])
mUptime = Metric("Platform Availability", "99.98%", "Last 30 days SLA", "positive")
mDeploy = Metric("Deploys This Week", "18", "100% automated rollback ready", "info")
mLatency = Metric("Agent Median Response", "1.18s", "-240ms faster with streaming UI", "positive")
mCost = Metric("Open Action Items", "3", "1 high-priority review today", "warning")
tabs = Tabs([tabOverview, tabServices, tabActionPlan])
tabOverview = TabItem("Traffic & Latency", trafficChart)
tabServices = TabItem("Service Matrix", serviceTable)
tabActionPlan = TabItem("Today's Focus", focusSteps)
trafficChart = BarChart("Weekly Agent Tasks & Automated Resolutions", ["Mon", "Tue", "Wed", "Thu", "Fri"], [sResolved, sEscalated])
sResolved = ChartSeries("Resolved Autonomously", [420, 465, 510, 548, 590], "#10b981")
sEscalated = ChartSeries("Human-in-the-Loop", [48, 41, 39, 34, 28], "#6366f1")
serviceTable = DataTable(["Subsystem", "Health", "Latency (p95)", "Owner", "Notes"], [row1, row2, row3, row4])
row1 = ["Amiro Rust Backend", "Healthy", "11 ms", "Core Platform", "v1.26 active"]
row2 = ["Jcode Agent Runtime", "Healthy", "185 ms", "Agent Engine", "MCP bridge synced"]
row3 = ["Connector OAuth Broker", "Degraded", "410 ms", "Integrations", "Token refresh retry queued"]
row4 = ["Voice TTS/STT Pipeline", "Healthy", "210 ms", "Voice & Speech", "EN + HI active"]
focusSteps = Steps([step1, step2, step3])
step1 = StepItem("Morning Health & Vault Audit", "completed", "All 6 encrypted credentials verified")
step2 = StepItem("Approve Connector OAuth Retry Patch", "in_progress", "Waiting on final staging check")
step3 = StepItem("Publish Friday Customer Digest", "pending", "Scheduled for 17:00 UTC")
followUps = FollowUpBlock([f1, f2, f3])
f1 = FollowUpItem("Open Cloud AI Budget Planner", "Show me the interactive Cloud AI Cost & Capacity Planner")
f2 = FollowUpItem("Drill into Connector OAuth latency", "Why is the Connector OAuth Broker showing 410ms p95 latency?")
f3 = FollowUpItem("Schedule this briefing daily at 8:30 AM", "Schedule this Executive Command Center briefing every weekday at 08:30")`,
  },
  budget_planner: {
    title: "Cloud AI Cost & Capacity Planner",
    code: `root = Stack([header, kpis, controls, chartCard, followUps])
header = CardHeader("Cloud AI Cost & Capacity Planner", "Model spend, latency, and interactive scaling simulator", "FinOps Simulator")
kpis = MetricGrid([mSpend, mTokens, mCache, mSavings])
mSpend = Metric("Monthly Run-Rate", "$4,820", "-14% vs last month", "positive")
mTokens = Metric("Daily Requests", "184K", "+22% this week", "info")
mCache = Metric("Prompt Cache Hit", "68.4%", "+9.1% efficiency", "positive")
mSavings = Metric("Projected Annual Savings", "$19,400", "With hybrid routing", "positive")
controls = InteractiveForm("Simulate Workload & Routing Policy", [fRpm, fCache, fRoute], "Recalculate Forecast", "Update my AI budget plan with the selected workload parameters")
fRpm = FormSlider("requests_per_day", "Peak Daily Requests (K)", 50, 500, 180, "K req/day")
fCache = FormSlider("cache_target", "Target Cache Hit Rate (%)", 20, 90, 70, "%")
fRoute = FormSwitch("smart_routing", "Auto-route routine tasks to Flash tier", true)
chartCard = BarChart("Monthly Spend by Model Tier ($ USD)", ["Jan", "Feb", "Mar", "Apr"], [seriesFrontier, seriesFlash])
seriesFrontier = ChartSeries("Frontier Reasoning", [3400, 3150, 2890, 2420], "#6366f1")
seriesFlash = ChartSeries("Fast Workhorse", [1200, 1480, 1790, 2400], "#10b981")
followUps = FollowUpBlock([fuOptimize, fuExport, fuAlert])
fuOptimize = FollowUpItem("Apply hybrid routing policy", "Configure hybrid model routing to cap monthly spend at $4,500")
fuExport = FollowUpItem("Export FinOps CSV report", "Generate a CSV artifact of the April model cost breakdown")
fuAlert = FollowUpItem("Schedule weekly budget check", "Schedule a weekly Monday 9am cost anomaly digest")`,
  },
  sprint_tracker: {
    title: "Sprint 42 Release Command Center",
    code: `root = Stack([header, kpis, steps, tabs, followUps])
header = CardHeader("Sprint 42 Release Command Center", "Release v1.27 readiness, PR velocity, and active blockers", "Release v1.27")
kpis = MetricGrid([mVelocity, mMerged, mP95, mBlockers])
mVelocity = Metric("Sprint Completion", "88%", "37 of 42 story points", "positive")
mMerged = Metric("PRs Merged", "29", "+6 since yesterday", "info")
mP95 = Metric("API p95 Latency", "142 ms", "-18 ms improvement", "positive")
mBlockers = Metric("Release Blockers", "1", "OAuth token refresh edge case", "warning")
steps = Steps([sFreeze, sCanary, sE2E, sProd])
sFreeze = StepItem("Feature Freeze & Schema Lock", "completed", "All 14 migrations verified in staging")
sCanary = StepItem("EU-West Canary Rollout (10%)", "completed", "Zero 5xx errors over 6h soak")
sE2E = StepItem("Playwright E2E Suite & Security Audit", "in_progress", "13/14 journeys green, final voice check running")
sProd = StepItem("Global Production Promotion", "pending", "Scheduled for 16:00 UTC")
tabs = Tabs([tabPRs, tabVelocity, tabRisk])
tabPRs = TabItem("Priority PR Queue", prTable)
tabVelocity = TabItem("Burnup & Throughput", velocityChart)
tabRisk = TabItem("Release Triage", riskCallout)
prTable = DataTable(["PR", "Owner", "Service", "Status", "Impact"], [r1, r2, r3, r4])
r1 = ["#418 Streaming OpenUI Renderer", "A. Patel", "frontend-chat", "Ready to Merge", "High"]
r2 = ["#421 Vault Key Rotation Guard", "S. Somayaji", "backend-auth", "Merged", "Critical"]
r3 = ["#425 MCP OAuth Retry Backoff", "M. Chen", "runtime-mcp", "In Review", "High"]
r4 = ["#429 Hindi Locale Parity Check", "R. Sharma", "i18n", "Merged", "Medium"]
velocityChart = LineChart("Story Points Completed vs Target", ["Day 1", "Day 3", "Day 5", "Day 7", "Day 10"], [sActual, sTarget])
sActual = ChartSeries("Completed Points", [4, 12, 21, 31, 37], "#10b981")
sTarget = ChartSeries("Ideal Burnup", [4, 11, 19, 28, 42], "#6366f1")
riskCallout = Callout("warning", "Action Required: MCP OAuth Refresh (#425)", "Approve PR #425 before 15:00 UTC to unblock the remaining 2 enterprise connector tests.")
followUps = FollowUpBlock([fuNudge, fuNotes, fuRollback])
fuNudge = FollowUpItem("Draft release notes for v1.27", "Draft customer-facing release notes for Sprint 42 v1.27")
fuNotes = FollowUpItem("Inspect PR #425 blocker", "Show the risk summary and test plan for PR #425 MCP OAuth Retry Backoff")
fuRollback = FollowUpItem("Generate rollout checklist", "Create an interactive production deployment and rollback checklist")`,
  },
};

// ---------------------------------------------------------------------------
// Component Definitions
// ---------------------------------------------------------------------------

const DEFAULT_COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ec4899", "#06b6d4"];

export const CardHeaderComp = defineComponent({
  name: "CardHeader",
  description: "Top header for an OpenUI card with title, subtitle, and optional badge",
  props: z.object({
    title: z.string().describe("Main title"),
    subtitle: z.string().optional().describe("Supporting subtitle"),
    badge: z.string().optional().describe("Optional status pill"),
  }),
  component: ({ props }) => (
    <div
      data-testid="openui-card-header"
      className="flex flex-wrap items-start justify-between gap-2 border-b border-border/60 pb-3"
    >
      <div className="space-y-0.5">
        <h3 className="text-base font-semibold tracking-tight text-foreground">
          {props.title}
        </h3>
        {props.subtitle ? (
          <p className="text-xs text-muted-foreground">{props.subtitle}</p>
        ) : null}
      </div>
      {props.badge ? (
        <Badge
          variant="secondary"
          className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium"
        >
          <SparklesIcon className="size-3 text-primary" />
          {props.badge}
        </Badge>
      ) : null}
    </div>
  ),
});

export const MetricComp = defineComponent({
  name: "Metric",
  description: "Single KPI metric card with label, primary value, delta, and semantic tone",
  props: z.object({
    label: z.string().describe("Metric label"),
    value: z.string().describe("Primary metric value"),
    change: z.string().optional().describe("Delta or context caption"),
    tone: z
      .enum(["positive", "negative", "warning", "info", "neutral"])
      .optional()
      .describe("Semantic status tone"),
  }),
  component: ({ props }) => {
    const tone = props.tone ?? "neutral";
    const toneClasses: Record<string, string> = {
      positive:
        "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
      negative:
        "text-rose-600 dark:text-rose-400 bg-rose-500/10 border-rose-500/20",
      warning:
        "text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20",
      info: "text-indigo-600 dark:text-indigo-400 bg-indigo-500/10 border-indigo-500/20",
      neutral: "text-muted-foreground bg-muted/60 border-border/60",
    };
    return (
      <div
        data-testid="openui-metric-card"
        className="flex flex-col justify-between gap-1.5 rounded-xl border border-border/70 bg-muted/25 p-3.5 transition-colors hover:bg-muted/40"
      >
        <div className="flex items-center justify-between gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            {props.label}
          </span>
          {tone === "positive" ? (
            <TrendingUpIcon className="size-3.5 text-emerald-500" />
          ) : tone === "negative" ? (
            <TrendingDownIcon className="size-3.5 text-rose-500" />
          ) : null}
        </div>
        <div className="font-mono text-xl font-semibold tracking-tight text-foreground">
          {props.value}
        </div>
        {props.change ? (
          <span
            className={cn(
              "inline-flex w-fit items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
              toneClasses[tone] ?? toneClasses.neutral,
            )}
          >
            {props.change}
          </span>
        ) : null}
      </div>
    );
  },
});

export const MetricGridComp = defineComponent({
  name: "MetricGrid",
  description: "Responsive 2-to-4 column grid of Metric cards",
  props: z.object({
    metrics: z.array(MetricComp.ref).describe("List of Metric items"),
  }),
  component: ({ props, renderNode }) => {
    const items = Array.isArray(props.metrics) ? props.metrics : [];
    return (
      <div
        data-testid="openui-metric-grid"
        className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4"
      >
        {items.map((item, idx) => (
          <div key={idx}>{renderNode(item)}</div>
        ))}
      </div>
    );
  },
});

export const ChartSeriesComp = defineComponent({
  name: "ChartSeries",
  description: "A named numeric series for BarChart or LineChart",
  props: z.object({
    name: z.string().describe("Series label"),
    data: z.array(z.number()).describe("Numeric values matching chart labels"),
    color: z.string().optional().describe("Optional hex color"),
  }),
  component: () => null,
});

function extractSeries(rawSeries: unknown): {
  name: string;
  data: number[];
  color: string;
}[] {
  if (!Array.isArray(rawSeries)) return [];
  return rawSeries
    .map((item: any, idx) => {
      const p = item?.props ?? item ?? {};
      const name = typeof p.name === "string" ? p.name : `Series ${idx + 1}`;
      const data = Array.isArray(p.data)
        ? p.data.map((n: unknown) => (typeof n === "number" ? n : Number(n) || 0))
        : [];
      const color =
        typeof p.color === "string" && p.color.trim()
          ? p.color
          : DEFAULT_COLORS[idx % DEFAULT_COLORS.length];
      return { name, data, color };
    })
    .filter((s) => s.data.length > 0);
}

export const BarChartComp = defineComponent({
  name: "BarChart",
  description: "Interactive Recharts bar chart with labels and one or more ChartSeries",
  props: z.object({
    title: z.string().describe("Chart title"),
    labels: z.array(z.string()).describe("X-axis category labels"),
    series: z.array(ChartSeriesComp.ref).describe("Data series"),
  }),
  component: ({ props }) => {
    const labels = Array.isArray(props.labels) ? props.labels : [];
    const series = useMemo(() => extractSeries(props.series), [props.series]);
    const chartData = useMemo(
      () =>
        labels.map((label, i) => {
          const row: Record<string, string | number> = { label };
          for (const s of series) {
            row[s.name] = s.data[i] ?? 0;
          }
          return row;
        }),
      [labels, series],
    );

    return (
      <div
        data-testid="openui-bar-chart"
        className="flex flex-col gap-2 rounded-xl border border-border/70 bg-muted/15 p-3.5"
      >
        <div className="text-xs font-semibold text-foreground">{props.title}</div>
        <div className="h-56 w-full min-w-[240px]">
          <ResponsiveContainer width="100%" height="100%">
            <RechartsBarChart
              data={chartData}
              margin={{ top: 8, right: 12, left: 0, bottom: 4 }}
            >
              <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <RechartsTooltip
                contentStyle={{
                  borderRadius: "8px",
                  fontSize: "12px",
                  backgroundColor: "var(--card)",
                  borderColor: "var(--border)",
                  color: "var(--foreground)",
                }}
              />
              <Legend wrapperStyle={{ fontSize: "11px" }} />
              {series.map((s) => (
                <Bar
                  key={s.name}
                  dataKey={s.name}
                  fill={s.color}
                  radius={[4, 4, 0, 0]}
                />
              ))}
            </RechartsBarChart>
          </ResponsiveContainer>
        </div>
      </div>
    );
  },
});

export const LineChartComp = defineComponent({
  name: "LineChart",
  description: "Interactive Recharts line chart with labels and one or more ChartSeries",
  props: z.object({
    title: z.string().describe("Chart title"),
    labels: z.array(z.string()).describe("X-axis category labels"),
    series: z.array(ChartSeriesComp.ref).describe("Data series"),
  }),
  component: ({ props }) => {
    const labels = Array.isArray(props.labels) ? props.labels : [];
    const series = useMemo(() => extractSeries(props.series), [props.series]);
    const chartData = useMemo(
      () =>
        labels.map((label, i) => {
          const row: Record<string, string | number> = { label };
          for (const s of series) {
            row[s.name] = s.data[i] ?? 0;
          }
          return row;
        }),
      [labels, series],
    );

    return (
      <div
        data-testid="openui-line-chart"
        className="flex flex-col gap-2 rounded-xl border border-border/70 bg-muted/15 p-3.5"
      >
        <div className="text-xs font-semibold text-foreground">{props.title}</div>
        <div className="h-56 w-full min-w-[240px]">
          <ResponsiveContainer width="100%" height="100%">
            <RechartsLineChart
              data={chartData}
              margin={{ top: 8, right: 12, left: 0, bottom: 4 }}
            >
              <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <RechartsTooltip
                contentStyle={{
                  borderRadius: "8px",
                  fontSize: "12px",
                  backgroundColor: "var(--card)",
                  borderColor: "var(--border)",
                  color: "var(--foreground)",
                }}
              />
              <Legend wrapperStyle={{ fontSize: "11px" }} />
              {series.map((s) => (
                <Line
                  key={s.name}
                  type="monotone"
                  dataKey={s.name}
                  stroke={s.color}
                  strokeWidth={2.5}
                  dot={{ r: 3 }}
                />
              ))}
            </RechartsLineChart>
          </ResponsiveContainer>
        </div>
      </div>
    );
  },
});

export const PieSliceComp = defineComponent({
  name: "PieSlice",
  description: "Single slice in a PieChart",
  props: z.object({
    label: z.string().describe("Slice label"),
    value: z.number().describe("Slice numeric value"),
    color: z.string().optional().describe("Optional hex color"),
  }),
  component: () => null,
});

export const PieChartComp = defineComponent({
  name: "PieChart",
  description: "Interactive Recharts donut/pie chart",
  props: z.object({
    title: z.string().describe("Chart title"),
    slices: z.array(PieSliceComp.ref).describe("Pie slices"),
  }),
  component: ({ props }) => {
    const slices = useMemo(() => {
      if (!Array.isArray(props.slices)) return [];
      return props.slices.map((s: any, idx) => {
        const p = s?.props ?? s ?? {};
        return {
          name: typeof p.label === "string" ? p.label : `Slice ${idx + 1}`,
          value: typeof p.value === "number" ? p.value : Number(p.value) || 0,
          color:
            typeof p.color === "string" && p.color.trim()
              ? p.color
              : DEFAULT_COLORS[idx % DEFAULT_COLORS.length],
        };
      });
    }, [props.slices]);

    return (
      <div
        data-testid="openui-pie-chart"
        className="flex flex-col gap-2 rounded-xl border border-border/70 bg-muted/15 p-3.5"
      >
        <div className="text-xs font-semibold text-foreground">{props.title}</div>
        <div className="h-56 w-full min-w-[240px]">
          <ResponsiveContainer width="100%" height="100%">
            <RechartsPieChart>
              <Pie
                data={slices}
                dataKey="value"
                nameKey="name"
                innerRadius={45}
                outerRadius={78}
                paddingAngle={3}
              >
                {slices.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Pie>
              <RechartsTooltip />
              <Legend wrapperStyle={{ fontSize: "11px" }} />
            </RechartsPieChart>
          </ResponsiveContainer>
        </div>
      </div>
    );
  },
});

function renderStatusCell(cell: string) {
  const lower = cell.trim().toLowerCase();
  if (
    lower === "healthy" ||
    lower === "merged" ||
    lower === "ready to merge" ||
    lower === "completed"
  ) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
        <CheckCircle2Icon className="size-3" />
        {cell}
      </span>
    );
  }
  if (
    lower === "degraded" ||
    lower === "in review" ||
    lower === "warning" ||
    lower === "high"
  ) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
        <ClockIcon className="size-3" />
        {cell}
      </span>
    );
  }
  if (lower === "critical" || lower === "blocked" || lower === "failed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/25 bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-600 dark:text-rose-400">
        <AlertTriangleIcon className="size-3" />
        {cell}
      </span>
    );
  }
  return cell;
}

export const DataTableComp = defineComponent({
  name: "DataTable",
  description: "Interactive filterable table with automatic status badges",
  props: z.object({
    columns: z.array(z.string()).describe("Column headers"),
    rows: z.array(z.array(z.string())).describe("Table rows"),
    caption: z.string().optional().describe("Optional table caption"),
  }),
  component: ({ props }) => {
    const [filter, setFilter] = useState("");
    const columns = Array.isArray(props.columns) ? props.columns : [];
    const rows = Array.isArray(props.rows) ? props.rows : [];
    const filteredRows = useMemo(() => {
      const q = filter.trim().toLowerCase();
      if (!q) return rows;
      return rows.filter((row) =>
        Array.isArray(row) &&
        row.some((cell) => String(cell).toLowerCase().includes(q)),
      );
    }, [rows, filter]);

    return (
      <div
        data-testid="openui-data-table"
        className="flex flex-col gap-2 rounded-xl border border-border/70 bg-card overflow-hidden"
      >
        {rows.length > 2 && (
          <div className="flex items-center gap-2 border-b border-border/60 bg-muted/20 px-3 py-2">
            <SearchIcon className="size-3.5 text-muted-foreground" />
            <Input
              data-testid="openui-table-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter rows…"
              aria-label="Filter table rows"
              className="h-7 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-0"
            />
            <span className="ml-auto font-mono text-[11px] text-muted-foreground">
              {filteredRows.length}/{rows.length}
            </span>
          </div>
        )}
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30">
                {columns.map((col, idx) => (
                  <TableHead key={idx} className="text-xs font-semibold">
                    {col}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredRows.map((row, rIdx) => (
                <TableRow key={rIdx} data-testid="openui-table-row">
                  {(Array.isArray(row) ? row : []).map((cell, cIdx) => (
                    <TableCell key={cIdx} className="py-2 text-xs">
                      {renderStatusCell(String(cell ?? ""))}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {props.caption ? (
          <div className="border-t border-border/50 bg-muted/15 px-3 py-1.5 text-[11px] text-muted-foreground">
            {props.caption}
          </div>
        ) : null}
      </div>
    );
  },
});

export const TabItemComp = defineComponent({
  name: "TabItem",
  description: "Single tab pane with label and child component",
  props: z.object({
    label: z.string().describe("Tab button label"),
    content: z.any().describe("Child component to render inside the tab"),
  }),
  component: ({ props, renderNode }) => <>{renderNode(props.content)}</>,
});

export const TabsComp = defineComponent({
  name: "Tabs",
  description: "Interactive tabbed view switching between TabItem children",
  props: z.object({
    items: z.array(TabItemComp.ref).describe("Tab items"),
  }),
  component: ({ props, renderNode }) => {
    const items = Array.isArray(props.items) ? props.items : [];
    const [activeIndex, setActiveIndex] = useState(0);
    const safeIndex = activeIndex < items.length ? activeIndex : 0;
    const current = items[safeIndex] as any;

    if (items.length === 0) return null;

    return (
      <div data-testid="openui-tabs" className="flex flex-col gap-3">
        <div
          role="tablist"
          aria-label="OpenUI view tabs"
          className="flex flex-wrap items-center gap-1 rounded-xl border border-border/60 bg-muted/35 p-1 w-fit"
        >
          {items.map((item: any, idx) => {
            const label =
              typeof item?.props?.label === "string"
                ? item.props.label
                : `Tab ${idx + 1}`;
            const isActive = idx === safeIndex;
            return (
              <button
                key={idx}
                type="button"
                role="tab"
                aria-selected={isActive}
                data-testid={`openui-tab-${idx}`}
                onClick={() => setActiveIndex(idx)}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-xs font-medium transition-all cursor-pointer",
                  isActive
                    ? "bg-card text-foreground shadow-xs border border-border/60"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div data-testid="openui-tab-panel">
          {current ? renderNode(current.props?.content ?? current) : null}
        </div>
      </div>
    );
  },
});

export const StepItemComp = defineComponent({
  name: "StepItem",
  description: "Single step in a Steps progress tracker",
  props: z.object({
    title: z.string().describe("Step title"),
    status: z
      .enum(["completed", "in_progress", "pending"])
      .describe("Current step status"),
    description: z.string().optional().describe("Step details"),
  }),
  component: ({ props }) => {
    const status = props.status ?? "pending";
    return (
      <div
        data-testid="openui-step-item"
        data-step-status={status}
        className="flex items-start gap-3 rounded-xl border border-border/60 bg-muted/15 px-3.5 py-2.5"
      >
        <div className="mt-0.5 shrink-0">
          {status === "completed" ? (
            <CheckCircle2Icon className="size-4 text-emerald-500" />
          ) : status === "in_progress" ? (
            <CircleDotIcon className="size-4 text-primary animate-pulse" />
          ) : (
            <ClockIcon className="size-4 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-foreground">
              {props.title}
            </span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                status === "completed"
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : status === "in_progress"
                    ? "bg-primary/10 text-primary"
                    : "bg-muted text-muted-foreground",
              )}
            >
              {status.replace("_", " ")}
            </span>
          </div>
          {props.description ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {props.description}
            </p>
          ) : null}
        </div>
      </div>
    );
  },
});

export const StepsComp = defineComponent({
  name: "Steps",
  description: "Ordered step progress tracker",
  props: z.object({
    items: z.array(StepItemComp.ref).describe("List of StepItem nodes"),
  }),
  component: ({ props, renderNode }) => {
    const items = Array.isArray(props.items) ? props.items : [];
    return (
      <div data-testid="openui-steps" className="flex flex-col gap-2">
        {items.map((item, idx) => (
          <div key={idx}>{renderNode(item)}</div>
        ))}
      </div>
    );
  },
});

export const CalloutComp = defineComponent({
  name: "Callout",
  description: "Highlighted alert or recommendation banner",
  props: z.object({
    variant: z
      .enum(["info", "success", "warning", "danger"])
      .describe("Alert severity"),
    title: z.string().describe("Banner headline"),
    message: z.string().describe("Supporting explanation"),
  }),
  component: ({ props }) => {
    const variant = props.variant ?? "info";
    const styles: Record<string, string> = {
      info: "border-indigo-500/30 bg-indigo-500/10 text-indigo-950 dark:text-indigo-200",
      success:
        "border-emerald-500/30 bg-emerald-500/10 text-emerald-950 dark:text-emerald-200",
      warning:
        "border-amber-500/35 bg-amber-500/10 text-amber-950 dark:text-amber-200",
      danger:
        "border-rose-500/35 bg-rose-500/10 text-rose-950 dark:text-rose-200",
    };
    const Icon =
      variant === "success"
        ? CheckCircle2Icon
        : variant === "warning"
          ? AlertTriangleIcon
          : variant === "danger"
            ? XCircleIcon
            : InfoIcon;

    return (
      <div
        data-testid="openui-callout"
        className={cn(
          "flex items-start gap-3 rounded-xl border p-3.5 text-xs",
          styles[variant] ?? styles.info,
        )}
      >
        <Icon className="mt-0.5 size-4 shrink-0" />
        <div className="space-y-1">
          <div className="font-semibold">{props.title}</div>
          <div className="opacity-90 leading-relaxed">{props.message}</div>
        </div>
      </div>
    );
  },
});

export const FormSliderComp = defineComponent({
  name: "FormSlider",
  description: "Interactive numeric slider control inside an InteractiveForm",
  props: z.object({
    name: z.string().describe("Field key"),
    label: z.string().describe("Field label"),
    min: z.number().describe("Minimum value"),
    max: z.number().describe("Maximum value"),
    defaultValue: z.number().describe("Initial value"),
    unit: z.string().optional().describe("Unit suffix e.g. %, K req/day"),
  }),
  component: () => null,
});

export const FormSwitchComp = defineComponent({
  name: "FormSwitch",
  description: "Interactive boolean toggle switch inside an InteractiveForm",
  props: z.object({
    name: z.string().describe("Field key"),
    label: z.string().describe("Toggle label"),
    defaultChecked: z.boolean().optional().describe("Initial boolean state"),
  }),
  component: () => null,
});

export const FormSelectComp = defineComponent({
  name: "FormSelect",
  description: "Interactive select control inside an InteractiveForm",
  props: z.object({
    name: z.string().describe("Field key"),
    label: z.string().describe("Select label"),
    options: z.array(z.string()).describe("Option values"),
    defaultValue: z.string().optional().describe("Initial selected option"),
  }),
  component: () => null,
});

export const InteractiveFormComp = defineComponent({
  name: "InteractiveForm",
  description:
    "Interactive parameter simulator and triage form with live calculated preview and 1-click agent submission",
  props: z.object({
    title: z.string().describe("Form section title"),
    fields: z
      .array(
        z.union([FormSliderComp.ref, FormSwitchComp.ref, FormSelectComp.ref]),
      )
      .describe("Interactive form controls"),
    submitLabel: z.string().optional().describe("Submit button text"),
    promptTemplate: z
      .string()
      .optional()
      .describe("Prompt prefix sent to the assistant when submitted"),
  }),
  component: ({ props }) => {
    const isStreaming = useIsStreaming();
    const triggerAction = useTriggerAction();
    const rawFields = Array.isArray(props.fields) ? props.fields : [];

    const initialValues = useMemo(() => {
      const init: Record<string, string | number | boolean> = {};
      for (const f of rawFields as any[]) {
        const fp = f?.props ?? f ?? {};
        const typeName = f?.typeName;
        if (!fp.name) continue;
        if (typeName === "FormSlider" || typeof fp.min === "number") {
          init[fp.name] =
            typeof fp.defaultValue === "number"
              ? fp.defaultValue
              : Number(fp.min) || 0;
        } else if (
          typeName === "FormSwitch" ||
          typeof fp.defaultChecked === "boolean"
        ) {
          init[fp.name] = Boolean(fp.defaultChecked ?? true);
        } else if (Array.isArray(fp.options)) {
          init[fp.name] = fp.defaultValue ?? fp.options[0] ?? "";
        }
      }
      return init;
    }, [rawFields]);

    const [values, setValues] =
      useState<Record<string, string | number | boolean>>(initialValues);

    // Live simulation math when workload/cache fields exist
    const simulation = useMemo(() => {
      const reqs = Number(values.requests_per_day ?? 180);
      const cache = Number(values.cache_target ?? 70);
      const smartRoute = Boolean(values.smart_routing ?? true);
      if (!Number.isFinite(reqs) || !Number.isFinite(cache)) return null;
      const baseCostPerK = smartRoute ? 24 : 36;
      const cacheDiscount = 1 - Math.min(0.85, Math.max(0.1, cache / 100)) * 0.45;
      const monthlySpend = Math.round(reqs * baseCostPerK * cacheDiscount);
      const baselineSpend = Math.round(reqs * 36 * 0.82);
      const monthlySavings = Math.max(0, baselineSpend - monthlySpend);
      return { monthlySpend, monthlySavings };
    }, [values]);

    const handleSubmit = () => {
      const summaryPairs = Object.entries(values)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(", ");
      const prefix =
        props.promptTemplate || `Apply interactive parameters for ${props.title}`;
      const message = `${prefix} (${summaryPairs})`;
      void triggerAction(message, props.title, {
        type: "continue_conversation",
        params: { values, message },
      });
    };

    return (
      <div
        data-testid="openui-interactive-form"
        className="flex flex-col gap-3.5 rounded-xl border border-primary/25 bg-primary/[0.03] p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
            <SlidersHorizontalIcon className="size-3.5 text-primary" />
            <span>{props.title}</span>
          </div>
          {simulation ? (
            <div
              data-testid="openui-live-simulation"
              className="flex items-center gap-3 rounded-lg border border-border/70 bg-card px-2.5 py-1 text-xs"
            >
              <span className="text-muted-foreground">
                Simulated Spend:{" "}
                <strong
                  data-testid="openui-simulated-spend"
                  className="font-mono text-foreground"
                >
                  ${simulation.monthlySpend.toLocaleString()}/mo
                </strong>
              </span>
              <span className="text-emerald-600 dark:text-emerald-400 font-mono font-medium">
                Save ${simulation.monthlySavings.toLocaleString()}/mo
              </span>
            </div>
          ) : null}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {(rawFields as any[]).map((f, idx) => {
            const fp = f?.props ?? f ?? {};
            const name = fp.name || `field_${idx}`;
            const label = fp.label || name;
            const typeName = f?.typeName;

            if (typeName === "FormSlider" || typeof fp.min === "number") {
              const min = Number(fp.min ?? 0);
              const max = Number(fp.max ?? 100);
              const val = Number(values[name] ?? fp.defaultValue ?? min);
              return (
                <div
                  key={name}
                  className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-card p-3"
                >
                  <div className="flex items-center justify-between text-xs">
                    <label
                      htmlFor={`openui-slider-${name}`}
                      className="font-medium text-foreground"
                    >
                      {label}
                    </label>
                    <span
                      data-testid={`openui-slider-value-${name}`}
                      className="font-mono font-semibold text-primary"
                    >
                      {val}
                      {fp.unit ? ` ${fp.unit}` : ""}
                    </span>
                  </div>
                  <input
                    id={`openui-slider-${name}`}
                    data-testid={`openui-slider-${name}`}
                    type="range"
                    min={min}
                    max={max}
                    step={1}
                    disabled={isStreaming}
                    value={val}
                    aria-label={label}
                    onChange={(e) =>
                      setValues((prev) => ({
                        ...prev,
                        [name]: Number(e.target.value),
                      }))
                    }
                    className="h-1.5 w-full cursor-pointer accent-primary"
                  />
                </div>
              );
            }

            if (
              typeName === "FormSwitch" ||
              typeof fp.defaultChecked === "boolean"
            ) {
              const checked = Boolean(values[name] ?? fp.defaultChecked ?? true);
              return (
                <div
                  key={name}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card p-3 sm:col-span-2"
                >
                  <label
                    htmlFor={`openui-switch-${name}`}
                    className="text-xs font-medium text-foreground cursor-pointer"
                  >
                    {label}
                  </label>
                  <Switch
                    id={`openui-switch-${name}`}
                    data-testid={`openui-switch-${name}`}
                    checked={checked}
                    disabled={isStreaming}
                    aria-label={label}
                    onCheckedChange={(next) =>
                      setValues((prev) => ({ ...prev, [name]: Boolean(next) }))
                    }
                  />
                </div>
              );
            }

            const options: string[] = Array.isArray(fp.options) ? fp.options : [];
            const selected = String(values[name] ?? fp.defaultValue ?? "");
            return (
              <div
                key={name}
                className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-card p-3"
              >
                <label
                  htmlFor={`openui-select-${name}`}
                  className="text-xs font-medium text-foreground"
                >
                  {label}
                </label>
                <select
                  id={`openui-select-${name}`}
                  data-testid={`openui-select-${name}`}
                  value={selected}
                  disabled={isStreaming}
                  aria-label={label}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [name]: e.target.value }))
                  }
                  className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
                >
                  {options.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>

        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            disabled={isStreaming}
            data-testid="openui-form-submit"
            onClick={handleSubmit}
            className="h-8 gap-1.5 rounded-lg text-xs"
          >
            <span>{props.submitLabel || "Apply & Send to Agent"}</span>
            <ArrowRightIcon className="size-3.5" />
          </Button>
        </div>
      </div>
    );
  },
});

export const FollowUpItemComp = defineComponent({
  name: "FollowUpItem",
  description: "Clickable follow-up chip that sends a prompt back into chat",
  props: z.object({
    label: z.string().describe("Short chip text shown to the user"),
    prompt: z.string().describe("Full prompt sent to the assistant on click"),
  }),
  component: ({ props }) => {
    const isStreaming = useIsStreaming();
    const triggerAction = useTriggerAction();
    return (
      <button
        type="button"
        disabled={isStreaming}
        data-testid="openui-followup-chip"
        data-prompt={props.prompt}
        onClick={() =>
          void triggerAction(props.prompt, undefined, {
            type: "continue_conversation",
            params: { prompt: props.prompt },
          })
        }
        className="inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-muted/40 px-3 py-1.5 text-xs font-medium text-foreground transition-all hover:border-primary/50 hover:bg-primary/10 hover:text-primary disabled:opacity-50 cursor-pointer"
      >
        <span>{props.label}</span>
        <ArrowRightIcon className="size-3 opacity-70" />
      </button>
    );
  },
});

export const FollowUpBlockComp = defineComponent({
  name: "FollowUpBlock",
  description: "Row of clickable follow-up chips at the bottom of an OpenUI surface",
  props: z.object({
    items: z.array(FollowUpItemComp.ref).describe("Follow-up items"),
    title: z.string().optional().describe("Optional heading"),
  }),
  component: ({ props, renderNode }) => {
    const items = Array.isArray(props.items) ? props.items : [];
    if (items.length === 0) return null;
    return (
      <div
        data-testid="openui-followup-block"
        className="flex flex-col gap-2 border-t border-border/60 pt-3"
      >
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {props.title || "Suggested Next Actions"}
        </span>
        <div className="flex flex-wrap gap-2">
          {items.map((item, idx) => (
            <div key={idx}>{renderNode(item)}</div>
          ))}
        </div>
      </div>
    );
  },
});

export const StackComp = defineComponent({
  name: "Stack",
  description: "Root vertical container holding OpenUI surface blocks",
  props: z.object({
    children: z
      .array(
        z.union([
          CardHeaderComp.ref,
          MetricGridComp.ref,
          MetricComp.ref,
          BarChartComp.ref,
          LineChartComp.ref,
          PieChartComp.ref,
          DataTableComp.ref,
          TabsComp.ref,
          StepsComp.ref,
          CalloutComp.ref,
          InteractiveFormComp.ref,
          FollowUpBlockComp.ref,
        ]),
      )
      .describe("Ordered child blocks inside the stack"),
  }),
  component: ({ props, renderNode }) => {
    const children = Array.isArray(props.children) ? props.children : [];
    return (
      <div data-testid="openui-stack" className="flex flex-col gap-4">
        {children.map((child, idx) => (
          <div key={idx}>{renderNode(child)}</div>
        ))}
      </div>
    );
  },
});

export const amiroOpenUILibrary = createLibrary({
  root: "Stack",
  components: [
    StackComp,
    CardHeaderComp,
    MetricGridComp,
    MetricComp,
    ChartSeriesComp,
    BarChartComp,
    LineChartComp,
    PieSliceComp,
    PieChartComp,
    DataTableComp,
    TabItemComp,
    TabsComp,
    StepItemComp,
    StepsComp,
    CalloutComp,
    FormSliderComp,
    FormSwitchComp,
    FormSelectComp,
    InteractiveFormComp,
    FollowUpItemComp,
    FollowUpBlockComp,
  ],
});
