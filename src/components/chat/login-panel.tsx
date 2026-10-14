"use client";

// The `/login` chat command's inline panel. It exists so a user can connect a
// provider without leaving the conversation -- but nothing it touches ever
// becomes a chat message. The command text is intercepted in chat-bot.tsx
// before `sendMessage` runs, and every secret below (API key, OAuth
// authorization URL, device/user code, callback URL) is held in local
// component state only. Secrets are never written to the transcript, history,
// a toast body, or the console.
//
// Provider listing: the adapter's `GET /api/providers/login-status` (which
// mirrors `jcode auth status --json`), falling back to the existing
// `GET /api/ai/providers` when that route is absent.
//
// OAuth providers get an interactive flow instead of only terminal
// instructions:
//   POST /api/providers/:id/oauth/start     -> authorization URL and/or device code
//   GET  /api/providers/:id/oauth/status    -> pending | success | error | expired
//   POST /api/providers/:id/oauth/callback  -> { code | callbackUrl } to finish
// The response field names are read defensively (see the `parse*` helpers)
// because the adapter contract landed separately; a missing route degrades to
// the terminal `jcode login <provider>` instructions.

import { useCallback, useEffect, useMemo, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { toast } from "sonner";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader,
  ShieldCheck,
  Smartphone,
  X,
} from "lucide-react";
import { Alert, AlertDescription } from "ui/alert";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "ui/card";
import { Input } from "ui/input";
import { Label } from "ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "ui/select";
import { ApiError, apiJson, fetcher } from "@/lib/backend/client";
import {
  PROVIDERS_KEY,
  saveProvider,
  selectProviders,
  type ProviderConfig,
} from "@/lib/backend/provider-api";

/**
 * One entry in the login-status listing. `jcode auth status --json` nests
 * these under a top-level `providers` key; the adapter may return the array
 * directly, so both shapes are accepted in `normalizeLoginStatus`.
 */
type LoginProvider = {
  id: string;
  display_name?: string;
  name?: string;
  /** "OAuth" | "API key" (jcode) -- anything containing "oauth" runs the
   * interactive flow below, everything else takes a pasted key. */
  auth_kind?: string;
  status?: string;
  method?: string;
  recommended?: boolean;
};

/** Parsed result of `POST /api/providers/:id/oauth/start`. */
type OAuthInfo = {
  flow: "authorization_code" | "device_code";
  authorizationUrl?: string;
  userCode?: string;
  verificationUri?: string;
  /** Poll interval in milliseconds (already normalized/clamped). */
  interval: number;
  /** Time to wait for the user, in seconds. */
  expiresIn: number;
};

type OAuthPhase =
  | "idle"
  | "starting"
  | "awaiting"
  | "submitting"
  | "success"
  | "error";

const LOGIN_STATUS_KEY = "/api/providers/login-status";
const DEFAULT_POLL_MS = 2000;
const DEFAULT_EXPIRES_SECONDS = 300;

function isOAuthProvider(provider: LoginProvider): boolean {
  return (provider.auth_kind ?? "").toLowerCase().includes("oauth");
}

function isConfigured(provider: LoginProvider): boolean {
  const status = (provider.status ?? "").toLowerCase();
  return status === "available" || status === "configured";
}

function providerLabel(provider: LoginProvider): string {
  return provider.display_name || provider.name || provider.id;
}

function normalizeLoginStatus(data: unknown): LoginProvider[] {
  if (Array.isArray(data)) return data as LoginProvider[];
  if (data && typeof data === "object") {
    const providers = (data as { providers?: unknown }).providers;
    if (Array.isArray(providers)) return providers as LoginProvider[];
  }
  return [];
}

function fromProviderConfig(provider: ProviderConfig): LoginProvider {
  return {
    id: provider.provider || provider.id,
    display_name: provider.name || provider.provider,
    auth_kind: "API key",
    status: provider.configured ? "available" : "not_configured",
  };
}

async function loadLoginProviders(): Promise<LoginProvider[]> {
  try {
    const list = normalizeLoginStatus(await fetcher(LOGIN_STATUS_KEY));
    if (list.length) return list;
  } catch {
    // Route missing or backend down -- fall back to the provider list.
  }
  try {
    const providers = await fetcher(PROVIDERS_KEY);
    if (Array.isArray(providers)) {
      return (providers as ProviderConfig[]).map(fromProviderConfig);
    }
  } catch {
    // Both endpoints failed; the panel renders its own empty state.
  }
  return [];
}

