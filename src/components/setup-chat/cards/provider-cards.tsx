"use client";

import {
  CATALOG_KEY,
  type CatalogProvider,
  LoginPanel,
  MECHANISM_ORDER,
  isConfigured,
  loadCatalogProviders,
  mechanismOf,
  providerLabel,
} from "@/components/chat/login-panel";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { Button } from "ui/button";
import { Input } from "ui/input";
import { Skeleton } from "ui/skeleton";
import { CardActions, ChoiceButton, SetupCard } from "../card-ui";

/** Same cache key LoginPanel uses, so a connect there shows up here at once. */
const CATALOG_SWR_KEY = `catalog:${CATALOG_KEY}`;

function useCatalog() {
  return useSWR<CatalogProvider[]>(CATALOG_SWR_KEY, loadCatalogProviders, {
    revalidateOnFocus: true,
  });
}

export type ProviderChoice = {
  id: string;
  label: string;
  mechanism: string;
  connected: boolean;
};

/**
 * Every provider this build supports (the runtime's catalog), grouped by how
 * it signs in. Picking one opens the connect turn for it.
 */
export function ProviderPickCard({
  onPick,
  onSkip,
}: {
  onPick: (choice: ProviderChoice) => void;
  onSkip: () => void;
}) {
  const t = useTranslations("SetupChat");
  const { data: catalog, isLoading } = useCatalog();
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (catalog ?? []).filter(
      (p) =>
        !q ||
        providerLabel(p).toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q),
    );
    const byMechanism = new Map<string, CatalogProvider[]>();
    for (const p of list) {
      const m = mechanismOf(p);
      byMechanism.set(m, [...(byMechanism.get(m) ?? []), p]);
    }
    const rank = (m: string) => {
      const i = MECHANISM_ORDER.indexOf(m);
      return i < 0 ? MECHANISM_ORDER.length : i;
    };
    return [...byMechanism.entries()]
      .sort(([a], [b]) => rank(a) - rank(b))
      .map(([m, items]) => ({
        mechanism: m,
        items: items.sort(
          (a, b) =>
            Number(!!b.recommended) - Number(!!a.recommended) ||
            providerLabel(a).localeCompare(providerLabel(b)),
        ),
      }));
  }, [catalog, query]);

  const connected = (catalog ?? []).filter(isConfigured);

  return (
    <SetupCard testId="setup-provider-card">
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("providerSearch")}
        aria-label={t("providerSearch")}
        data-testid="setup-provider-search"
      />
      <div className="mt-3 max-h-[26rem] space-y-4 overflow-y-auto pr-1">
        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noMatches")}</p>
        ) : (
          groups.map((group) => (
            <section key={group.mechanism}>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t(`mechanism.${knownMechanism(group.mechanism)}`)}
              </h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {group.items.map((p) => (
                  <ChoiceButton
                    key={p.id}
                    title={providerLabel(p)}
                    subtitle={p.detail}
                    badge={p.recommended ? t("recommended") : null}
                    connected={isConfigured(p)}
                    onClick={() =>
                      onPick({
                        id: p.id,
                        label: providerLabel(p),
                        mechanism: knownMechanism(mechanismOf(p)),
                        connected: isConfigured(p),
                      })
                    }
                    testId={`setup-provider-${p.id}`}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
      <CardActions onSkip={onSkip}>
        {connected.length > 0 && (
          <Button
            variant="outline"
            onClick={() =>
              onPick({
                id: connected[0].id,
                label: providerLabel(connected[0]),
                mechanism: knownMechanism(mechanismOf(connected[0])),
                connected: true,
              })
            }
            data-testid="setup-provider-keep"
          >
            {t("keepProvider", { provider: providerLabel(connected[0]) })}
          </Button>
        )}
      </CardActions>
    </SetupCard>
  );
}

export function knownMechanism(m: string): string {
  return MECHANISM_ORDER.includes(m) ? m : "unknown";
}

/**
 * The guided connect step for the chosen provider: the same panel as the
 * `/login` command (API key into the vault, OAuth or device-code sign-in,
 * local endpoint). Secrets stay in that panel's state and never become chat.
 */
export function ProviderConnectCard({
  providerId,
  onConnected,
  onBack,
  onSkip,
}: {
  providerId: string;
  onConnected: () => void;
  onBack: () => void;
  onSkip: () => void;
}) {
  const t = useTranslations("SetupChat");
  const { data: catalog } = useCatalog();
  const [current, setCurrent] = useState(providerId);
  const provider = catalog?.find((p) => p.id === current);
  const connected = provider ? isConfigured(provider) : false;

  return (
    <SetupCard testId="setup-provider-connect-card" className="p-2 sm:p-3">
      <LoginPanel
        initialProviderId={providerId}
        lockProvider
        onProviderChange={setCurrent}
        onClose={onBack}
      />
      <div className="px-2 pb-1">
        <CardActions onSkip={onSkip}>
          <Button
            onClick={onConnected}
            disabled={!connected}
            data-testid="setup-provider-continue"
          >
            {connected ? t("continue") : t("waitingToConnect")}
          </Button>
          <Button variant="ghost" onClick={onBack}>
            {t("pickAnother")}
          </Button>
        </CardActions>
      </div>
    </SetupCard>
  );
}
