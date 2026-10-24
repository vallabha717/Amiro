"use client";

import { ComposioAppsSection } from "@/components/composio-dashboard";
import { ConnectorDialog } from "@/components/connectors/connector-dialogs";
import { StatusPill } from "@/components/connectors/connectors-page";
import {
  saveComposioApiKey,
  selectComposioConfig,
} from "@/lib/backend/composio-api";
import { CONNECTORS_KEY, useConnectors } from "@/lib/backend/connectors-api";
import { PlugZap, PlusIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import useSWR, { mutate } from "swr";
import { Button } from "ui/button";
import { CardActions, ErrorLine, SetupCard, errorText } from "../card-ui";
import { SecretField } from "./search-cards";

/**
 * Apps and MCP servers. Amiro gets Composio's app catalog (once its key is
 * in) and custom MCP servers; a team agent gets remote MCP servers only,
 * because Composio is configured for Amiro and a team agent runs no local
 * servers (backend/src/routes/connectors.rs).
 */
export function ConnectorsCard({
  mode,
  onDone,
  onSkip,
}: {
  mode: "onboarding" | "team";
  onDone: (summary: string) => void;
  onSkip: () => void;
}) {
  const t = useTranslations("SetupChat");
  const team = mode === "team";
  const { data: connectors } = useConnectors();
  const { data: composio, mutate: refreshComposio } = useSWR(
    team ? null : "/api/composio/config",
    () => selectComposioConfig(),
    { revalidateOnFocus: false },
  );
  const [adding, setAdding] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const servers = (connectors?.servers ?? []).filter(
    (s) => s.source === "custom",
  );

  const saveKey = async () => {
    if (!key.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveComposioApiKey(key.trim());
      setKey("");
      await Promise.all([refreshComposio(), mutate(CONNECTORS_KEY)]);
    } catch (err) {
      setError(errorText(err, t("saveError")));
    } finally {
      setBusy(false);
    }
  };

  const summary =
    servers.length > 0
      ? servers.map((s) => s.name).join(", ")
      : composio?.configured
        ? t("composioReady")
        : "";

  return (
    <SetupCard testId="setup-connectors-card">
      {!team &&
        (composio?.configured ? (
          <div
            className="max-h-[min(24rem,55dvh)] overflow-y-auto rounded-xl border p-3"
            data-testid="setup-composio-apps"
          >
            <ComposioAppsSection />
          </div>
        ) : (
          <form
            className="rounded-xl border p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void saveKey();
            }}
          >
            <p className="mb-3 text-sm">
              <span className="font-medium">{t("composioTitle")}</span>{" "}
              <span className="text-muted-foreground">
                {t("composioBlurb")}
              </span>
            </p>
            <SecretField
              id="setup-composio-key"
              label={t("apiKeyFor", { provider: "Composio" })}
              value={key}
              onChange={setKey}
              docsUrl="https://app.composio.dev/developers"
              docsLabel={t("getKey", { provider: "Composio" })}
              testId="setup-composio-key"
            />
            <Button
              type="submit"
              size="sm"
              className="mt-3"
              disabled={!key.trim() || busy}
              data-testid="setup-composio-save"
            >
              {busy ? t("saving") : t("saveKey")}
            </Button>
          </form>
        ))}

      <div className="mt-3 rounded-xl border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <PlugZap className="size-4 text-muted-foreground" aria-hidden />
          <p className="min-w-0 flex-1 text-sm">
            <span className="font-medium">{t("mcpTitle")}</span>{" "}
            <span className="text-muted-foreground">
              {team ? t("mcpBlurbTeam") : t("mcpBlurb")}
            </span>
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAdding(true)}
            data-testid="setup-mcp-add"
          >
            <PlusIcon className="size-4" />
            {t("addServer")}
          </Button>
        </div>
        {servers.length > 0 && (
          <ul className="mt-3 space-y-1.5" data-testid="setup-mcp-list">
            {servers.map((s) => (
              <li
                key={s.name}
                className="flex items-center justify-between gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm"
              >
                <span className="truncate font-medium">{s.name}</span>
                <StatusPill status={s.status} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <ErrorLine error={error} />
      <CardActions onSkip={summary ? undefined : onSkip}>
        {summary && (
          <Button
            onClick={() => onDone(summary)}
            data-testid="setup-connectors-continue"
          >
            {t("continue")}
          </Button>
        )}
      </CardActions>
      {adding && <ConnectorDialog onClose={() => setAdding(false)} />}
    </SetupCard>
  );
}
