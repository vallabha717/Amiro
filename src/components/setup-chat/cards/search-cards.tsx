"use client";

import {
  SEARCH_CATALOG_KEY,
  SEARCH_PROVIDERS_KEY,
  type SearchProviderSpec,
  activateSearchProvider,
  saveSearchProvider,
  selectSearchCatalog,
  selectSearchProviders,
} from "@/lib/backend/search-provider-api";
import { useAgentScope } from "@/lib/backend/agent-scope";
import { ArrowUpRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import useSWR, { mutate } from "swr";
import { Button } from "ui/button";
import { Input } from "ui/input";
import { Label } from "ui/label";
import { Skeleton } from "ui/skeleton";
import {
  CardActions,
  ChoiceButton,
  ErrorLine,
  SetupCard,
  errorText,
} from "../card-ui";

/**
 * Save a search provider and make it the default, as the Search admin page
 * does. An engine that is already saved (the free ones are seeded) is
 * updated in place, never duplicated.
 */
async function saveAndActivate(
  spec: SearchProviderSpec,
  apiKey: string,
  existingId?: string,
) {
  const { id } = await saveSearchProvider({
    id: existingId,
    name: spec.label,
    provider: spec.kind,
    apiKey,
    baseUrl: spec.supportsApiBase ? spec.defaultApiBase : undefined,
  });
  await activateSearchProvider(id);
  await mutate(SEARCH_PROVIDERS_KEY);
}

function useSearchCatalog() {
  const scope = useAgentScope();
  return useSWR([SEARCH_CATALOG_KEY, scope ?? "main"], () =>
    selectSearchCatalog().then((list) =>
      // A custom endpoint or a self-hosted engine without a default address
      // (SearXNG) needs the full editor in Admin → Search.
      list.filter(
        (spec) =>
          !spec.supportsCustomConfig &&
          spec.kind !== "custom" &&
          !(spec.supportsApiBase && !spec.defaultApiBase),
      ),
    ),
  );
}

export function SearchPickCard({
  onSaved,
  onNeedsKey,
  onSkip,
}: {
  /** A keyless engine was saved straight away. */
  onSaved: (label: string) => void;
  onNeedsKey: (spec: SearchProviderSpec) => void;
  onSkip: () => void;
}) {
  const t = useTranslations("SetupChat");
  const scope = useAgentScope();
  const { data: catalog, isLoading } = useSearchCatalog();
  const { data: saved } = useSWR([SEARCH_PROVIDERS_KEY, scope ?? "main"], () =>
    selectSearchProviders(),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const configured = new Set(
    (saved ?? []).filter((p) => p.configured).map((p) => p.provider),
  );
  const active = (saved ?? []).find((p) => p.isActive && p.configured);

  const pick = async (spec: SearchProviderSpec) => {
    if (!spec.keyless) {
      onNeedsKey(spec);
      return;
    }
    setBusy(spec.kind);
    setError(null);
    try {
      const existing = (saved ?? []).find((p) => p.provider === spec.kind);
      await saveAndActivate(spec, "", existing?.id);
      onSaved(spec.label);
    } catch (err) {
      setError(errorText(err, t("saveError")));
      setBusy(null);
    }
  };

  return (
    <SetupCard testId="setup-search-card">
      {isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {(catalog ?? []).map((spec) => (
            <ChoiceButton
              key={spec.kind}
              title={spec.label}
              subtitle={spec.freeTier}
              badge={spec.keyless ? t("noKey") : null}
              connected={configured.has(spec.kind)}
              disabled={busy !== null}
              onClick={() => pick(spec)}
              testId={`setup-search-${spec.kind}`}
            />
          ))}
        </div>
      )}
      <ErrorLine error={error} />
      <CardActions onSkip={onSkip} busy={busy !== null}>
        {active && (
          <Button
            variant="outline"
            onClick={() => onSaved(active.name)}
            data-testid="setup-search-keep"
          >
            {t("keepProvider", { provider: active.name })}
          </Button>
        )}
      </CardActions>
    </SetupCard>
  );
}

/** The key for the chosen engine, straight to the vault. */
export function SearchKeyCard({
  kind,
  onSaved,
  onBack,
  onSkip,
}: {
  kind: string;
  onSaved: () => void;
  onBack: () => void;
  onSkip: () => void;
}) {
  const t = useTranslations("SetupChat");
  const { data: catalog } = useSearchCatalog();
  const spec = catalog?.find((s) => s.kind === kind);
  const scope = useAgentScope();
  const { data: saved } = useSWR([SEARCH_PROVIDERS_KEY, scope ?? "main"], () =>
    selectSearchProviders(),
  );
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!spec || !key.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const existing = (saved ?? []).find((p) => p.provider === spec.kind);
      await saveAndActivate(spec, key.trim(), existing?.id);
      setKey("");
      onSaved();
    } catch (err) {
      setError(errorText(err, t("saveError")));
      setBusy(false);
    }
  };

  return (
    <SetupCard testId="setup-search-key-card">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <SecretField
          id="setup-search-key"
          label={t("apiKeyFor", { provider: spec?.label ?? kind })}
          value={key}
          onChange={setKey}
          docsUrl={spec?.docs}
          docsLabel={t("getKey", { provider: spec?.label ?? kind })}
          testId="setup-search-key"
        />
        <ErrorLine error={error} />
        <CardActions onSkip={onSkip} busy={busy}>
          <Button
            type="submit"
            disabled={!spec || !key.trim() || busy}
            data-testid="setup-search-save"
          >
            {busy ? t("saving") : t("saveKey")}
          </Button>
          <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
            {t("pickAnother")}
          </Button>
        </CardActions>
      </form>
    </SetupCard>
  );
}

/**
 * A password field for a key that goes straight to the backend vault. The
 * value lives only in the card's state and is cleared once saved.
 */
export function SecretField({
  id,
  label,
  value,
  onChange,
  placeholder,
  docsUrl,
  docsLabel,
  testId,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  docsUrl?: string;
  docsLabel?: string;
  testId: string;
}) {
  const t = useTranslations("SetupChat");
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono"
        data-testid={testId}
      />
      <p className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
        <span>{t("vaultNote")}</span>
        {docsUrl && (
          <a
            href={docsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 underline-offset-4 hover:text-foreground hover:underline"
          >
            {docsLabel}
            <ArrowUpRight className="size-3" aria-hidden />
          </a>
        )}
      </p>
    </div>
  );
}
