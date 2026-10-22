"use client";

import { AgentAvatar } from "./agent-avatar";
import { type TeamAgent } from "@/lib/backend/agents-api";
import { fetcher } from "lib/utils";
import {
  BarChart3,
  Brain,
  Coins,
  Cpu,
  Gauge,
  TrendingUp,
  UsersRound,
  Zap,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import useSWR from "swr";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "ui/card";
import { Skeleton } from "ui/skeleton";
import { cn } from "lib/utils";

export interface ModelUsageItem {
  model: string;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  messageCount: number;
  percentage: number;
}

export interface AgentUsageItem {
  agentId: string;
  agentName: string;
  role: string | null;
  instructions: string | null;
  traits: any;
  accentHex: string | null;
  customImageUrl: string | null;
  isMain: boolean;
  channelThreadId: string | null;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  totalCost: number;
  messageCount: number;
  threadCount: number;
  percentageOfTotal: number;
  models: ModelUsageItem[];
}

export interface SubscriptionLimitItem {
  name: string;
  usage_percent: number;
  resets_at: string | null;
  reset_in: string | null;
  provider: string;
}

export interface TeamUsageResponse {
  summary: {
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    totalCost: number;
    messageCount: number;
    threadCount: number;
    agentCount: number;
  };
  agents: AgentUsageItem[];
  subscriptionLimits: SubscriptionLimitItem[];
}

export function TeamUsageView() {
  const t = useTranslations("Team");
  const { data, error, isLoading } = useSWR<TeamUsageResponse>(
    "/api/team/usage",
    fetcher,
    { revalidateOnFocus: true },
  );

  if (isLoading) {
    return (
      <div className="flex h-full min-h-0 flex-col p-6 space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-96" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <p role="alert" className="text-sm text-destructive">
          {error.message || t("loadError")}
        </p>
      </div>
    );
  }

  const summary = data?.summary ?? {
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalCost: 0,
    messageCount: 0,
    threadCount: 0,
    agentCount: 0,
  };
  const agents = data?.agents ?? [];
  const subscriptionLimits = data?.subscriptionLimits ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4 md:p-6 space-y-6 custom-scrollbar">
      {/* View Header */}
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold tracking-tight text-foreground flex items-center gap-2">
              <BarChart3 className="size-5 text-primary" />
              Teams Usage
            </h1>
            <Badge variant="outline" className="text-xs font-normal">
              Live Metrics
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Token consumption, model breakdown, costs, and subscription quotas across all team agents
          </p>
        </div>
        <Button asChild size="sm" variant="outline" className="self-start sm:self-auto">
          <Link href="/team">Back to Agents</Link>
        </Button>
      </div>

      {/* Metric KPI cards */}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <Card className="bg-card/70 border-border/60">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs flex items-center gap-1.5 text-muted-foreground font-medium">
              <Zap className="size-3.5 text-amber-500" />
              Total Tokens
            </CardDescription>
            <CardTitle className="text-2xl font-bold tracking-tight">
              {summary.totalTokens.toLocaleString()}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-[11px] text-muted-foreground flex justify-between">
            <span>In: {summary.promptTokens.toLocaleString()}</span>
            <span>Out: {summary.completionTokens.toLocaleString()}</span>
          </CardContent>
        </Card>

        <Card className="bg-card/70 border-border/60">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs flex items-center gap-1.5 text-muted-foreground font-medium">
              <Coins className="size-3.5 text-emerald-500" />
              Estimated Spend
            </CardDescription>
            <CardTitle className="text-2xl font-bold tracking-tight">
              ${summary.totalCost.toFixed(2)}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-[11px] text-muted-foreground">
            Known API spend & token usage
          </CardContent>
        </Card>

        <Card className="bg-card/70 border-border/60">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs flex items-center gap-1.5 text-muted-foreground font-medium">
              <UsersRound className="size-3.5 text-blue-500" />
              Active Agents
            </CardDescription>
            <CardTitle className="text-2xl font-bold tracking-tight">
              {agents.length}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-[11px] text-muted-foreground">
            {summary.threadCount} threads · {summary.messageCount} turns
          </CardContent>
        </Card>

        <Card className="bg-card/70 border-border/60">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs flex items-center gap-1.5 text-muted-foreground font-medium">
              <Gauge className="size-3.5 text-purple-500" />
              Quotas Tracked
            </CardDescription>
            <CardTitle className="text-2xl font-bold tracking-tight">
              {subscriptionLimits.length}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-[11px] text-muted-foreground">
            Active subscription limits
          </CardContent>
        </Card>
      </div>

      {/* Share of Team Usage Multi-Bar */}
      {summary.totalTokens > 0 && (
        <Card className="bg-card/70 border-border/60 p-4">
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <TrendingUp className="size-4 text-primary" />
            Share of Team Token Usage
          </h2>
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted/60">
            {agents.map((agent) => {
              if (agent.percentageOfTotal <= 0) return null;
              return (
                <div
                  key={agent.agentId}
                  title={`${agent.agentName}: ${agent.percentageOfTotal}%`}
                  style={{
                    width: `${agent.percentageOfTotal}%`,
                    backgroundColor: agent.accentHex || "var(--primary)",
                  }}
                  className="h-full transition-all duration-300"
                />
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap gap-4 text-xs">
            {agents.map((agent) => (
              <div key={agent.agentId} className="flex items-center gap-1.5">
                <span
                  className="size-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: agent.accentHex || "var(--primary)" }}
                />
                <span className="font-medium">{agent.agentName}</span>
                <span className="text-muted-foreground">({agent.percentageOfTotal}%)</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Subscription Limits / Quotas Section */}
      {subscriptionLimits.length > 0 && (
        <Card className="bg-card/70 border-border/60 p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <Gauge className="size-4 text-purple-500" />
                Subscription Quotas & Rate Limits
              </h2>
              <p className="text-xs text-muted-foreground">
                Live provider window occupancy and time remaining until quota reset
              </p>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {subscriptionLimits.slice(0, 6).map((lim, index) => {
              const isHigh = lim.usage_percent >= 80;
              const isMed = lim.usage_percent >= 50 && lim.usage_percent < 80;
              return (
                <div
                  key={`${lim.provider}-${lim.name}-${index}`}
                  className="rounded-lg border border-border/50 bg-background/50 p-3 space-y-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs font-medium truncate" title={lim.name}>
                      {lim.name || lim.provider}
                    </span>
                    <Badge
                      variant="secondary"
                      className={
                        isHigh
                          ? "bg-destructive/15 text-destructive border-destructive/20 text-[10px]"
                          : isMed
                            ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/20 text-[10px]"
                            : "text-[10px]"
                      }
                    >
                      {lim.usage_percent.toFixed(1)}% used
                    </Badge>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60">
                    <div
                      className={cn(
                        "h-full transition-all duration-300",
                        isHigh
                          ? "bg-destructive"
                          : isMed
                            ? "bg-amber-500"
                            : "bg-primary",
                      )}
                      style={{ width: `${Math.min(100, Math.max(0, lim.usage_percent))}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] text-muted-foreground">
                    <span>{lim.provider}</span>
                    {lim.reset_in && <span>Resets in {lim.reset_in}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Per-Agent Usage Breakdown */}
      <div className="space-y-4">
        <h2 className="text-sm font-semibold flex items-center gap-2 text-foreground">
          <Brain className="size-4 text-primary" />
          Agent Usage Breakdown
        </h2>

        <div className="grid gap-4 lg:grid-cols-2">
          {agents.map((agent) => (
            <Card key={agent.agentId} className="bg-card/70 border-border/60 overflow-hidden">
              <CardHeader className="p-4 pb-3 border-b border-border/40 bg-muted/20">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <AgentAvatar
                      agent={{
                        id: agent.agentId,
                        name: agent.agentName,
                        traits: agent.traits,
                        customImageUrl: agent.customImageUrl,
                      } as TeamAgent}
                      size={36}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-sm truncate">{agent.agentName}</span>
                        {agent.isMain ? (
                          <Badge variant="outline" className="text-[10px] py-0 px-1.5">
                            Main
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-[10px] py-0 px-1.5">
                            Agent
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
                        {agent.role || "General agent"}
                      </p>
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <div className="text-base font-bold tabular-nums">
                      {agent.totalTokens.toLocaleString()}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {agent.percentageOfTotal}% of team tokens
                    </div>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="p-4 space-y-3">
                <div className="grid grid-cols-3 gap-2 text-center py-1 bg-muted/20 rounded-lg">
                  <div>
                    <span className="text-[10px] text-muted-foreground block">Prompt Tokens</span>
                    <span className="text-xs font-semibold tabular-nums">
                      {agent.promptTokens.toLocaleString()}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-muted-foreground block">Completion</span>
                    <span className="text-xs font-semibold tabular-nums">
                      {agent.completionTokens.toLocaleString()}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-muted-foreground block">Est. Cost</span>
                    <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">
                      ${agent.totalCost.toFixed(2)}
                    </span>
                  </div>
                </div>

                {/* Models used by this agent */}
                <div className="space-y-1.5 pt-1">
                  <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                    <Cpu className="size-3" />
                    Models Used
                  </span>
                  {agent.models.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic">
                      No turns completed yet with this agent
                    </p>
                  ) : (
                    <div className="space-y-1">
                      {agent.models.map((mod) => (
                        <div
                          key={mod.model}
                          className="flex items-center justify-between text-xs py-1 px-2 rounded-md bg-background/60 border border-border/30"
                        >
                          <span className="font-mono text-[11px] truncate max-w-[55%]">
                            {mod.model}
                          </span>
                          <div className="flex items-center gap-2 tabular-nums text-muted-foreground text-[11px]">
                            <span>{mod.tokens.toLocaleString()} tok</span>
                            <Badge variant="outline" className="text-[10px] py-0 px-1">
                              {mod.percentage}%
                            </Badge>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
