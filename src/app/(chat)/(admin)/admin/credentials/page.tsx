"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  deleteCredential,
  listCredentials,
  saveCredential,
  toCredentialEnvVar,
  type CredentialMetadata,
} from "@/lib/backend/credentials-api";

interface Preset {
  name: string;
  service: string;
  field: string;
  label: string;
  usageDescription?: string;
  allowedDomains?: string;
}

const PRESETS: Preset[] = [
  {
    name: "GitHub",
    service: "github",
    field: "token",
    label: "GitHub Personal Access Token",
    usageDescription: "Use for GitHub API interactions and git operations",
    allowedDomains: "api.github.com, github.com",
  },
  {
    name: "OpenAI",
    service: "openai",
    field: "api_key",
    label: "OpenAI API Key",
    usageDescription: "Use for OpenAI LLM and embeddings generation",
    allowedDomains: "api.openai.com",
  },
  {
    name: "9Router",
    service: "9router",
    field: "api_key",
    label: "9Router Gateway Key",
    usageDescription: "Use for multi-model LLM routing via 9Router",
    allowedDomains: "api.9router.com",
  },
  {
    name: "Composio",
    service: "composio",
    field: "api_key",
    label: "Composio API Key",
    usageDescription: "Use for Composio external tool execution",
    allowedDomains: "backend.composio.dev",
  },
  {
    name: "Slack",
    service: "slack",
    field: "bot_token",
    label: "Slack Bot Token",
    usageDescription: "Use for Slack messaging and channel operations",
    allowedDomains: "slack.com",
  },
  {
    name: "Custom",
    service: "",
    field: "",
    label: "",
    usageDescription: "",
    allowedDomains: "",
  },
];

export function credentialEnvVar(credential: CredentialMetadata): string {
  return (
    credential.envVar || toCredentialEnvVar(credential.service, credential.field)
  );
}

