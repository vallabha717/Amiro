"use client";

import { Monitor } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "ui/tooltip";
import { cn } from "@/lib/utils";
import { MAIN_AGENT_ID, useAgents } from "@/lib/backend/agents-api";
import { useAgentScope } from "@/lib/backend/agent-scope";
import { useDesktopPreviewStore } from "./desktop-preview-store";

export function AssistantDesktopAffordance({
  agentId: propAgentId,
  agentName: propAgentName,
  onToggle,
}: {
  agentId?: string;
  agentName?: string;
  onToggle?: () => void;
}) {
  const t = useTranslations("AssistantDesktop");
  const scope = useAgentScope();
  const { data: agentsData } = useAgents();
  const effectiveAgentId = propAgentId || scope || MAIN_AGENT_ID;
  const resolvedAgent = agentsData?.agents.find(
    (a) => a.id === effectiveAgentId || (effectiveAgentId === MAIN_AGENT_ID && a.isMain),
  );
  const name = propAgentName || resolvedAgent?.name || "Amiro";

  const session = useDesktopPreviewStore((s) => s.session);
  const toggle = useDesktopPreviewStore((s) => s.toggle);
  const open = session?.agentId === effectiveAgentId;

  const label = open ? t("hideAria") : t("openAria", { name });

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          data-testid="assistant-desktop-affordance"
          aria-label={label}
          aria-expanded={open}
          aria-controls="assistant-desktop-preview"
          className={cn(
            "bg-secondary/40",
            open && "bg-primary text-primary-foreground hover:bg-primary/90",
          )}
          onClick={() => {
            toggle(effectiveAgentId);
            onToggle?.();
          }}
        >
          <Monitor className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent align="end" side="bottom">
        <span className="text-xs">{label}</span>
      </TooltipContent>
    </Tooltip>
  );
}
