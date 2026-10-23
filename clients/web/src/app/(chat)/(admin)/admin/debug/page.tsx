"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { mutate } from "swr";
import {
  FolderOpen,
  ShieldCheck,
  ShieldOff,
  ShieldX,
  Terminal,
} from "lucide-react";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "ui/select";
import { Switch } from "ui/switch";
import { AgentAvatar } from "@/components/team/agent-avatar";
import { agentScopedPath } from "@/components/team/team-paths";
import { TerminalPanel } from "@/components/terminal/terminal-panel";
import {
  MAIN_AGENT_ID,
  type TeamAgent,
  agentComputerKey,
  setAgentTools,
  useAgentComputer,
  useAgents,
} from "@/lib/backend/agents-api";
import { setAgentScope, useAgentScope } from "@/lib/backend/agent-scope";

export default function AdminDebugPage() {
  const t = useTranslations("Admin.debug");
  const router = useRouter();
  const agentScope = useAgentScope();
  const { data: agentsData, isLoading: agentsLoading } = useAgents();
  const agents = useMemo(() => agentsData?.agents ?? [], [agentsData?.agents]);

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
      router.push(agentScopedPath(nextScope, "/admin/debug"));
    },
    [router],
  );

  const isTeamAgent =
    selectedAgentId !== MAIN_AGENT_ID && selectedAgentId !== "amiro";

  return (
    <div
      data-testid="admin-debug-page"
      className="flex h-full min-h-0 flex-1 flex-col gap-3 px-6 py-5"
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

        <div className="flex flex-wrap items-center gap-3">
          {selectedAgent?.workspaceDir && (
            <div
              data-testid="debug-agent-workspace-badge"
              className="hidden sm:flex items-center gap-1.5 rounded-lg border border-border/60 bg-background/80 px-2.5 py-1 font-mono text-xs text-muted-foreground"
            >
              <FolderOpen className="size-3.5 shrink-0" />
              <span className="truncate max-w-[240px]">
                {isTeamAgent ? "/home/agent" : selectedAgent.workspaceDir}
              </span>
            </div>
          )}

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
      </div>

      {isTeamAgent && <TeamAgentTerminalBanner agentId={selectedAgentId} />}

      <TerminalPanel
        key={selectedAgentId}
        agentId={selectedAgentId}
        agentLabel={selectedAgent?.name ?? "Amiro"}
        className="min-h-0 flex-1"
      />
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