/** Responses are expected bare, but a `{ data: {...} }` wrapper is tolerated. */
function unwrap(data: unknown): Record<string, unknown> {
  if (data && typeof data === "object") {
    const inner = (data as { data?: unknown }).data;
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      return inner as Record<string, unknown>;
    }
    return data as Record<string, unknown>;
  }
  return {};
}

function firstString(
  obj: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstNumber(
  obj: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && !isNaN(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
}

function parseOAuthStart(raw: unknown): OAuthInfo {
  const data = unwrap(raw);
  const authorizationUrl = firstString(data, [
    "authorizationUrl",
    "authorization_url",
    "authorization_url_full",
    "authUrl",
    "auth_url",
    "verification_uri_complete",
    "verificationUri",
    "url",
  ]);
  const userCode = firstString(data, [
    "userCode",
    "user_code",
    "deviceCode",
    "device_code",
  ]);
  const verificationUri = firstString(data, [
    "verificationUri",
    "verification_uri",
    "verificationUrl",
    "verification_url",
  ]);
  const flowRaw = (
    firstString(data, ["flow", "grantType", "grant_type", "type"]) ?? ""
  ).toLowerCase();
  const flow =
    /device/.test(flowRaw) || (userCode && verificationUri)
      ? "device_code"
      : "authorization_code";
  const rawInterval = firstNumber(data, [
    "interval",
    "pollInterval",
    "poll_interval",
  ]);
  const interval = Math.min(
    10_000,
    Math.max(1_000, rawInterval == null ? DEFAULT_POLL_MS : rawInterval < 1000 ? rawInterval * 1000 : rawInterval),
  );
  const expiresIn =
    firstNumber(data, ["expiresIn", "expires_in", "expires"]) ??
    DEFAULT_EXPIRES_SECONDS;
  return { flow, authorizationUrl, userCode, verificationUri, interval, expiresIn };
}

function normalizeOAuthStatus(
  raw: unknown,
): "pending" | "success" | "error" | "expired" {
  const data = unwrap(raw);
  const status = String(
    data.status ?? data.state ?? data.result ?? "",
  ).toLowerCase();
  if (/expire/.test(status)) return "expired";
  if (/pending|waiting|in.?progress|processing|starting|authorization_pending/.test(status)) {
    return "pending";
  }
  if (/success|authorized|connected|complete|finished|done|\bok\b/.test(status)) {
    return "success";
  }
  if (/error|fail|denied|reject|invalid|cancel/.test(status)) return "error";
  return "pending";
}

function readOAuthError(raw: unknown): string | undefined {
  const data = unwrap(raw);
  return firstString(data, [
    "error",
    "error_description",
    "message",
    "detail",
  ]);
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export function LoginPanel({ onClose }: { onClose: () => void }) {
  const { mutate } = useSWRConfig();
  const {
    data: providers = [],
    isLoading,
    mutate: reload,
  } = useSWR<LoginProvider[]>(`login-status:${LOGIN_STATUS_KEY}`, loadLoginProviders, {
    fallbackData: [],
    revalidateOnFocus: false,
  });

  // Existing saved connections, so re-saving a provider updates it in place
  // rather than creating a duplicate link.
  const { data: savedProviders = [] } = useSWR<ProviderConfig[]>(
    PROVIDERS_KEY,
    selectProviders,
    { fallbackData: [], revalidateOnFocus: false },
  );

  const [selectedId, setSelectedId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

  // Interactive OAuth state.
  const [oauthPhase, setOauthPhase] = useState<OAuthPhase>("idle");
  const [oauthInfo, setOauthInfo] = useState<OAuthInfo | null>(null);
  const [oauthCode, setOauthCode] = useState("");
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [oauthUnsupported, setOauthUnsupported] = useState(false);

  // Re-list every time the panel opens: an OAuth login done elsewhere should
  // show up as connected on return.
  useEffect(() => {
    void reload();
  }, [reload]);

  const defaultProvider = useMemo(() => {
    const unconfiguredKey = providers.find(
      (p) => !isOAuthProvider(p) && !isConfigured(p),
    );
    return (
      unconfiguredKey ??
      providers.find((p) => !isConfigured(p)) ??
      providers[0]
    );
  }, [providers]);

  const activeId = selectedId || defaultProvider?.id || "";
  const selected = providers.find((p) => p.id === activeId);
  const selectedIsOAuth = selected ? isOAuthProvider(selected) : false;

  const refreshConnected = useCallback(async () => {
    await Promise.all([
      reload(),
      mutate(PROVIDERS_KEY),
      mutate("/api/chat/models"),
    ]);
  }, [reload, mutate]);

  const resetOAuth = useCallback(() => {
    setOauthPhase("idle");
    setOauthInfo(null);
    setOauthCode("");
    setOauthError(null);
    setOauthUnsupported(false);
  }, []);

  const handleSelect = (id: string) => {
    setSelectedId(id);
    setSaveError(null);
    setSavedId(null);
    resetOAuth();
  };

  const handleSave = async () => {
    const key = apiKey.trim();
    if (!selected || !key) {
      setSaveError("Enter an API key first.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSavedId(null);
    try {
      const existing = savedProviders.find(
        (p) => (p.provider || p.id) === selected.id,
      );
      await saveProvider({
        id: existing?.id,
        name: providerLabel(selected),
        provider: selected.id,
        apiKey: key,
        baseUrl: existing?.baseUrl ?? "",
        models: existing?.models ?? [],
      });
      // Drop the secret from component state the moment it is stored.
      setApiKey("");
      setReveal(false);
      setSavedId(selected.id);
      toast.success(`${providerLabel(selected)} connected`);
      await refreshConnected();
    } catch (error) {
      setSaveError(errorMessage(error, "Failed to save the API key."));
    } finally {
      setSaving(false);
    }
  };

  const handleOAuthStart = async () => {
    if (!selected) return;
    setOauthPhase("starting");
    setOauthError(null);
    setOauthInfo(null);
    setOauthCode("");
    try {
      const data = await apiJson(
        `/api/providers/${encodeURIComponent(selected.id)}/oauth/start`,
        { method: "POST", body: JSON.stringify({ provider: selected.id }) },
      );
      setOauthInfo(parseOAuthStart(data));
      setOauthPhase("awaiting");
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status === 404 || error.status === 400)
      ) {
        setOauthUnsupported(true);
      }
      setOauthPhase("error");
      setOauthError(errorMessage(error, "Could not start the login flow."));
    }
  };

  const handleOAuthSubmit = async () => {
    if (!selected) return;
    const value = oauthCode.trim();
    if (!value) {
      setOauthError("Paste the authorization code or the full callback URL.");
      return;
    }
    setOauthPhase("submitting");
    setOauthError(null);
    try {
      const looksLikeUrl = /^https?:\/\//i.test(value) || value.includes("?");
      const body = looksLikeUrl
        ? { callbackUrl: value, url: value, code: value }
        : { code: value, authCode: value };
      const data = await apiJson(
        `/api/providers/${encodeURIComponent(selected.id)}/oauth/callback`,
        { method: "POST", body: JSON.stringify(body) },
      );
      // One-time code: drop it from state as soon as it has been submitted.
      setOauthCode("");
      const status = normalizeOAuthStatus(data);
      if (status === "success") {
        setOauthPhase("success");
        toast.success(`${providerLabel(selected)} connected`);
        await refreshConnected();
      } else if (status === "error") {
        setOauthPhase("error");
        setOauthError(readOAuthError(data) ?? "Authorization failed.");
      } else {
        // Completion is signalled by polling, not by this response.
        setOauthPhase("awaiting");
      }
    } catch (error) {
      setOauthPhase("error");
      setOauthError(errorMessage(error, "Authorization failed."));
    }
  };

  const handleOAuthCancel = async () => {
    if (!selected) return;
    try {
      await apiJson(`/api/providers/${encodeURIComponent(selected.id)}/oauth`, {
        method: "DELETE",
      });
    } catch {
      // Best-effort: the flow also expires server-side.
    }
    resetOAuth();
  };

  // Poll the backend while we wait for the user to finish in their browser.
  useEffect(() => {
    if (oauthPhase !== "awaiting" || !selected) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const interval = oauthInfo?.interval ?? DEFAULT_POLL_MS;
    const maxMs = (oauthInfo?.expiresIn ?? DEFAULT_EXPIRES_SECONDS) * 1000;
    const startedAt = Date.now();

    const tick = async () => {
      if (cancelled) return;
      let status: ReturnType<typeof normalizeOAuthStatus> = "pending";
      try {
        status = normalizeOAuthStatus(
          await apiJson(
            `/api/providers/${encodeURIComponent(selected.id)}/oauth/status`,
          ),
        );
      } catch (error) {
        // A transient error keeps the wait alive, but a gone flow (404) means
        // the server no longer has it -- cancelled or expired.
        if (error instanceof ApiError && error.status === 404) status = "expired";
      }
      if (cancelled) return;
      if (status === "success") {
        setOauthPhase("success");
        toast.success(`${providerLabel(selected)} connected`);
        void refreshConnected();
        return;
      }
      if (status === "error" || status === "expired") {
        setOauthPhase("error");
        setOauthError(
          status === "expired"
            ? "This login request expired. Start again."
            : "Authorization was not completed.",
        );
        return;
      }
      if (Date.now() - startedAt >= maxMs) {
        setOauthPhase("error");
        setOauthError("Timed out waiting for authorization. Start again.");
        return;
      }
      timer = setTimeout(tick, interval);
    };

    timer = setTimeout(tick, interval);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [oauthPhase, selected, oauthInfo, refreshConnected]);

  const copyOAuthValue = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copied");
    } catch {
      // Clipboard can be unavailable; the value is still on screen.
    }
  };

  return (
    <Card
      className="border shadow-lg bg-card/95 backdrop-blur-sm"
      data-testid="login-panel"
    >
      <CardHeader className="p-4 pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="size-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <KeyRound className="size-4" />
            </div>
            <div>
              <CardTitle className="text-sm font-bold">
                Connect a provider
              </CardTitle>
              <CardDescription className="text-xs">
                Keys and codes go straight to the backend. They never enter the
                chat.
              </CardDescription>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full size-7 shrink-0"
            onClick={onClose}
            aria-label="Close login panel"
            data-testid="login-panel-close"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-4 pt-2 space-y-3">
        {isLoading && providers.length === 0 ? (
          <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
            <Loader className="size-3.5 animate-spin" />
            Loading providers…
          </div>
        ) : providers.length === 0 ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>
              No providers are available from the backend. Make sure it is
              running, then reopen this panel.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label className="text-xs">Provider</Label>
              <Select value={activeId} onValueChange={handleSelect}>
                <SelectTrigger className="w-full h-9 text-xs" data-testid="login-provider-select">
                  <SelectValue placeholder="Select a provider" />
                </SelectTrigger>
                <SelectContent>
                  {providers.map((provider) => (
                    <SelectItem
                      key={provider.id}
                      value={provider.id}
                      className="text-xs"
                    >
                      <span className="flex items-center gap-2">
                        {providerLabel(provider)}
                        <Badge
                          variant={isConfigured(provider) ? "secondary" : "outline"}
                          className="text-[9px] px-1 py-0 h-4"
                        >
                          {isConfigured(provider)
                            ? "Connected"
                            : isOAuthProvider(provider)
                              ? "OAuth"
                              : "API key"}
                        </Badge>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selected && selectedIsOAuth ? (
              <div className="space-y-3">
                {oauthPhase === "success" ? (
                  <Alert>
                    <CheckCircle2 />
                    <AlertDescription>
                      {providerLabel(selected)} is connected and its models are
                      now available.
                    </AlertDescription>
                  </Alert>
                ) : oauthPhase === "error" ? (
                  <Alert variant="destructive">
                    <AlertCircle />
                    <AlertDescription className="space-y-2">
                      <p>{oauthError ?? "The login flow did not complete."}</p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={resetOAuth}
                      >
                        Start again
                      </Button>
                    </AlertDescription>
                  </Alert>
                ) : oauthPhase === "starting" ? (
                  <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
                    <Loader className="size-3.5 animate-spin" />
                    Preparing sign-in…
                  </div>
                ) : oauthPhase === "awaiting" || oauthPhase === "submitting" ? (
                  <div className="space-y-3">
                    {oauthInfo?.flow === "device_code" &&
                      oauthInfo.userCode && (
                        <div className="rounded-lg border bg-muted/40 p-3 space-y-2">
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Smartphone className="size-3.5" />
                            Enter this code on the provider page
                          </div>
                          <div className="flex items-center gap-2">
                            <code className="font-mono text-lg font-bold tracking-widest select-all">
                              {oauthInfo.userCode}
                            </code>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              onClick={() => copyOAuthValue(oauthInfo.userCode!)}
                              aria-label="Copy device code"
                            >
                              <Copy className="size-3.5" />
                            </Button>
                          </div>
                          {oauthInfo.verificationUri && (
                            <a
                              href={oauthInfo.verificationUri}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary hover:underline text-xs inline-flex items-center gap-1"
                            >
                              {oauthInfo.verificationUri}
                              <ExternalLink className="size-3" />
                            </a>
                          )}
                        </div>
                      )}

                    {oauthInfo?.flow === "authorization_code" &&
                      oauthInfo.authorizationUrl && (
                        <div className="rounded-lg border bg-muted/40 p-3 space-y-2">
                          <div className="text-xs text-muted-foreground">
                            Open the provider page to authorize this app
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              size="sm"
                              className="h-8 text-xs gap-1"
                              onClick={() =>
                                window.open(
                                  oauthInfo.authorizationUrl,
                                  "_blank",
                                  "noopener,noreferrer",
                                )
                              }
                            >
                              <ExternalLink className="size-3.5" />
                              Open sign-in page
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8"
                              onClick={() =>
                                copyOAuthValue(oauthInfo.authorizationUrl!)
                              }
                              aria-label="Copy authorization URL"
                            >
                              <Copy className="size-3.5" />
                            </Button>
                          </div>
                        </div>
                      )}

                    <div className="space-y-1.5">
                      <Label htmlFor="amiro-oauth-code" className="text-xs">
                        Paste the authorization code or callback URL
                      </Label>
                      <Input
                        id="amiro-oauth-code"
                        autoComplete="off"
                        spellCheck={false}
                        value={oauthCode}
                        onChange={(event) => setOauthCode(event.target.value)}
                        placeholder="code or https://…/callback?code=…"
                        className="h-9 text-xs font-mono"
                        data-testid="login-oauth-code"
                      />
                      <div className="flex items-center justify-between gap-2 pt-1">
                        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                          <Loader className="size-3 animate-spin" />
                          Waiting for the provider…
                        </span>
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 text-xs"
                            onClick={handleOAuthCancel}
                            data-testid="login-oauth-cancel"
                          >
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            className="h-8 text-xs gap-1"
                            onClick={handleOAuthSubmit}
                            disabled={
                              oauthPhase === "submitting" ||
                              oauthCode.trim().length === 0
                            }
                            data-testid="login-oauth-submit"
                          >
                            {oauthPhase === "submitting" ? (
                              <Loader className="size-3.5 animate-spin" />
                            ) : (
                              <Check className="size-3.5" />
                            )}
                            Submit
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      {providerLabel(selected)} uses an OAuth login. Start the
                      flow here; the provider page opens in a new tab and this
                      panel completes when you are done.
                    </p>
                    <Button
                      size="sm"
                      className="h-8 text-xs gap-1"
                      onClick={handleOAuthStart}
                      data-testid="login-oauth-start"
                    >
                      <ExternalLink className="size-3.5" />
                      Sign in with {providerLabel(selected)}
                    </Button>
                  </div>
                )}

                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer select-none">
                    Trouble signing in? Use a terminal instead
                  </summary>
                  <div className="mt-2 space-y-1.5">
                    <code className="block rounded bg-muted px-2 py-1 font-mono text-[11px] select-all">
                      jcode login {selected.id}
                    </code>
                    {oauthUnsupported && (
                      <p className="text-[11px]">
                        This backend does not expose the interactive OAuth
                        routes yet, so the terminal command is the only option.
                      </p>
                    )}
                  </div>
                </details>
              </div>
            ) : selected ? (
              <div className="space-y-1.5">
                <Label htmlFor="amiro-login-api-key" className="text-xs">
                  API key
                </Label>
                <div className="relative">
                  <Input
                    id="amiro-login-api-key"
                    type={reveal ? "text" : "password"}
                    autoComplete="off"
                    spellCheck={false}
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder="Paste the provider API key"
                    className="h-9 pr-9 text-xs font-mono"
                    data-testid="login-api-key"
                  />
                  <button
                    type="button"
                    onClick={() => setReveal((value) => !value)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={reveal ? "Hide API key" : "Show API key"}
                  >
                    {reveal ? (
                      <EyeOff className="size-3.5" />
                    ) : (
                      <Eye className="size-3.5" />
                    )}
                  </button>
                </div>
                <div className="flex items-center justify-between gap-2 pt-1">
                  <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <ShieldCheck className="size-3" />
                    Stored server-side.
                  </span>
                  <Button
                    size="sm"
                    className="h-8 text-xs gap-1"
                    onClick={handleSave}
                    disabled={saving || apiKey.trim().length === 0}
                    data-testid="login-api-key-save"
                  >
                    {saving ? (
                      <Loader className="size-3.5 animate-spin" />
                    ) : (
                      <Check className="size-3.5" />
                    )}
                    Save key
                  </Button>
                </div>
              </div>
            ) : null}

            {savedId && (
              <Alert>
                <Check />
                <AlertDescription>
                  Saved. {savedId} is now available in the model picker.
                </AlertDescription>
              </Alert>
            )}
            {saveError && (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertDescription>{saveError}</AlertDescription>
              </Alert>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
