"use client";

import { useState, useMemo } from "react";
import useSWR from "swr";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "ui/card";
import { Alert, AlertDescription } from "ui/alert";
import { Badge } from "ui/badge";
import { Tabs, TabsList, TabsTrigger } from "ui/tabs";
import { Input } from "ui/input";
import { Button } from "ui/button";
import {
  MessageCircle,
  Coins,
  TrendingUp,
  Cpu,
  Boxes,
  CheckCircle2,
  AlertCircle,
  ArrowUpRight,
  ArrowDownLeft,
  Sparkles,
  Search,
  FileSpreadsheet,
  ArrowDownToLine,
  Check,
  ChevronsUpDown,
  X,
  RotateCcw,
  CircleDollarSign,
  Info,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "ui/command";
import { PieChart } from "@/components/tool-invocation/pie-chart";
import { ModelProviderIcon } from "ui/model-provider-icon";
import { useChatModels } from "@/hooks/queries/use-chat-models";
import {
  PROVIDERS_KEY,
  selectProviders,
  type ProviderConfig,
} from "@/lib/backend/provider-api";
import {
  UsageTimeSeriesChart,
  type DailyUsagePoint,
} from "./usage-time-series-chart";

export interface UserStatsData {
  threadCount: number;
  messageCount: number;
  modelStats: Array<{
    model: string;
    messageCount: number;
    totalTokens: number;
    promptTokens?: number;
    completionTokens?: number;
    totalCost?: number;
    promptCost?: number;
    completionCost?: number;
    provider: string;
  }>;
  totalTokens: number;
  promptTokens?: number;
  completionTokens?: number;
  totalCost?: number;
  promptCost?: number;
  completionCost?: number;
  dailyUsage?: Array<{
    date: string;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    totalCost?: number;
    promptCost?: number;
    completionCost?: number;
    messageCount: number;
  }>;
  period: string;
  /** Optional backend note about how trustworthy/attributable the numbers
   * are (e.g. shared provider-account totals). Rendered verbatim when set. */
  usageNotice?: string;
}

interface UserStatisticsCardProps {
  stats: UserStatsData;
  view?: "admin" | "user";
}

const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google Gemini",
  openrouter: "OpenRouter",
  groq: "Groq",
  xai: "xAI (Grok)",
  ollama: "Ollama",
  azure: "Azure OpenAI",
  deepseek: "DeepSeek",
  mistral: "Mistral AI",
  together: "Together AI",
  cohere: "Cohere",
  bedrock: "AWS Bedrock",
};

export function getProviderDisplayName(providerId: string): string {
  const normalized = (providerId || "").toLowerCase();
  return PROVIDER_NAMES[normalized] || providerId || "Other";
}