export function filterCredentials(
  credentials: CredentialMetadata[],
  searchQuery: string,
): CredentialMetadata[] {
  const q = searchQuery.toLowerCase().trim();
  if (!q) return credentials;
  return credentials.filter((credential) => {
    const envVar = credentialEnvVar(credential);
    const haystack = [
      credential.service,
      credential.field,
      `${credential.service}/${credential.field}`,
      credential.label ?? "",
      credential.usageDescription ?? "",
      credential.hint ?? "",
      envVar,
      (credential.allowedDomains ?? []).join(" "),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
}

export function validateCredentialDraft(draft: {
  service: string;
  field: string;
  value: string;
}): string | null {
  if (!draft.service.trim()) return "Service name is required";
  if (!draft.field.trim()) return "Field name is required";
  if (!draft.value.trim()) return "Secret value is required";
  return null;
}

interface CredentialRowProps {
  credential: CredentialMetadata;
  copied: boolean;
  deleting: boolean;
  onCopyEnv: (credential: CredentialMetadata) => void;
  onDelete: (credential: CredentialMetadata) => void;
}

/**
 * A compact settings row: key icon, title and masked metadata on the left,
 * destructive action on the right. The secret itself is never rendered; only
 * the backend-provided hint (`••••1234`) and the env var name are shown.
 */
export function CredentialRow({
  credential,
  copied,
  deleting,
  onCopyEnv,
  onDelete,
}: CredentialRowProps) {
  const envName = credentialEnvVar(credential);
  const name = `${credential.service}/${credential.field}`;
  const title = credential.label || name;

  return (
    <li
      data-testid={`credential-row-${credential.service}-${credential.field}`}
      className="group flex items-center gap-3 rounded-lg border border-border/70 bg-card/40 px-3.5 py-2.5 transition-colors hover:border-border hover:bg-accent/20"
    >
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background text-muted-foreground">
        <KeyRound className="size-4" aria-hidden />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {title}
          </span>
          {credential.label ? (
            <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground sm:inline">
              {name}
            </span>
          ) : null}
          <span
            data-private
            className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground"
            title="Masked secret"
          >
            {credential.hint}
          </span>
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground">
          {credential.label ? (
            <span className="font-mono sm:hidden">{name}</span>
          ) : null}
          <span className="inline-flex min-w-0 items-center gap-1 font-mono">
            <span className="truncate">${envName}</span>
            <button
              type="button"
              data-testid={`credential-copy-env-${credential.service}-${credential.field}`}
              onClick={() => onCopyEnv(credential)}
              className="rounded-sm p-0.5 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Copy environment variable ${envName}`}
              title="Copy environment variable"
            >
              {copied ? (
                <Check className="size-3 text-emerald-500" aria-hidden />
              ) : (
                <Copy className="size-3" aria-hidden />
              )}
            </button>
          </span>

          {credential.allowedDomains && credential.allowedDomains.length > 0 ? (
            <span className="inline-flex min-w-0 items-center gap-1">
              <Globe className="size-3 shrink-0" aria-hidden />
              <span className="truncate">
                {credential.allowedDomains.join(", ")}
              </span>
            </span>
          ) : null}

          {credential.usageDescription ? (
            <span className="hidden min-w-0 truncate italic md:inline">
              {credential.usageDescription}
            </span>
          ) : null}
        </div>
      </div>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        data-testid={`credential-delete-${credential.service}-${credential.field}`}
        onClick={() => onDelete(credential)}
        disabled={deleting}
        className="size-8 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        aria-label={`Delete ${name}`}
        title="Delete credential"
      >
        {deleting ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : (
          <Trash2 className="size-4" aria-hidden />
        )}
      </Button>
    </li>
  );
}

/**
 * Secondary, collapsed explanation of how the vault works. Kept behind a
 * native `<details>` so the page leads with credentials, not architecture.
 */
export function AgentUsageDetails() {
  return (
    <details className="group rounded-lg border border-border/60 bg-card/30 px-3.5 py-2.5">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ShieldCheck className="size-3.5 text-emerald-500" aria-hidden />
        <span>How agents use credentials</span>
        <ChevronDown
          className="ml-auto size-3.5 transition-transform group-open:rotate-180"
          aria-hidden
        />
      </summary>
      <ul className="mt-2 space-y-1 border-t border-border/50 pt-2 text-xs leading-relaxed text-muted-foreground">
        <li>Secrets are encrypted at rest and never enter the model context.</li>
        <li>
          Agents receive each secret as an{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
            $AMIRO_CRED_&lt;SERVICE&gt;_&lt;FIELD&gt;
          </code>{" "}
          environment variable in tools, shell commands, and MCP headers.
        </li>
        <li>
          Allowed domains restrict brokered outbound requests to those hosts.
        </li>
      </ul>
    </details>
  );
}

export default function AdminCredentialsPage() {
  const [credentials, setCredentials] = useState<CredentialMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [copiedEnvId, setCopiedEnvId] = useState<string | null>(null);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [service, setService] = useState("");
  const [field, setField] = useState("");
  const [value, setValue] = useState("");
  const [label, setLabel] = useState("");
  const [usageDescription, setUsageDescription] = useState("");
  const [allowedDomains, setAllowedDomains] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] =
    useState<CredentialMetadata | null>(null);

  const fetchCredentialsList = async () => {
    try {
      setLoading(true);
      const items = await listCredentials();
      setCredentials(items);
    } catch (err: any) {
      toast.error(err?.message || "Failed to load credentials");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCredentialsList();
  }, []);

  const openAddDialog = (preset?: Preset) => {
    if (preset) {
      setSelectedPreset(preset.name);
      setService(preset.service);
      setField(preset.field);
      setLabel(preset.label);
      setUsageDescription(preset.usageDescription || "");
      setAllowedDomains(preset.allowedDomains || "");
    } else {
      setSelectedPreset(null);
      setService("");
      setField("");
      setLabel("");
      setUsageDescription("");
      setAllowedDomains("");
    }
    setValue("");
    setShowSecret(false);
    setDialogOpen(true);
  };

  const applyPreset = (preset: Preset) => {
    setSelectedPreset(preset.name);
    setService(preset.service);
    setField(preset.field);
    setLabel(preset.label);
    setUsageDescription(preset.usageDescription || "");
    setAllowedDomains(preset.allowedDomains || "");
  };

  const liveEnvVar = useMemo(() => {
    if (!service.trim() || !field.trim()) {
      return "AMIRO_CRED_<SERVICE>_<FIELD>";
    }
    return toCredentialEnvVar(service.trim(), field.trim());
  }, [service, field]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const validationError = validateCredentialDraft({ service, field, value });
    if (validationError) {
      toast.error(validationError);
      return;
    }

    try {
      setSaving(true);
      const domainsList = allowedDomains
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean);

      await saveCredential({
        service: service.trim(),
        field: field.trim(),
        value: value.trim(),
        label: label.trim() || undefined,
        usageDescription: usageDescription.trim() || undefined,
        allowedDomains: domainsList.length > 0 ? domainsList : undefined,
      });

      toast.success(
        `Credential for ${service.trim()}/${field.trim()} saved to vault`,
      );
      setDialogOpen(false);
      await fetchCredentialsList();
    } catch (err: any) {
      toast.error(err?.message || "Failed to save credential");
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    const credential = pendingDelete;
    if (!credential) return;
    setPendingDelete(null);

    try {
      setDeletingId(credential.id);
      await deleteCredential(credential.service, credential.field);
      toast.success(
        `Credential "${credential.service}/${credential.field}" deleted`,
      );
      await fetchCredentialsList();
    } catch (err: any) {
      toast.error(err?.message || "Failed to delete credential");
    } finally {
      setDeletingId(null);
    }
  };

  const handleCopyEnv = (credential: CredentialMetadata) => {
    const envVarName = `$${credentialEnvVar(credential)}`;
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(envVarName);
    }
    setCopiedEnvId(credential.id);
    toast.success(`Copied ${envVarName} to clipboard`);
    setTimeout(() => {
      setCopiedEnvId((prev) => (prev === credential.id ? null : prev));
    }, 2000);
  };

  const filteredCredentials = useMemo(
    () => filterCredentials(credentials, searchQuery),
    [credentials, searchQuery],
  );

  const hasCredentials = credentials.length > 0;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
      {/* Compact header */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Credentials
          </h1>
          <p className="mt-0.5 max-w-lg text-sm text-muted-foreground">
            Encrypted secrets your agents can use without ever seeing them.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={fetchCredentialsList}
            disabled={loading}
            className="size-8"
            aria-label="Refresh credentials"
            title="Refresh credentials"
          >
            <RefreshCw
              className={`size-4 ${loading ? "animate-spin" : ""}`}
              aria-hidden
            />
          </Button>
          <Button
            type="button"
            data-testid="credentials-add-button"
            size="sm"
            onClick={() => openAddDialog()}
            className="gap-1.5"
          >
            <Plus className="size-4" aria-hidden />
            Add credential
          </Button>
        </div>
      </header>

      <section className="flex flex-col gap-3">
        {hasCredentials ? (
          <div className="flex items-center gap-3">
            <div className="relative min-w-0 flex-1">
              <Search
                className="pointer-events-none absolute left-2.5 top-2 size-4 text-muted-foreground"
                aria-hidden
              />
              <Input
                data-testid="credentials-search-input"
                type="search"
                aria-label="Search credentials"
                placeholder="Search credentials"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-8 pl-8 text-sm"
              />
            </div>
            <span
              className="shrink-0 text-xs tabular-nums text-muted-foreground"
              aria-live="polite"
            >
              {filteredCredentials.length} of {credentials.length}
            </span>
          </div>
        ) : null}

        <AgentUsageDetails />

        <ul
          data-testid="credentials-list"
          className="flex min-h-[120px] flex-col gap-2"
        >
          {loading ? (
            <li className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-5 animate-spin text-primary" aria-hidden />
              Loading credentials...
            </li>
          ) : !hasCredentials ? (
            <li
              data-testid="credentials-empty"
              className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border/70 px-6 py-10 text-center"
            >
              <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-muted">
                <KeyRound className="size-5 text-muted-foreground" aria-hidden />
              </div>
              <h2 className="text-sm font-medium text-foreground">
                No credentials yet
              </h2>
              <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                Add an API key or token so your agents can use external services
                securely.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => openAddDialog()}
                className="mt-4 gap-1.5 border-dashed"
              >
                <Plus className="size-4" aria-hidden />
                Add credential
              </Button>
            </li>
          ) : filteredCredentials.length === 0 ? (
            <li className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/70 px-6 py-8 text-center">
              <p className="text-sm text-muted-foreground">
                No credentials match &ldquo;{searchQuery.trim()}&rdquo;.
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSearchQuery("")}
              >
                Clear search
              </Button>
            </li>
          ) : (
            filteredCredentials.map((credential) => (
              <CredentialRow
                key={credential.id}
                credential={credential}
                copied={copiedEnvId === credential.id}
                deleting={deletingId === credential.id}
                onCopyEnv={handleCopyEnv}
                onDelete={setPendingDelete}
              />
            ))
          )}
        </ul>
      </section>

      {/* Add credential dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent
          data-testid="credentials-add-dialog"
          className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="size-5 text-primary" aria-hidden />
              Add credential
            </DialogTitle>
            <DialogDescription>
              Stored encrypted. Agents use it at runtime without seeing the
              value.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSave} className="flex flex-col gap-4 py-1">
            <div className="flex flex-col gap-2">
              <Label className="text-xs font-medium text-muted-foreground">
                Quick start
              </Label>
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((preset) => {
                  const isSelected = selectedPreset === preset.name;
                  return (
                    <button
                      key={preset.name}
                      type="button"
                      onClick={() => applyPreset(preset)}
                      aria-pressed={isSelected}
                      className={`cursor-pointer rounded-full border px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                        isSelected
                          ? "border-primary bg-primary font-medium text-primary-foreground"
                          : "border-border/80 bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground"
                      }`}
                    >
                      {preset.name}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="service-input" className="text-xs font-medium">
                  Service <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="service-input"
                  data-testid="credential-service-input"
                  placeholder="e.g. github"
                  value={service}
                  onChange={(e) => setService(e.target.value)}
                  autoComplete="off"
                  required
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="field-input" className="text-xs font-medium">
                  Field <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="field-input"
                  data-testid="credential-field-input"
                  placeholder="e.g. token"
                  value={field}
                  onChange={(e) => setField(e.target.value)}
                  autoComplete="off"
                  required
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="value-input" className="text-xs font-medium">
                Secret value <span className="text-destructive">*</span>
              </Label>
              <div className="relative">
                <Input
                  id="value-input"
                  data-testid="credential-value-input"
                  type={showSecret ? "text" : "password"}
                  placeholder="Paste your key, token, or password"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  className="pr-10 font-mono text-sm"
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowSecret(!showSecret)}
                  className="absolute right-2.5 top-2 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={showSecret ? "Hide secret" : "Show secret"}
                  title={showSecret ? "Hide secret" : "Show secret"}
                >
                  {showSecret ? (
                    <EyeOff className="size-4" aria-hidden />
                  ) : (
                    <Eye className="size-4" aria-hidden />
                  )}
                </button>
              </div>
              <span className="text-[11px] text-muted-foreground">
                Encrypted with AES-256-GCM. Plaintext is never returned.
              </span>
            </div>

            {/* Optional metadata stays out of the way until needed. */}
            <details className="group rounded-lg border border-border/70 px-3.5 py-2.5">
              <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                <span>Optional details</span>
                <span className="font-normal text-muted-foreground/80">
                  label, guidance, allowed domains
                </span>
                <ChevronDown
                  className="ml-auto size-3.5 transition-transform group-open:rotate-180"
                  aria-hidden
                />
              </summary>

              <div className="mt-3 flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="label-input" className="text-xs font-medium">
                    Label
                  </Label>
                  <Input
                    id="label-input"
                    data-testid="credential-label-input"
                    placeholder="e.g. Production Stripe Key"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="usage-input" className="text-xs font-medium">
                    Agent guidance
                  </Label>
                  <Input
                    id="usage-input"
                    data-testid="credential-usage-input"
                    placeholder="e.g. Use for billing and charge inspection"
                    value={usageDescription}
                    onChange={(e) => setUsageDescription(e.target.value)}
                  />
                  <span className="text-[11px] text-muted-foreground">
                    Tells the agent when to pick this credential.
                  </span>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="domains-input" className="text-xs font-medium">
                    Allowed domains
                  </Label>
                  <Input
                    id="domains-input"
                    data-testid="credential-domains-input"
                    placeholder="e.g. api.stripe.com, stripe.com"
                    value={allowedDomains}
                    onChange={(e) => setAllowedDomains(e.target.value)}
                  />
                  <span className="text-[11px] text-muted-foreground">
                    Comma-separated. Broker only forwards the secret to these
                    hosts.
                  </span>
                </div>

                <div className="rounded-md border border-border/70 bg-muted/30 p-2.5">
                  <div className="text-[11px] font-medium text-foreground">
                    Agent environment variable
                  </div>
                  <code className="mt-0.5 block break-all font-mono text-[11px] font-semibold text-primary">
                    ${liveEnvVar}
                  </code>
                </div>
              </div>
            </details>

            <DialogFooter className="pt-1">
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialogOpen(false)}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                data-testid="credential-save-button"
                disabled={saving}
                className="gap-2"
              >
                {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
                Save credential
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent data-testid="credentials-delete-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete credential?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? `${pendingDelete.service}/${pendingDelete.field} will be removed from the vault. Agents will lose access immediately.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="credential-delete-cancel">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="credential-delete-confirm"
              onClick={(event) => {
                event.preventDefault();
                void confirmDelete();
              }}
              disabled={deletingId !== null}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              Delete credential
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
