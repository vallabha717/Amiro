"use client";

import * as React from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
} from "recharts";
import { format, parseISO } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "ui/card";
import { Activity, Coins } from "lucide-react";

export interface DailyUsagePoint {
  date: string; // YYYY-MM-DD
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  totalCost?: number;
  promptCost?: number;
  completionCost?: number;
  messageCount: number;
}

interface UsageTimeSeriesChartProps {
  data: DailyUsagePoint[];
  periodLabel?: string;
  totalTokens: number;
  totalCost?: number;
}

function formatTokensAxis(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(0)}k`;
  return num.toString();
}

function formatDailyCost(amount: number | undefined | null): string {
  if (amount == null || isNaN(amount) || amount === 0) return "$0.00";
  if (amount < 0.001) return `$${amount.toFixed(5)}`;
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  if (amount < 1) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(2)}`;
}

export function UsageTimeSeriesChart({
  data,
  periodLabel = "Selected Period",
  totalTokens,
  totalCost,
}: UsageTimeSeriesChartProps) {
  const [chartType, setChartType] = React.useState<"area" | "bar">("area");

  const formattedData = React.useMemo(() => {
    return data.map((d) => {
      let label = d.date;
      try {
        label = format(parseISO(d.date), "MMM d");
      } catch {
        label = d.date;
      }
      return {
        ...d,
        displayDate: label,
      };
    });
  }, [data]);

  if (!data || data.length === 0) {
    return (
      <Card className="border bg-card/60">
        <CardHeader className="p-4 sm:p-5 pb-2">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Activity className="size-4 text-primary" />
            Daily Activity & Consumption Trend
          </CardTitle>
          <CardDescription className="text-xs">
            Daily breakdown over {periodLabel.toLowerCase()}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 sm:p-6 text-center text-xs text-muted-foreground py-12">
          No daily activity recorded for this date range.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border bg-card shadow-xs overflow-hidden" data-testid="usage-time-series-card">
      <CardHeader className="p-4 sm:p-5 pb-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <Activity className="size-4 text-primary" />
              Daily Consumption Trends
            </CardTitle>
            <CardDescription className="text-xs mt-0.5">
              Daily distribution of token volume and cost across the selected period
            </CardDescription>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-4 sm:p-5 pt-0">
        <div className="h-[240px] sm:h-[280px] w-full pt-4">
          <ResponsiveContainer width="100%" height="100%">
            {chartType === "area" ? (
              <AreaChart data={formattedData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="tokenGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--primary)" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="var(--primary)" stopOpacity={0.0} />
                  </linearGradient>
                  <linearGradient id="promptGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.15} />
                <XAxis
                  dataKey="displayDate"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  fontSize={11}
                  stroke="var(--muted-foreground)"
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  fontSize={11}
                  stroke="var(--muted-foreground)"
                  tickFormatter={formatTokensAxis}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (active && payload && payload.length) {
                      const p = payload[0].payload as DailyUsagePoint & { displayDate: string };
                      return (
                        <div className="bg-popover/95 backdrop-blur-md border rounded-lg p-3 shadow-lg text-xs space-y-1.5 min-w-[180px]">
                          <div className="font-semibold text-foreground border-b pb-1 flex justify-between items-center">
                            <span>{p.displayDate} ({p.date})</span>
                            {p.totalCost !== undefined && (
                              <span className="text-amber-600 dark:text-amber-400 font-bold">
                                {formatDailyCost(p.totalCost)}
                              </span>
                            )}
                          </div>
                          <div className="flex justify-between items-center text-muted-foreground">
                            <span>Total Tokens:</span>
                            <span className="font-semibold text-foreground">
                              {p.totalTokens.toLocaleString()}
                            </span>
                          </div>
                          <div className="flex justify-between items-center text-muted-foreground">
                            <span>Input Tokens:</span>
                            <span className="font-medium text-foreground">
                              {p.promptTokens.toLocaleString()}
                              {p.promptCost !== undefined && ` (${formatDailyCost(p.promptCost)})`}
                            </span>
                          </div>
                          <div className="flex justify-between items-center text-muted-foreground">
                            <span>Output Tokens:</span>
                            <span className="font-medium text-foreground">
                              {p.completionTokens.toLocaleString()}
                              {p.completionCost !== undefined && ` (${formatDailyCost(p.completionCost)})`}
                            </span>
                          </div>
                          <div className="flex justify-between items-center text-muted-foreground">
                            <span>Messages:</span>
                            <span className="font-medium text-foreground">{p.messageCount}</span>
                          </div>
                        </div>
                      );
                    }
                    return null;
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="totalTokens"
                  name="Total Tokens"
                  stroke="var(--primary)"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#tokenGradient)"
                />
                <Area
                  type="monotone"
                  dataKey="promptTokens"
                  name="Input Tokens"
                  stroke="#3b82f6"
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                  fillOpacity={1}
                  fill="url(#promptGradient)"
                />
              </AreaChart>
            ) : (
              <BarChart data={formattedData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.15} />
                <XAxis
                  dataKey="displayDate"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  fontSize={11}
                  stroke="var(--muted-foreground)"
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  fontSize={11}
                  stroke="var(--muted-foreground)"
                  tickFormatter={formatTokensAxis}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (active && payload && payload.length) {
                      const p = payload[0].payload as DailyUsagePoint & { displayDate: string };
                      return (
                        <div className="bg-popover/95 backdrop-blur-md border rounded-lg p-3 shadow-lg text-xs space-y-1.5 min-w-[180px]">
                          <div className="font-semibold text-foreground border-b pb-1 flex justify-between items-center">
                            <span>{p.displayDate} ({p.date})</span>
                            {p.totalCost !== undefined && (
                              <span className="text-amber-600 dark:text-amber-400 font-bold">
                                {formatDailyCost(p.totalCost)}
                              </span>
                            )}
                          </div>
                          <div className="flex justify-between items-center text-muted-foreground">
                            <span>Total Tokens:</span>
                            <span className="font-semibold text-foreground">
                              {p.totalTokens.toLocaleString()}
                            </span>
                          </div>
                          <div className="flex justify-between items-center text-muted-foreground">
                            <span>Input Tokens:</span>
                            <span className="font-medium text-foreground">
                              {p.promptTokens.toLocaleString()}
                              {p.promptCost !== undefined && ` (${formatDailyCost(p.promptCost)})`}
                            </span>
                          </div>
                          <div className="flex justify-between items-center text-muted-foreground">
                            <span>Output Tokens:</span>
                            <span className="font-medium text-foreground">
                              {p.completionTokens.toLocaleString()}
                              {p.completionCost !== undefined && ` (${formatDailyCost(p.completionCost)})`}
                            </span>
                          </div>
                          <div className="flex justify-between items-center text-muted-foreground">
                            <span>Messages:</span>
                            <span className="font-medium text-foreground">{p.messageCount}</span>
                          </div>
                        </div>
                      );
                    }
                    return null;
                  }}
                />
                <Bar dataKey="promptTokens" name="Input Tokens" stackId="a" fill="#3b82f6" radius={[0, 0, 0, 0]} />
                <Bar dataKey="completionTokens" name="Output Tokens" stackId="a" fill="var(--primary)" radius={[4, 4, 0, 0]} />
              </BarChart>
            )}
          </ResponsiveContainer>
        </div>

        {/* Footer Summary */}
        <div className="mt-3 pt-3 border-t flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-primary" />
              <span>
                Total Volume:{" "}
                <strong className="text-foreground">{totalTokens.toLocaleString()}</strong> tokens
              </span>
            </div>
            {totalCost !== undefined && (
              <div className="flex items-center gap-1.5">
                <Coins className="size-3 text-amber-500" />
                <span>
                  Total Spend:{" "}
                  <strong className="text-foreground">{formatDailyCost(totalCost)}</strong> USD
                </span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setChartType(chartType === "area" ? "bar" : "area")}
              className="text-[11px] font-medium text-primary hover:underline"
            >
              Switch to {chartType === "area" ? "Bar" : "Area"} chart
            </button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
