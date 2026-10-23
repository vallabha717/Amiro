"use client";

import {
  getAgentScope,
  setAgentScope,
  useAgentScope,
} from "@/lib/backend/agent-scope";
import { useAgent, useAgents } from "@/lib/backend/agents-api";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { Button } from "ui/button";
import { AgentAvatar } from "./agent-avatar";
import { resolveAgentFromPathname, teamThreadPath } from "./team-paths";

/**
 * Resolves the active agent scope from the URL pathname (e.g. /amiro or /<agentId>)
 * or falling back to ?agent=<id>.
 */
function ScopeFromRoute() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: agentsData } = useAgents();
  const agents = agentsData?.agents;

  useEffect(() => {
    // 1. Pathname-based resolution
    const pathSlug = resolveAgentFromPathname(pathname);
    if (pathSlug) {
      const matched = agents?.find(
        (a) =>
          a.id === pathSlug ||
          a.name.toLowerCase() === pathSlug.toLowerCase(),
      );
      const targetId = matched ? matched.id : pathSlug;
      if (getAgentScope() !== targetId) {
        setAgentScope(targetId);
      }
      return;
    }

    // 2. Query param ?agent= fallback
    const queryAgent = searchParams.get("agent");
    if (queryAgent) {
      if (getAgentScope() !== queryAgent) {
        setAgentScope(queryAgent);
      }
      return;
    }

    // 3. /amiro or main agent space -> clear scope to null (Amiro)
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length > 0 && (segments[0] === "amiro" || segments[0] === "main")) {
      if (getAgentScope() !== null) {
        setAgentScope(null);
      }
    }
  }, [pathname, searchParams, agents]);

  return null;
}

function SpaceBar({ agentId }: { agentId: string }) {
  const t = useTranslations("Team");
  const router = useRouter();
  const { data: agent, error } = useAgent(agentId);

  if (error) {
    // The agent is gone (deleted elsewhere): stop acting as it.
    setAgentScope(null);
    return null;
  }
  if (!agent) return null;
  return (
    <div
      role="status"
      data-testid="agent-scope-banner"
      className="flex flex-wrap items-center gap-3 border-b bg-accent/60 px-4 py-2 text-sm"
    >
      <AgentAvatar agent={agent} size={24} />
      <span className="min-w-0 flex-1">{t("spaceBanner", { name: agent.name })}</span>
      <Button asChild size="sm" variant="outline" className="bg-background" data-testid="agent-scope-back">
        <Link href={teamThreadPath(agent.id)}>{t("backToTeam")}</Link>
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setAgentScope(null);
          router.push("/amiro");
        }}
        data-testid="agent-scope-clear"
      >
        {t("switchToAmiro")}
      </Button>
    </div>
  );
}

/** Says, on every page of the app, whose space it is when it is not Amiro's. */
export function AgentScopeBanner() {
  const scope = useAgentScope();
  return (
    <>
      <Suspense fallback={null}>
        <ScopeFromRoute />
      </Suspense>
      {scope && (
        <Suspense fallback={null}>
          <SpaceBar agentId={scope} />
        </Suspense>
      )}
    </>
  );
}
