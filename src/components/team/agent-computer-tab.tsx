"use client";

import {
  type AgentComputer,
  type AgentComputerCheck,
  type TeamAgent,
  agentComputerKey,
  checkAgentComputer,
  setAgentTools,
  useAgentComputer,
} from "@/lib/backend/agents-api";
import {
  BoxIcon,
  FileTextIcon,
  ShieldCheckIcon,
  ShieldOffIcon,
  ShieldXIcon,
  TerminalIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { mutate } from "swr";
import { Button } from "ui/button";
import { Label } from "ui/label";
import { Skeleton } from "ui/skeleton";
import { Switch } from "ui/switch";

type Switchable = "shell" | "files";

const ISOLATION_ICON = {
  none: ShieldOffIcon,
  container: ShieldCheckIcon,
  unavailable: ShieldXIcon,
} as const;

/** The one sentence the page says about this agent's boundary. */
function IsolationNote({ computer }: { computer: AgentComputer }) {
  const t = useTranslations("Team.computer");
  const Icon = ISOLATION_ICON[computer.isolation];
  return (
    <div
      className="flex gap-2 rounded-xl border p-3 text-sm"
      data-testid="agent-isolation-note"
      data-isolation={computer.isolation}
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span>{t(`isolation.${computer.isolation}`)}</span>
    </div>
  );
}

function ToolSwitch({
  id,
  icon: Icon,
  checked,
  disabled,
  onChange,
}: {
  id: Switchable;
  icon: typeof TerminalIcon;
  checked: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  const t = useTranslations("Team.computer");
  return (
    <div className="flex items-start gap-3 px-3 py-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <Label htmlFor={`agent-tool-${id}`} className="text-sm font-medium">
          {t(`${id}.label`)}
        </Label>
        <p className="text-xs text-muted-foreground">{t(`${id}.description`)}</p>
      </div>
      <Switch
        id={`agent-tool-${id}`}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        data-testid={`agent-tool-${id}`}
      />
    </div>
  );
}

function CheckResult({ check }: { check: AgentComputerCheck }) {
  const t = useTranslations("Team.computer.check");
  const rows: Array<[string, string, boolean]> = [
    ["user", check.uid === 0 ? t("root") : t("nonRoot", { uid: String(check.uid ?? "?") }), check.uid !== 0],
    ["caps", check.noCapabilities ? t("noCaps") : t("someCaps", { caps: check.capEff }), check.noCapabilities],
    ["nnp", check.noNewPrivs ? t("nnpOn") : t("nnpOff"), check.noNewPrivs],
    ["docker", check.dockerSocket ? t("dockerVisible") : t("dockerHidden"), !check.dockerSocket],
    ["root", check.readOnlyRoot ? t("rootReadOnly") : t("rootWritable"), check.readOnlyRoot],
    [
      "mounts",
      t("mounts", { mounts: check.homeMounts.join(", ") || "—" }),
      check.homeMounts.length === 1 && check.homeMounts[0] === "/home/agent",
    ],
    ["network", check.network === "none" ? t("networkNone") : t("networkOn"), true],
    ["runtime", t("runtime", { runtime: check.runtime }), true],
  ];
  return (
    <ul className="divide-y rounded-xl border text-sm" data-testid="agent-computer-check-result">
      {rows.map(([key, text, good]) => (
        <li key={key} className="flex items-center gap-2 px-3 py-2" data-good={good}>
          <span
            aria-hidden
            className={good ? "size-2 shrink-0 rounded-full bg-emerald-500" : "size-2 shrink-0 rounded-full bg-amber-500"}
          />
          <span className="sr-only">{good ? t("ok") : t("warn")}</span>
          <span data-testid={`agent-check-${key}`}>{text}</span>
        </li>
      ))}
    </ul>
  );
}

/** A team agent's computer: which tools it gets and where they run. */
export function ComputerTab({ agent, canEdit }: { agent: TeamAgent; canEdit: boolean }) {
  const t = useTranslations("Team.computer");
  const { data: computer, error } = useAgentComputer(agent.id);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<AgentComputerCheck | null>(null);

  if (error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error.message}
      </p>
    );
  }
  if (!computer) return <Skeleton className="h-32 w-full" />;

  const toggle = async (key: Switchable, on: boolean) => {
    setBusy(true);
    try {
      const updated = await setAgentTools(agent.id, { [key]: on });
      await mutate(agentComputerKey(agent.id), updated, false);
      toast.success(t(on ? "turnedOn" : "turnedOff", { tool: t(`${key}.label`) }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("saveError"));
    } finally {
      setBusy(false);
    }
  };

  const runCheck = async () => {
    setChecking(true);
    try {
      setCheck(await checkAgentComputer(agent.id));
      await mutate(agentComputerKey(agent.id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("checkError"));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="space-y-4">
      <IsolationNote computer={computer} />
      <div className="divide-y rounded-xl border">
        <ToolSwitch
          id="shell"
          icon={TerminalIcon}
          checked={computer.tools.shell}
          disabled={!canEdit || busy}
          onChange={(on) => toggle("shell", on)}
        />
        <ToolSwitch
          id="files"
          icon={FileTextIcon}
          checked={computer.tools.files}
          disabled={!canEdit || busy}
          onChange={(on) => toggle("files", on)}
        />
      </div>
      {!canEdit && <p className="text-sm text-muted-foreground">{t("ownerOnly")}</p>}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed p-3 text-sm">
        <BoxIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 text-muted-foreground" data-testid="agent-sandbox-status">
          {!computer.configured
            ? t("status.notConfigured")
            : !computer.available
              ? t("status.unreachable")
              : t(`status.${computer.state ?? "missing"}`)}
        </span>
        {canEdit && computer.available && (
          <Button
            size="sm"
            variant="outline"
            onClick={runCheck}
            disabled={checking}
            data-testid="agent-computer-check"
          >
            {checking ? t("checking") : t("checkButton")}
          </Button>
        )}
      </div>
      {check && <CheckResult check={check} />}
    </div>
  );
}
