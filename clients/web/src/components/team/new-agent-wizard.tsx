"use client";

import { SetupChat } from "@/components/setup-chat/setup-chat";
import { DEFAULT_CHARACTER_TRAITS } from "@/lib/agent/character-catalog";
import { setAgentScope } from "@/lib/backend/agent-scope";
import { useSession } from "@/lib/backend/session-context";
import { ArrowLeftIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { teamThreadPath } from "./team-paths";

/**
 * Team → New agent: the same setup chat as first-run onboarding, in team
 * mode. The agent is created at the look step (name, role, look, brain) and
 * the rest of the chat sets up its own prompt, personality, provider, web
 * search and connectors. It ends in the agent's Team thread.
 */
export function NewAgentWizard() {
  const t = useTranslations("Team");
  const router = useRouter();
  const { data: session } = useSession();

  if (session && session.user.role !== "admin") {
    return (
      <div className="mx-auto max-w-lg p-8">
        <h1 className="text-xl font-semibold">{t("newAgentTitle")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("ownerOnly")}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="team-new-agent">
      <div className="flex shrink-0 items-center gap-3 px-4 py-2">
        <Link
          href="/team"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" />
          {t("backToTeam")}
        </Link>
        <h1 className="sr-only">{t("newAgentTitle")}</h1>
      </div>
      <div className="min-h-0 flex-1">
        <SetupChat
          mode="team"
          agentName=""
          initialTraits={{
            ...DEFAULT_CHARACTER_TRAITS,
            bodyShape: "sprout",
            color: "teal",
          }}
          onFinish={async ({ agentId }) => {
            if (!agentId) return;
            setAgentScope(null);
            router.push(teamThreadPath(agentId));
          }}
        />
      </div>
    </div>
  );
}
