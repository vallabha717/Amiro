"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import useSWR, { mutate } from "swr";
import {
  Box,
  Cpu,
  FolderOpen,
  HardDrive,
  Loader2,
  Monitor,
  RotateCw,
  ShieldCheck,
  ShieldOff,
  ShieldX,
  Terminal,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "ui/select";
import { Switch } from "ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "ui/tabs";
import { AgentAvatar } from "@/components/team/agent-avatar";
import { agentScopedPath } from "@/components/team/team-paths";
import { AgentBrowserPanel } from "@/components/terminal/agent-browser-panel";
import { TerminalPanel } from "@/components/terminal/terminal-panel";
import { WorkspaceBrowser } from "@/components/workspace-browser/workspace-browser";
import {
  MAIN_AGENT_ID,
  type TeamAgent,
  agentComputerKey,
  checkAgentComputer,
  setAgentTools,
  useAgentComputer,
  useAgents,
} from "@/lib/backend/agents-api";
import { setAgentScope, useAgentScope } from "@/lib/backend/agent-scope";
import { fetcher } from "@/lib/backend/client";
import { reopenOnboarding } from "@/lib/onboarding/onboarding-api";
import type { SystemInfo } from "@/components/general/general-settings";

type DebugTabId = "terminal" | "browser" | "files" | "general";

function resolveDebugTab(raw: string | null): DebugTabId {
  if (raw === "browser" || raw === "files" || raw === "general") {
    return raw;
  }
  return "terminal";
}

export default function AdminDebugPage() {
  const t = useTranslations("Admin.debug");
  const router = useRouter();
  const searchParams = useSearchParams();
  const agentScope = useAgentScope();
  const { data: agentsData, isLoading: agentsLoading } = useAgents();
  const agents = useMemo(() => agentsData?.agents ?? [], [agentsData?.agents]);

  const activeTab: DebugTabId = resolveDebugTab(searchParams.get("tab"));

  const [selectedAgentId, setSelectedAgentId] = useState<string>(
    agentScope || MAIN_AGENT_ID,
  );

  // Sync selected agent when scope changes
  useEffect(() => {
    const resolved = agentScope || MAIN_AGENT_ID;
    setSelectedAgentId(resolved);
  }, [agentScope]);

  const selectedAgent: TeamAgent | undefined = useMemo(() => {
    return (
      agents.find((a) => a.id === selectedAgentId) ??
      agents.find((a) => a.isMain || a.id === MAIN_AGENT_ID)
    );
  }, [agents, selectedAgentId]);

  const handleAgentChange = useCallback(
    (nextAgentId: string) => {
      setSelectedAgentId(nextAgentId);
      const nextScope =
        nextAgentId === MAIN_AGENT_ID || nextAgentId === "amiro"
          ? null
          : nextAgentId;
      setAgentScope(nextScope);
      const tabQuery = activeTab !== "terminal" ? `?tab=${activeTab}` : "";
      router.push(`${agentScopedPath(nextScope, "/admin/debug")}${tabQuery}`);
    },
    [activeTab, router],
  );

  const handleTabChange = useCallback(
    (value: string) => {
      const nextTab = resolveDebugTab(value);
      const next = new URLSearchParams(searchParams.toString());
      if (nextTab === "terminal") {
        next.delete("tab");
      } else {
        next.set("tab", nextTab);
      }
      const qs = next.toString();
      const base = agentScopedPath(
        selectedAgentId === MAIN_AGENT_ID ? null : selectedAgentId,
        "/admin/debug",
      );
      router.replace(qs ? `${base}?${qs}` : base);
    },
    [router, searchParams, selectedAgentId],
  );

  const isTeamAgent =
    selectedAgentId !== MAIN_AGENT_ID && selectedAgentId !== "amiro";

  return (
    <div
      data-testid="admin-debug-page"
      className="flex h-full min-h-0 flex-1 flex-col px-6 py-5"
    >
      <Tabs
        value={activeTab}
        onValueChange={handleTabChange}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
          <TabsList data-testid="admin-debug-tabs">
            <TabsTrigger value="terminal" data-testid="admin-debug-tab-terminal">
              {t("tabs.terminal")}
            </TabsTrigger>
            <TabsTrigger value="browser" data-testid="admin-debug-tab-browser">
              {t("tabs.browser")}
            </TabsTrigger>
            <TabsTrigger value="files" data-testid="admin-debug-tab-files">
              {t("tabs.files")}
            </TabsTrigger>
            <TabsTrigger value="general" data-testid="admin-debug-tab-general">
              {t("tabs.general")}
            </TabsTrigger>
          </TabsList>

          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              {t("targetAgentLabel")}
            </span>
            <Select
              value={selectedAgent?.id ?? MAIN_AGENT_ID}
              onValueChange={handleAgentChange}
              disabled={agentsLoading || agents.length === 0}
            >
              <SelectTrigger
                data-testid="debug-agent-selector"
                aria-label={t("targetAgentLabel")}
                className="h-9 min-w-[210px]"
              >
                <SelectValue placeholder={t("targetAgentPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {agents.map((agent) => (
                  <SelectItem
                    key={agent.id}
                    value={agent.id}
                    data-testid={`debug-agent-option-${agent.id}`}
                  >
                    <span className="inline-flex items-center gap-2">
                      <AgentAvatar agent={agent} size={18} />
                      <span className="font-medium">{agent.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {agent.isMain
                          ? `(${t("mainBadge")})`
                          : `(${t("teamBadge")})`}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Terminal Tab */}
        <TabsContent
          value="terminal"
          className="mt-0 flex min-h-0 flex-1 flex-col gap-3 pt-1"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-card/60 px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/50">
                <Terminal className="size-4 text-muted-foreground" />
              </div>
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold text-foreground">
                  {t("terminalPanel.title", {
                    agent: selectedAgent?.name ?? "Amiro",
                  })}
                </h2>
                <p className="truncate text-xs text-muted-foreground">
                  {isTeamAgent
                    ? t("terminalPanel.teamSubtitle")
                    : t("terminalPanel.mainSubtitle")}
                </p>
              </div>
            </div>

            {selectedAgent?.workspaceDir && (
              <div
                data-testid="debug-agent-workspace-badge"
                className="flex items-center gap-1.5 rounded-lg border border-border/60 bg-background/80 px-2.5 py-1 font-mono text-xs text-muted-foreground"
              >
                <FolderOpen className="size-3.5 shrink-0" />
                <span className="truncate max-w-[280px]">
                  {isTeamAgent ? "/home/agent" : selectedAgent.workspaceDir}
                </span>
              </div>
            )}
          </div>

          {isTeamAgent && <TeamAgentTerminalBanner agentId={selectedAgentId} />}

          <TerminalPanel
            key={selectedAgentId}
            agentId={selectedAgentId}
            agentLabel={selectedAgent?.name ?? "Amiro"}
            className="min-h-0 flex-1"
          />
        </TabsContent>

        {/* Browser & Screen Tab */}
        <TabsContent
          value="browser"
          className="mt-0 flex min-h-0 flex-1 flex-col gap-3 pt-1"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-card/60 px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/50">
                <Monitor className="size-4 text-muted-foreground" />
              </div>
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold text-foreground">
                  {t("browser.title", {
                    agent: selectedAgent?.name ?? "Amiro",
                  })}
                </h2>
                <p className="truncate text-xs text-muted-foreground">
                  {isTeamAgent
                    ? t("browser.teamSubtitle")
                    : t("browser.mainSubtitle")}
                </p>
              </div>
            </div>
          </div>

          {isTeamAgent && <TeamAgentTerminalBanner agentId={selectedAgentId} />}

          <AgentBrowserPanel
            key={selectedAgentId}
            agentId={selectedAgentId}
            agentLabel={selectedAgent?.name ?? "Amiro"}
            className="min-h-0 flex-1"
          />
        </TabsContent>

        {/* File System / Workspace Tab */}
        <TabsContent
          value="files"
          className="mt-0 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pt-1"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-card/60 px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/50">
                <FolderOpen className="size-4 text-muted-foreground" />
              </div>
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold text-foreground">
                  {t("files.title", {
                    agent: selectedAgent?.name ?? "Amiro",
                  })}
                </h2>
                <p className="truncate text-xs text-muted-foreground">
                  {t("files.subtitle", {
                    path: selectedAgent?.workspaceDir ?? "~/.amiro/workspace",
                  })}
                </p>
              </div>
            </div>
          </div>

          <WorkspaceBrowser embedded scopeKey={selectedAgentId} />
        </TabsContent>

        {/* General Diagnostics Tab */}
        <TabsContent
          value="general"
          className="mt-0 flex-1 overflow-y-auto pt-1"
        >
          <DebugGeneralControls
            selectedAgent={selectedAgent}
            isTeamAgent={isTeamAgent}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function TeamAgentTerminalBanner({ agentId }: { agentId: string }) {
  const t = useTranslations("Admin.debug");
  const { data: computer } = useAgentComputer(agentId);
  const [busy, setBusy] = useState(false);

  if (!computer) return null;

  const shellEnabled = computer.tools.shell;
  const Icon =
    computer.isolation === "container"
      ? ShieldCheck
      : computer.isolation === "unavailable"
        ? ShieldX
        : ShieldOff;

  const handleToggleShell = async (checked: boolean) => {
    setBusy(true);
    try {
      const updated = await setAgentTools(agentId, { shell: checked });
      await mutate(agentComputerKey(agentId), updated, false);
      toast.success(
        checked ? t("shellEnabledToast") : t("shellDisabledToast"),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("shellToggleError"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="debug-team-agent-banner"
      data-isolation={computer.isolation}
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-muted/30 px-4 py-2.5 text-xs"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">
          {!shellEnabled
            ? t("teamBanner.shellOff")
            : !computer.available
              ? t("teamBanner.sandboxUnavailable")
              : t("teamBanner.containerReady")}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <label
          htmlFor="debug-team-shell-switch"
          className="text-xs font-medium text-foreground"
        >
          {t("teamBanner.enableShell")}
        </label>
        <Switch
          id="debug-team-shell-switch"
          data-testid="debug-team-shell-switch"
          checked={shellEnabled}
          disabled={busy}
          onCheckedChange={handleToggleShell}
        />
      </div>
    </div>
  );
}

function DebugGeneralControls({
  selectedAgent,
  isTeamAgent,
}: {
  selectedAgent: TeamAgent | undefined;
  isTeamAgent: boolean;
}) {
  const t = useTranslations("Admin.debug.general");
  const router = useRouter();
  const { data: system } = useSWR<SystemInfo>("/api/system", fetcher);
  const { data: computer } = useAgentComputer(
    isTeamAgent && selectedAgent ? selectedAgent.id : null,
  );
  const [checking, setChecking] = useState(false);

  const handleReplayOnboarding = async () => {
    try {
      await reopenOnboarding();
      toast.success(t("replayToast"));
      router.push("/onboarding");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("replayError"));
    }
  };

  const handleCheckIsolation = async () => {
    if (!selectedAgent || !isTeamAgent) return;
    setChecking(true);
    try {
      await checkAgentComputer(selectedAgent.id);
      await mutate(agentComputerKey(selectedAgent.id));
      toast.success(t("isolationCheckedToast"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("isolationCheckError"));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-4 pb-6">
      <div className="flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-lg border border-border/60 bg-muted/50">
          <Wrench className="size-4 text-muted-foreground" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            {t("title")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("subtitle")}</p>
        </div>
      </div>

      <Card data-testid="debug-runtime-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("agentRuntimeTitle")}</CardTitle>
          <CardDescription>{t("agentRuntimeDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2.5 text-sm">
          <div className="flex items-center justify-between gap-4 py-1">
            <span className="flex items-center gap-2 text-muted-foreground">
              <Cpu className="size-4" />
              {t("activeAgent")}
            </span>
            <span className="font-medium text-foreground">
              {selectedAgent?.name ?? "Amiro"} ({selectedAgent?.id ?? "main"})
            </span>
          </div>
          <div className="flex items-center justify-between gap-4 py-1">
            <span className="flex items-center gap-2 text-muted-foreground">
              <HardDrive className="size-4" />
              {t("workspacePath")}
            </span>
            <span className="font-mono text-xs text-foreground">
              {selectedAgent?.workspaceDir ?? "~/.amiro/workspace"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4 py-1">
            <span className="flex items-center gap-2 text-muted-foreground">
              <Box className="size-4" />
              {t("executionMode")}
            </span>
            <span className="font-mono text-xs text-foreground">
              {isTeamAgent
                ? `${t("modeContainer")} (${computer?.isolation ?? "none"})`
                : t("modeHost")}
            </span>
          </div>
          {system?.version && (
            <div className="flex items-center justify-between gap-4 py-1">
              <span className="text-muted-foreground">{t("serverVersion")}</span>
              <span className="font-mono text-xs text-foreground">
                v{system.version}
              </span>
            </div>
          )}
          {isTeamAgent && computer?.available && (
            <div className="pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleCheckIsolation}
                disabled={checking}
                data-testid="debug-check-isolation-button"
              >
                {checking && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                {t("verifyContainerBoundary")}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="debug-onboarding-card">
        <CardContent className="flex items-center justify-between gap-4 py-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              {t("replayTitle")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("replayDescription")}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleReplayOnboarding}
            data-testid="debug-replay-onboarding-button"
            className="shrink-0 gap-1.5"
          >
            <RotateCw className="size-3.5" />
            <span>{t("replayAction")}</span>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