export function formatCost(amount: number | undefined | null): string {
  if (amount == null || isNaN(amount)) return "$0.00";
  if (amount === 0) return "$0.00";
  if (amount < 0.001) return `$${amount.toFixed(5)}`;
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  if (amount < 1) return `$${amount.toFixed(3)}`;
  return `$${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Infers provider type and display name from model name if provider is missing.
 */
function inferProviderFromModel(modelName: string): {
  providerType: string;
  name: string;
} {
  const m = (modelName || "").toLowerCase();
  if (
    m.includes("gpt") ||
    m.includes("o1") ||
    m.includes("o3") ||
    m.includes("o4") ||
    m.includes("text-embedding") ||
    m.includes("dall-e") ||
    m.includes("chatgpt")
  ) {
    return { providerType: "openai", name: "OpenAI" };
  }
  if (m.includes("claude") || m.includes("anthropic") || m.includes("sonnet") || m.includes("haiku") || m.includes("opus")) {
    return { providerType: "anthropic", name: "Anthropic" };
  }
  if (m.includes("gemini") || m.includes("palm") || m.includes("gemma")) {
    return { providerType: "google", name: "Google Gemini" };
  }
  if (m.includes("grok") || m.includes("xai")) {
    return { providerType: "xai", name: "xAI (Grok)" };
  }
  if (m.includes("groq")) {
    return { providerType: "groq", name: "Groq" };
  }
  if (
    m.includes("llama") ||
    m.includes("mixtral") ||
    m.includes("mistral") ||
    m.includes("qwen") ||
    m.includes("deepseek") ||
    m.includes("hermes") ||
    m.includes("nous")
  ) {
    return { providerType: "openrouter", name: "OpenRouter" };
  }
  if (m.includes("ollama")) {
    return { providerType: "ollama", name: "Ollama" };
  }
  return { providerType: "openai", name: "AI Provider" };
}

export function UserStatisticsCard({ stats, view = "admin" }: UserStatisticsCardProps) {
  const [activeTab, setActiveTab] = useState<"models" | "providers">("models");
  const [chartMetric, setChartMetric] = useState<"cost" | "tokens">("cost");
  const [providerStatusFilter, setProviderStatusFilter] = useState<"all" | "configured" | "used">("all");
  const [selectedModel, setSelectedModel] = useState<string>("all");
  const [selectedProvider, setSelectedProvider] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Popover open states
  const [modelFilterOpen, setModelFilterOpen] = useState(false);
  const [providerFilterOpen, setProviderFilterOpen] = useState(false);

  // Fetch configured providers
  const { data: configuredProviders = [] } = useSWR<ProviderConfig[]>(
    PROVIDERS_KEY,
    selectProviders,
    { fallbackData: [], revalidateOnFocus: false },
  );

  // Fetch active chat models
  const { data: chatModelsProviders = [] } = useChatModels();

  // Granular Token Breakdown
  const totalPromptTokens =
    stats.promptTokens ??
    (stats.modelStats || []).reduce((acc, m) => acc + (m.promptTokens ?? 0), 0);
  const totalCompletionTokens =
    stats.completionTokens ??
    (stats.modelStats || []).reduce((acc, m) => acc + (m.completionTokens ?? 0), 0);

  const promptPercent =
    stats.totalTokens > 0
      ? Math.round((totalPromptTokens / stats.totalTokens) * 100)
      : 0;
  const completionPercent =
    stats.totalTokens > 0
      ? Math.round((totalCompletionTokens / stats.totalTokens) * 100)
      : 0;

  // Granular Cost Breakdown
  const totalCost =
    stats.totalCost ??
    (stats.modelStats || []).reduce((acc, m) => acc + (m.totalCost ?? 0), 0);
  const totalPromptCost =
    stats.promptCost ??
    (stats.modelStats || []).reduce((acc, m) => acc + (m.promptCost ?? 0), 0);
  const totalCompletionCost =
    stats.completionCost ??
    (stats.modelStats || []).reduce((acc, m) => acc + (m.completionCost ?? 0), 0);

  const avgCostPerMsg = stats.messageCount > 0 ? totalCost / stats.messageCount : 0;

  // Enrich model stats with token and cost splits
  const enrichedModelStats = useMemo(() => {
    return (stats.modelStats || []).map((m) => {
      const pTokens = m.promptTokens ?? Math.round(m.totalTokens * 0.6);
      const cTokens = m.completionTokens ?? m.totalTokens - pTokens;
      const mTotalCost = m.totalCost ?? 0;
      const mPromptCost = m.promptCost ?? 0;
      const mCompletionCost = m.completionCost ?? 0;
      const inferred = inferProviderFromModel(m.model);
      const providerKey =
        m.provider && !m.provider.includes("-") ? m.provider : inferred.providerType;
      return {
        ...m,
        promptTokens: pTokens,
        completionTokens: cTokens,
        totalCost: mTotalCost,
        promptCost: mPromptCost,
        completionCost: mCompletionCost,
        providerKey,
        providerName: getProviderDisplayName(providerKey),
      };
    });
  }, [stats.modelStats]);

  // All unique models list for dropdown filter
  const allUniqueModels = useMemo(() => {
    return [...enrichedModelStats].sort((a, b) => b.totalTokens - a.totalTokens);
  }, [enrichedModelStats]);

  // Provider Usage Aggregation
  const providerStatsList = useMemo(() => {
    type ProviderEntry = {
      id: string;
      provider: string;
      name: string;
      messageCount: number;
      totalTokens: number;
      promptTokens: number;
      completionTokens: number;
      totalCost: number;
      promptCost: number;
      completionCost: number;
      models: Set<string>;
      configured: boolean;
    };

    const entriesMap = new Map<string, ProviderEntry>();

    // 1. Register configured providers
    for (const cp of configuredProviders) {
      const entryKey = cp.id || cp.provider;
      const pType = (cp.provider || "openai").toLowerCase();
      entriesMap.set(entryKey, {
        id: entryKey,
        provider: pType,
        name: cp.name || getProviderDisplayName(cp.provider),
        messageCount: 0,
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalCost: 0,
        promptCost: 0,
        completionCost: 0,
        models: new Set<string>(cp.models || []),
        configured: cp.configured ?? true,
      });
    }

    // 2. Register providers from useChatModels
    for (const cmp of chatModelsProviders) {
      if (!entriesMap.has(cmp.provider)) {
        const pType = (cmp.providerType || "openai").toLowerCase();
        entriesMap.set(cmp.provider, {
          id: cmp.provider,
          provider: pType,
          name: cmp.providerName || getProviderDisplayName(cmp.providerType),
          messageCount: 0,
          totalTokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalCost: 0,
          promptCost: 0,
          completionCost: 0,
          models: new Set<string>(cmp.models.map((m) => m.name)),
          configured: cmp.hasAPIKey ?? true,
        });
      }
    }

    // 3. Map model stats to providers
    for (const ms of enrichedModelStats) {
      const rawProvider = ms.provider || "";
      let targetEntry = entriesMap.get(rawProvider);

      if (!targetEntry) {
        for (const entry of entriesMap.values()) {
          if (
            entry.provider.toLowerCase() === rawProvider.toLowerCase() ||
            entry.name.toLowerCase() === rawProvider.toLowerCase()
          ) {
            targetEntry = entry;
            break;
          }
        }
      }

      if (!targetEntry) {
        const inferred = inferProviderFromModel(ms.model);
        for (const entry of entriesMap.values()) {
          if (entry.provider.toLowerCase() === inferred.providerType.toLowerCase()) {
            targetEntry = entry;
            break;
          }
        }

        if (!targetEntry) {
          targetEntry = {
            id: rawProvider || inferred.providerType,
            provider: inferred.providerType,
            name: inferred.name,
            messageCount: 0,
            totalTokens: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalCost: 0,
            promptCost: 0,
            completionCost: 0,
            models: new Set<string>(),
            configured: false,
          };
          entriesMap.set(targetEntry.id, targetEntry);
        }
      }

      targetEntry.messageCount += ms.messageCount;
      targetEntry.totalTokens += ms.totalTokens;
      targetEntry.promptTokens += ms.promptTokens;
      targetEntry.completionTokens += ms.completionTokens;
      targetEntry.totalCost += ms.totalCost;
      targetEntry.promptCost += ms.promptCost;
      targetEntry.completionCost += ms.completionCost;
      if (ms.model) {
        targetEntry.models.add(ms.model);
      }
    }

    const list = Array.from(entriesMap.values()).map((p) => ({
      ...p,
      modelCount: p.models.size,
    }));

    list.sort((a, b) => {
      if (b.totalCost !== a.totalCost) return b.totalCost - a.totalCost;
      if (b.totalTokens !== a.totalTokens) return b.totalTokens - a.totalTokens;
      if (b.configured !== a.configured) return (b.configured ? 1 : 0) - (a.configured ? 1 : 0);
      return a.name.localeCompare(b.name);
    });

    return list;
  }, [configuredProviders, chatModelsProviders, enrichedModelStats]);

  // Filtered Model Stats based on active filters and search
  const filteredModelStats = useMemo(() => {
    return enrichedModelStats.filter((m) => {
      // 1. Model combobox filter
      if (selectedModel !== "all" && m.model !== selectedModel) {
        return false;
      }
      // 2. Provider combobox filter
      if (selectedProvider !== "all") {
        const matchesProvKey = m.providerKey.toLowerCase() === selectedProvider.toLowerCase();
        const matchesProvRaw = (m.provider || "").toLowerCase() === selectedProvider.toLowerCase();
        if (!matchesProvKey && !matchesProvRaw) {
          return false;
        }
      }
      // 3. Search text filter
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchesName = m.model.toLowerCase().includes(q);
        const matchesProvider = m.providerName.toLowerCase().includes(q) || (m.provider || "").toLowerCase().includes(q);
        if (!matchesName && !matchesProvider) return false;
      }
      return true;
    });
  }, [enrichedModelStats, selectedModel, selectedProvider, searchQuery]);

  // Filtered Provider List based on active filters and search
  const filteredProviderStats = useMemo(() => {
    return providerStatsList.filter((p) => {
      // 1. Provider combobox filter
      if (selectedProvider !== "all" && p.provider !== selectedProvider && p.id !== selectedProvider) {
        return false;
      }
      // 2. Search text filter
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        if (!p.name.toLowerCase().includes(q) && !p.provider.toLowerCase().includes(q)) {
          return false;
        }
      }
      // 3. Provider status filter
      if (providerStatusFilter === "configured") return p.configured;
      if (providerStatusFilter === "used") return p.totalTokens > 0 || p.messageCount > 0 || p.totalCost > 0;
      return true;
    });
  }, [providerStatsList, selectedProvider, searchQuery, providerStatusFilter]);

  // Daily usage points
  const dailyUsagePoints: DailyUsagePoint[] = useMemo(() => {
    return (stats.dailyUsage || []).map((d) => ({ ...d }));
  }, [stats.dailyUsage]);

  // Pie chart datasets: Toggle between Cost and Tokens
  const modelPieData = useMemo(() => {
    const sorted = [...filteredModelStats].sort((a, b) =>
      chartMetric === "cost" ? b.totalCost - a.totalCost : b.totalTokens - a.totalTokens
    );
    const top5 = sorted.slice(0, 5);
    return top5.map((m) => ({
      label: m.model,
      value: chartMetric === "cost" ? Number((m.totalCost || 0).toFixed(4)) : m.totalTokens,
    }));
  }, [filteredModelStats, chartMetric]);

  const providerPieData = useMemo(() => {
    const active = filteredProviderStats.filter((p) =>
      chartMetric === "cost" ? p.totalCost > 0 : p.totalTokens > 0
    );
    const sorted = [...active].sort((a, b) =>
      chartMetric === "cost" ? b.totalCost - a.totalCost : b.totalTokens - a.totalTokens
    );
    const top5 = sorted.slice(0, 5);
    return top5.map((p) => ({
      label: p.name,
      value: chartMetric === "cost" ? Number((p.totalCost || 0).toFixed(4)) : p.totalTokens,
    }));
  }, [filteredProviderStats, chartMetric]);

  const configuredCount = providerStatsList.filter((p) => p.configured).length;
  const activeProvidersCount = providerStatsList.filter((p) => p.totalTokens > 0 || p.totalCost > 0).length;

  const hasActiveFilters = selectedModel !== "all" || selectedProvider !== "all" || searchQuery.trim() !== "";

  const handleResetFilters = () => {
    setSelectedModel("all");
    setSelectedProvider("all");
    setSearchQuery("");
    setProviderStatusFilter("all");
  };

  // Export handlers with Cost Metrics
  const handleExportCSV = () => {
    const headers = [
      "Model",
      "Provider",
      "Message Count",
      "Input Tokens",
      "Output Tokens",
      "Total Tokens",
      "Input Cost (USD)",
      "Output Cost (USD)",
      "Total Cost (USD)",
    ];
    const rows = filteredModelStats.map((m) => [
      `"${m.model}"`,
      `"${m.providerName}"`,
      m.messageCount,
      m.promptTokens,
      m.completionTokens,
      m.totalTokens,
      (m.promptCost || 0).toFixed(6),
      (m.completionCost || 0).toFixed(6),
      (m.totalCost || 0).toFixed(6),
    ]);

    const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `amiro-usage-report-${stats.period.replace(/\s+/g, "_")}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleExportJSON = () => {
    const dataToExport = {
      period: stats.period,
      summary: {
        totalCost: totalCost,
        promptCost: totalPromptCost,
        completionCost: totalCompletionCost,
        totalTokens: stats.totalTokens,
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        threadCount: stats.threadCount,
        messageCount: stats.messageCount,
      },
      models: filteredModelStats,
      providers: filteredProviderStats,
      dailyUsage: dailyUsagePoints,
    };
    const blob = new Blob([JSON.stringify(dataToExport, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `amiro-usage-${stats.period.replace(/\s+/g, "_")}.json`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-6" data-testid="user-statistics-card">
      {stats.usageNotice && (
        <Alert data-testid="usage-notice">
          <Info />
          <AlertDescription>{stats.usageNotice}</AlertDescription>
        </Alert>
      )}

      {/* 1. Hero Metrics Grid: Input Tokens, Output Tokens, Estimated Cost (USD), and Conversations */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Card 1: Input Tokens (Prompt) */}
        <Card className="border bg-gradient-to-br from-card to-blue-500/5 shadow-xs relative overflow-hidden">
          <div className="absolute right-0 top-0 translate-x-2 -translate-y-2 opacity-5 pointer-events-none text-blue-500">
            <ArrowDownLeft className="size-28" />
          </div>
          <CardContent className="p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Input Tokens
              </span>
              <div className="size-8 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-500">
                <ArrowDownLeft className="size-4" />
              </div>
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl sm:text-3xl font-extrabold tracking-tight text-foreground">
                {totalPromptTokens.toLocaleString()}
              </span>
              <span className="text-xs text-muted-foreground font-medium">prompt</span>
            </div>
            <div className="mt-3 pt-2.5 border-t flex items-center justify-between text-[11px] text-muted-foreground">
              <span>
                Share: <strong className="text-foreground">{promptPercent}%</strong> of total
              </span>
              <span>•</span>
              <span className="text-blue-600 dark:text-blue-400 font-medium">Inbound</span>
            </div>
          </CardContent>
        </Card>

        {/* Card 2: Output Tokens (Completion) */}
        <Card className="border bg-gradient-to-br from-card to-emerald-500/5 shadow-xs relative overflow-hidden">
          <div className="absolute right-0 top-0 translate-x-2 -translate-y-2 opacity-5 pointer-events-none text-emerald-500">
            <ArrowUpRight className="size-28" />
          </div>
          <CardContent className="p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Output Tokens
              </span>
              <div className="size-8 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-500">
                <ArrowUpRight className="size-4" />
              </div>
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl sm:text-3xl font-extrabold tracking-tight text-foreground">
                {totalCompletionTokens.toLocaleString()}
              </span>
              <span className="text-xs text-muted-foreground font-medium">completion</span>
            </div>
            <div className="mt-3 pt-2.5 border-t flex items-center justify-between text-[11px] text-muted-foreground">
              <span>
                Share: <strong className="text-foreground">{completionPercent}%</strong> of total
              </span>
              <span>•</span>
              <span className="text-emerald-600 dark:text-emerald-400 font-medium">Generated</span>
            </div>
          </CardContent>
        </Card>

        {/* Card 3: Estimated Cost (USD) - REPLACED Total Volume */}
        <Card className="border bg-gradient-to-br from-card via-amber-500/5 to-amber-500/10 shadow-xs relative overflow-hidden">
          <div className="absolute right-0 top-0 translate-x-2 -translate-y-2 opacity-5 pointer-events-none text-amber-500">
            <CircleDollarSign className="size-28" />
          </div>
          <CardContent className="p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Estimated Cost
              </span>
              <div className="size-8 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-600 dark:text-amber-400">
                <Coins className="size-4" />
              </div>
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl sm:text-3xl font-extrabold tracking-tight text-foreground">
                {formatCost(totalCost)}
              </span>
              <span className="text-xs text-muted-foreground font-medium">USD</span>
            </div>
            <div className="mt-3 pt-2.5 border-t flex items-center justify-between text-[11px] text-muted-foreground">
              <span>
                Avg/Msg: <strong className="text-foreground">{formatCost(avgCostPerMsg)}</strong>
              </span>
              <span>•</span>
              <span className="text-amber-600 dark:text-amber-400 font-medium">
                In: {formatCost(totalPromptCost)} | Out: {formatCost(totalCompletionCost)}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Card 4: Conversations & AI Models */}
        <Card className="border bg-card shadow-xs">
          <CardContent className="p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Conversations
              </span>
              <div className="size-8 rounded-lg bg-muted flex items-center justify-center text-muted-foreground">
                <MessageCircle className="size-4" />
              </div>
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl sm:text-3xl font-extrabold tracking-tight">
                {stats.messageCount}
              </span>
              <span className="text-xs text-muted-foreground font-medium">messages</span>
            </div>
            <div className="mt-3 pt-2.5 border-t flex items-center justify-between text-[11px] text-muted-foreground">
              <span>
                Threads: <strong className="text-foreground">{stats.threadCount}</strong>
              </span>
              <span>•</span>
              <span>
                Models: <strong className="text-foreground">{stats.modelStats?.length || 0}</strong>
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 2. Daily Consumption Time-Series Chart */}
      {dailyUsagePoints.length > 0 && (
        <UsageTimeSeriesChart
          data={dailyUsagePoints}
          periodLabel={stats.period}
          totalTokens={stats.totalTokens}
          totalCost={totalCost}
        />
      )}

      {/* 3. Detailed Breakdown Section with Searchable Filters & Cost Metrics */}
      <Card className="border shadow-xs">
        <CardHeader className="p-4 sm:p-6 pb-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <CardTitle className="text-lg font-bold flex items-center gap-2">
                <TrendingUp className="size-5 text-primary" />
                Cost & Usage Attribution
              </CardTitle>
              <CardDescription className="text-xs mt-0.5">
                Model-wise and provider-wise cost and token breakdown for {stats.period.toLowerCase()}
              </CardDescription>
            </div>

            {/* View Mode, Metric Toggle, & Export Tools */}
            <div className="flex flex-wrap items-center gap-2">
              {/* Models vs Providers View */}
              <Tabs
                value={activeTab}
                onValueChange={(val) => setActiveTab(val as "models" | "providers")}
                className="h-8"
              >
                <TabsList className="grid grid-cols-2 h-8 p-0.5 bg-muted/80">
                  <TabsTrigger value="models" className="text-xs font-semibold px-2.5 h-7">
                    <Cpu className="size-3.5 mr-1" />
                    Models ({filteredModelStats.length})
                  </TabsTrigger>
                  <TabsTrigger value="providers" className="text-xs font-semibold px-2.5 h-7">
                    <Boxes className="size-3.5 mr-1" />
                    Providers ({filteredProviderStats.length})
                  </TabsTrigger>
                </TabsList>
              </Tabs>

              {/* Metric Mode Toggle: Cost ($) vs Tokens */}
              <div className="flex items-center bg-muted/80 p-0.5 rounded-lg border text-xs h-8">
                <button
                  type="button"
                  onClick={() => setChartMetric("cost")}
                  className={`px-2 py-1 rounded-md transition-colors text-xs flex items-center gap-1 ${
                    chartMetric === "cost"
                      ? "bg-amber-500/20 text-amber-700 dark:text-amber-300 font-semibold shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  title="View chart by Cost ($)"
                >
                  <Coins className="size-3" />
                  Cost ($)
                </button>
                <button
                  type="button"
                  onClick={() => setChartMetric("tokens")}
                  className={`px-2 py-1 rounded-md transition-colors text-xs flex items-center gap-1 ${
                    chartMetric === "tokens"
                      ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  title="View chart by Token volume"
                >
                  Tokens
                </button>
              </div>

              {/* Export Data */}
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleExportCSV}
                  className="h-8 text-xs gap-1"
                  title="Export report with cost columns as CSV"
                >
                  <FileSpreadsheet className="size-3.5" />
                  <span className="hidden sm:inline">CSV</span>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleExportJSON}
                  className="h-8 text-xs gap-1"
                  title="Export raw JSON with token and cost metrics"
                >
                  <ArrowDownToLine className="size-3.5" />
                  <span className="hidden sm:inline">JSON</span>
                </Button>
              </div>
            </div>
          </div>

          {/* Interactive Search & Combobox Filter Toolbar */}
          <div className="mt-4 pt-3 border-t flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3">
            {/* Live Search Input */}
            <div className="relative flex-1 max-w-md">
              <Search className="size-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="Search models or providers..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-9 text-xs pl-8 pr-8 bg-background"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>

            {/* Filter Dropdown Popovers */}
            <div className="flex flex-wrap items-center gap-2">
              {/* 1. Model Combobox Filter */}
              <Popover open={modelFilterOpen} onOpenChange={setModelFilterOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    size="sm"
                    aria-expanded={modelFilterOpen}
                    className="h-9 text-xs justify-between gap-2 max-w-[200px] bg-background font-normal"
                  >
                    <div className="flex items-center gap-1.5 truncate">
                      <Cpu className="size-3.5 text-primary shrink-0" />
                      <span className="truncate">
                        {selectedModel === "all"
                          ? `All Models (${allUniqueModels.length})`
                          : selectedModel}
                      </span>
                    </div>
                    <ChevronsUpDown className="size-3.5 opacity-50 shrink-0" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[280px] p-0" align="end">
                  <Command>
                    <CommandInput placeholder="Search models as you type..." className="h-9 text-xs" />
                    <CommandList className="max-h-64">
                      <CommandEmpty className="py-4 text-center text-xs text-muted-foreground">
                        No models found.
                      </CommandEmpty>
                      <CommandGroup heading="Filter by Model">
                        <CommandItem
                          value="all all models"
                          onSelect={() => {
                            setSelectedModel("all");
                            setModelFilterOpen(false);
                          }}
                          className="text-xs flex items-center justify-between cursor-pointer"
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-semibold">All Models</span>
                            <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4">
                              {allUniqueModels.length}
                            </Badge>
                          </div>
                          {selectedModel === "all" && <Check className="size-3.5 text-primary shrink-0" />}
                        </CommandItem>

                        {allUniqueModels.map((m) => {
                          const isSelected = selectedModel === m.model;
                          return (
                            <CommandItem
                              key={m.model}
                              value={`${m.model} ${m.providerName}`}
                              onSelect={() => {
                                setSelectedModel(m.model);
                                setModelFilterOpen(false);
                              }}
                              className="text-xs flex items-center justify-between py-2 cursor-pointer"
                            >
                              <div className="flex items-center gap-2 truncate pr-2">
                                <div className="size-6 rounded bg-muted/60 flex items-center justify-center shrink-0 border">
                                  <ModelProviderIcon provider={m.providerKey} className="size-3" />
                                </div>
                                <div className="flex flex-col truncate">
                                  <span className="font-medium truncate">{m.model}</span>
                                  <span className="text-[10px] text-muted-foreground truncate">
                                    {formatCost(m.totalCost)} • {m.totalTokens.toLocaleString()} toks
                                  </span>
                                </div>
                              </div>
                              {isSelected && <Check className="size-3.5 text-primary shrink-0 ml-1" />}
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>

              {/* 2. Provider Combobox Filter */}
              <Popover open={providerFilterOpen} onOpenChange={setProviderFilterOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    size="sm"
                    aria-expanded={providerFilterOpen}
                    className="h-9 text-xs justify-between gap-2 max-w-[200px] bg-background font-normal"
                  >
                    <div className="flex items-center gap-1.5 truncate">
                      <Boxes className="size-3.5 text-primary shrink-0" />
                      <span className="truncate">
                        {selectedProvider === "all"
                          ? `All Providers (${providerStatsList.length})`
                          : getProviderDisplayName(selectedProvider)}
                      </span>
                    </div>
                    <ChevronsUpDown className="size-3.5 opacity-50 shrink-0" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[280px] p-0" align="end">
                  <Command>
                    <CommandInput placeholder="Search providers as you type..." className="h-9 text-xs" />
                    <CommandList className="max-h-64">
                      <CommandEmpty className="py-4 text-center text-xs text-muted-foreground">
                        No providers found.
                      </CommandEmpty>
                      <CommandGroup heading="Filter by Provider">
                        <CommandItem
                          value="all all providers"
                          onSelect={() => {
                            setSelectedProvider("all");
                            setProviderFilterOpen(false);
                          }}
                          className="text-xs flex items-center justify-between cursor-pointer"
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-semibold">All Providers</span>
                            <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4">
                              {providerStatsList.length}
                            </Badge>
                          </div>
                          {selectedProvider === "all" && <Check className="size-3.5 text-primary shrink-0" />}
                        </CommandItem>

                        {providerStatsList.map((p) => {
                          const isSelected = selectedProvider === p.provider || selectedProvider === p.id;
                          return (
                            <CommandItem
                              key={p.id}
                              value={`${p.name} ${p.provider}`}
                              onSelect={() => {
                                setSelectedProvider(p.provider);
                                setProviderFilterOpen(false);
                              }}
                              className="text-xs flex items-center justify-between py-2 cursor-pointer"
                            >
                              <div className="flex items-center gap-2 truncate pr-2">
                                <div className="size-6 rounded bg-muted/60 flex items-center justify-center shrink-0 border">
                                  <ModelProviderIcon provider={p.provider} className="size-3" />
                                </div>
                                <div className="flex flex-col truncate">
                                  <div className="flex items-center gap-1.5">
                                    <span className="font-medium truncate">{p.name}</span>
                                    {p.configured && (
                                      <span className="size-1.5 rounded-full bg-emerald-500 shrink-0" title="Configured" />
                                    )}
                                  </div>
                                  <span className="text-[10px] text-muted-foreground truncate">
                                    {formatCost(p.totalCost)} • {p.totalTokens.toLocaleString()} toks
                                  </span>
                                </div>
                              </div>
                              {isSelected && <Check className="size-3.5 text-primary shrink-0 ml-1" />}
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>

              {/* Provider Status Filter (Only on Providers Tab) */}
              {activeTab === "providers" && (
                <div className="flex items-center gap-1 bg-muted/40 p-0.5 rounded-lg border text-xs h-9">
                  <button
                    type="button"
                    onClick={() => setProviderStatusFilter("all")}
                    className={`px-2 py-1 rounded-md transition-colors text-xs ${
                      providerStatusFilter === "all"
                        ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    onClick={() => setProviderStatusFilter("configured")}
                    className={`px-2 py-1 rounded-md transition-colors text-xs ${
                      providerStatusFilter === "configured"
                        ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Configured ({configuredCount})
                  </button>
                  <button
                    type="button"
                    onClick={() => setProviderStatusFilter("used")}
                    className={`px-2 py-1 rounded-md transition-colors text-xs ${
                      providerStatusFilter === "used"
                        ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Active ({activeProvidersCount})
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Active Filter Chips Bar */}
          {hasActiveFilters && (
            <div className="flex flex-wrap items-center gap-2 pt-2 text-xs">
              <span className="text-muted-foreground text-[11px] font-medium">Active filters:</span>

              {selectedModel !== "all" && (
                <Badge variant="secondary" className="gap-1.5 py-1 px-2.5 bg-primary/10 text-primary border-primary/20">
                  <span>Model: <strong>{selectedModel}</strong></span>
                  <button
                    type="button"
                    onClick={() => setSelectedModel("all")}
                    className="hover:text-foreground ml-0.5"
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              )}

              {selectedProvider !== "all" && (
                <Badge variant="secondary" className="gap-1.5 py-1 px-2.5 bg-primary/10 text-primary border-primary/20">
                  <span>Provider: <strong>{getProviderDisplayName(selectedProvider)}</strong></span>
                  <button
                    type="button"
                    onClick={() => setSelectedProvider("all")}
                    className="hover:text-foreground ml-0.5"
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              )}

              {searchQuery.trim() !== "" && (
                <Badge variant="secondary" className="gap-1.5 py-1 px-2.5 bg-muted text-foreground">
                  <span>Search: &ldquo;{searchQuery}&rdquo;</span>
                  <button
                    type="button"
                    onClick={() => setSearchQuery("")}
                    className="hover:text-foreground ml-0.5"
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              )}

              <Button
                variant="ghost"
                size="sm"
                onClick={handleResetFilters}
                className="h-6 px-2 text-[11px] text-muted-foreground hover:text-destructive gap-1"
              >
                <RotateCcw className="size-3" />
                Reset all
              </Button>
            </div>
          )}
        </CardHeader>

        <CardContent className="p-4 sm:p-6 pt-0 space-y-6">
          {/* TAB 1: Models Breakdown */}
          {activeTab === "models" && (
            <div>
              {filteredModelStats.length > 0 ? (
                <div className="grid gap-6 lg:grid-cols-2">
                  {/* Pie Chart */}
                  <div className="min-h-[300px]">
                    <PieChart
                      title={chartMetric === "cost" ? "Top Models by Cost (USD)" : "Top Models by Token Usage"}
                      data={modelPieData}
                      unit={chartMetric === "cost" ? "USD" : "tokens"}
                      prefix={chartMetric === "cost" ? "$" : ""}
                      jsonView={false}
                      description={chartMetric === "cost" ? "Cost share across top AI models" : "Token consumption share across top AI models"}
                    />
                  </div>

                  {/* Models List */}
                  <div className="space-y-2.5 max-h-[460px] overflow-y-auto pr-1">
                    {filteredModelStats.map((modelStat) => {
                      const sharePercent =
                        chartMetric === "cost"
                          ? (totalCost > 0 ? Math.round((modelStat.totalCost / totalCost) * 100) : 0)
                          : (stats.totalTokens > 0 ? Math.round((modelStat.totalTokens / stats.totalTokens) * 100) : 0);

                      const isSelected = selectedModel === modelStat.model;

                      return (
                        <div
                          key={modelStat.model}
                          onClick={() => {
                            setSelectedModel(isSelected ? "all" : modelStat.model);
                          }}
                          className={`p-3 rounded-lg border transition-all space-y-2 cursor-pointer ${
                            isSelected
                              ? "bg-primary/10 border-primary shadow-xs"
                              : "bg-card/80 hover:bg-accent/40"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-3 min-w-0 flex-1">
                              <div className="size-8 rounded-lg bg-muted/60 flex items-center justify-center shrink-0 border">
                                <ModelProviderIcon provider={modelStat.providerKey} className="size-4" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-semibold truncate">
                                    {modelStat.model}
                                  </span>
                                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 text-muted-foreground">
                                    {modelStat.providerName}
                                  </Badge>
                                </div>
                                <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5 flex-wrap">
                                  <span>{modelStat.messageCount} msgs</span>
                                  <span>•</span>
                                  <span className="text-blue-600 dark:text-blue-400">
                                    In: {modelStat.promptTokens.toLocaleString()} ({formatCost(modelStat.promptCost)})
                                  </span>
                                  <span>•</span>
                                  <span className="text-emerald-600 dark:text-emerald-400">
                                    Out: {modelStat.completionTokens.toLocaleString()} ({formatCost(modelStat.completionCost)})
                                  </span>
                                </div>
                              </div>
                            </div>

                            <div className="text-right shrink-0">
                              <div className="text-sm font-extrabold text-foreground">
                                {formatCost(modelStat.totalCost)}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {modelStat.totalTokens.toLocaleString()} toks ({sharePercent}%)
                              </div>
                            </div>
                          </div>

                          {/* Progress Bar */}
                          {sharePercent > 0 && (
                            <div className="w-full bg-muted rounded-full h-1 overflow-hidden">
                              <div
                                className="bg-amber-500 dark:bg-amber-400 h-full rounded-full transition-all duration-300"
                                style={{ width: `${sharePercent}%` }}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="py-12 text-center text-sm text-muted-foreground space-y-2">
                  <p>No model usage recorded matching current filters.</p>
                  {hasActiveFilters && (
                    <Button variant="outline" size="sm" onClick={handleResetFilters} className="text-xs h-8">
                      Clear filters
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* TAB 2: Providers Breakdown */}
          {activeTab === "providers" && (
            <div>
              {filteredProviderStats.length > 0 ? (
                <div className="grid gap-6 lg:grid-cols-2">
                  {/* Pie Chart */}
                  <div className="min-h-[300px]">
                    {providerPieData.length > 0 ? (
                      <PieChart
                        title={chartMetric === "cost" ? "Provider Cost Share (USD)" : "Provider Token Share"}
                        data={providerPieData}
                        unit={chartMetric === "cost" ? "USD" : "tokens"}
                        prefix={chartMetric === "cost" ? "$" : ""}
                        jsonView={false}
                        description={chartMetric === "cost" ? "Cost distribution across AI providers" : "Token consumption distribution across AI providers"}
                      />
                    ) : (
                      <div className="h-full flex flex-col items-center justify-center p-6 border rounded-lg bg-background/50 text-center">
                        <Boxes className="size-10 text-muted-foreground/50 mb-2" />
                        <p className="text-sm font-medium">No Provider Activity Yet</p>
                      </div>
                    )}
                  </div>

                  {/* Provider List */}
                  <div className="space-y-2.5 max-h-[460px] overflow-y-auto pr-1">
                    {filteredProviderStats.map((providerStat) => {
                      const sharePercent =
                        chartMetric === "cost"
                          ? (totalCost > 0 ? Math.round((providerStat.totalCost / totalCost) * 100) : 0)
                          : (stats.totalTokens > 0 ? Math.round((providerStat.totalTokens / stats.totalTokens) * 100) : 0);

                      const isSelected = selectedProvider === providerStat.provider || selectedProvider === providerStat.id;

                      return (
                        <div
                          key={providerStat.id}
                          onClick={() => {
                            setSelectedProvider(isSelected ? "all" : providerStat.provider);
                          }}
                          className={`p-3.5 rounded-lg border transition-all space-y-2 cursor-pointer ${
                            isSelected
                              ? "bg-primary/10 border-primary shadow-xs"
                              : "bg-card/80 hover:bg-card"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-3 min-w-0 flex-1">
                              <div className="size-8 rounded-lg bg-muted/60 flex items-center justify-center shrink-0 border">
                                <ModelProviderIcon
                                  provider={providerStat.provider}
                                  className="size-4"
                                />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-semibold truncate">
                                    {providerStat.name}
                                  </span>
                                  {providerStat.configured ? (
                                    <Badge
                                      variant="outline"
                                      className="text-[10px] px-1.5 py-0 h-4 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10 flex items-center gap-1"
                                    >
                                      <CheckCircle2 className="size-2.5" />
                                      Configured
                                    </Badge>
                                  ) : (
                                    <Badge
                                      variant="secondary"
                                      className="text-[10px] px-1.5 py-0 h-4 text-muted-foreground flex items-center gap-1"
                                    >
                                      <AlertCircle className="size-2.5" />
                                      Unconfigured
                                    </Badge>
                                  )}
                                </div>
                                <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5 flex-wrap">
                                  <span>{providerStat.modelCount} models used</span>
                                  <span>•</span>
                                  <span>{providerStat.messageCount} msgs</span>
                                  {providerStat.totalTokens > 0 && (
                                    <>
                                      <span>•</span>
                                      <span className="text-blue-600 dark:text-blue-400">
                                        In: {providerStat.promptTokens.toLocaleString()} ({formatCost(providerStat.promptCost)})
                                      </span>
                                      <span>•</span>
                                      <span className="text-emerald-600 dark:text-emerald-400">
                                        Out: {providerStat.completionTokens.toLocaleString()} ({formatCost(providerStat.completionCost)})
                                      </span>
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>

                            <div className="text-right shrink-0">
                              <div className="text-sm font-extrabold text-foreground">
                                {formatCost(providerStat.totalCost)}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {providerStat.totalTokens.toLocaleString()} toks ({sharePercent}%)
                              </div>
                            </div>
                          </div>

                          {sharePercent > 0 && (
                            <div className="w-full bg-muted rounded-full h-1 overflow-hidden">
                              <div
                                className="bg-amber-500 dark:bg-amber-400 h-full rounded-full transition-all duration-300"
                                style={{ width: `${sharePercent}%` }}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="py-12 text-center text-sm text-muted-foreground space-y-2">
                  <p>No providers match the selected filters.</p>
                  {hasActiveFilters && (
                    <Button variant="outline" size="sm" onClick={handleResetFilters} className="text-xs h-8">
                      Clear filters
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
        </CardContent>

        {/* Footer Admin Link */}
        {view === "admin" && (
          <div className="p-4 sm:p-5 pt-3 border-t bg-muted/10 flex items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Sparkles className="size-3.5 text-primary" />
              Manage API keys, custom endpoints, and rate limits in Provider Settings
            </span>
            <Link
              href="/admin/providers"
              className="text-primary hover:underline font-semibold flex items-center gap-1"
            >
              Provider Settings
              <ArrowUpRight className="size-3" />
            </Link>
          </div>
        )}
      </Card>
    </div>
  );
}
