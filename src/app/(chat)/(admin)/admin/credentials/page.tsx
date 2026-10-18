"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Terminal,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { ScrollArea } from "@/components/ui/scroll-area";
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
    name: "GitHub Token (github / token)",
    service: "github",
    field: "token",
    label: "GitHub Personal Access Token",
    usageDescription: "Use for GitHub API interactions and git operations",
    allowedDomains: "api.github.com, github.com",
  },
  {
    name: "OpenAI API Key (openai / api_key)",
    service: "openai",
    field: "api_key",
    label: "OpenAI API Key",
    usageDescription: "Use for OpenAI LLM and embeddings generation",
    allowedDomains: "api.openai.com",
  },
  {
    name: "9Router Key (9router / api_key)",
    service: "9router",
    field: "api_key",
    label: "9Router Gateway Key",
    usageDescription: "Use for multi-model LLM routing via 9Router",
    allowedDomains: "api.9router.com",
  },
  {
    name: "Composio Key (composio / api_key)",
    service: "composio",
    field: "api_key",
    label: "Composio API Key",
    usageDescription: "Use for Composio external tool execution",
    allowedDomains: "backend.composio.dev",
  },
  {
    name: "Slack Bot Token (slack / bot_token)",
    service: "slack",
    field: "bot_token",
    label: "Slack Bot Token",
    usageDescription: "Use for Slack messaging and channel operations",
    allowedDomains: "slack.com",
  },
  {
    name: "Custom Service",
    service: "",
    field: "",
    label: "",
    usageDescription: "",
    allowedDomains: "",
  },
];

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
    if (!service.trim()) {
      toast.error("Service name is required");
      return;
    }
    if (!field.trim()) {
      toast.error("Field name is required");
      return;
    }
    if (!value.trim()) {
      toast.error("Secret value is required");
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

  const handleDelete = async (cred: CredentialMetadata) => {
    const confirmDelete = window.confirm(
      `Are you sure you want to delete credential "${cred.service}/${cred.field}"? Agents will no longer have access to this secret.`,
    );
    if (!confirmDelete) return;

    try {
      setDeletingId(cred.id);
      await deleteCredential(cred.service, cred.field);
      toast.success(`Credential "${cred.service}/${cred.field}" deleted`);
      await fetchCredentialsList();
    } catch (err: any) {
      toast.error(err?.message || "Failed to delete credential");
    } finally {
      setDeletingId(null);
    }
  };

  const handleCopyEnv = (cred: CredentialMetadata) => {
    const envVarName = `$${cred.envVar || toCredentialEnvVar(cred.service, cred.field)}`;
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(envVarName);
    }
    setCopiedEnvId(cred.id);
    toast.success(`Copied ${envVarName} to clipboard`);
    setTimeout(() => {
      setCopiedEnvId((prev) => (prev === cred.id ? null : prev));
    }, 2000);
  };

  const filteredCredentials = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return credentials;
    return credentials.filter((c) => {
      const idMatch = c.id.toLowerCase().includes(q);
      const serviceMatch = c.service.toLowerCase().includes(q);
      const fieldMatch = c.field.toLowerCase().includes(q);
      const labelMatch = c.label?.toLowerCase().includes(q) ?? false;
      const usageMatch = c.usageDescription?.toLowerCase().includes(q) ?? false;
      const envVarMatch =
        (c.envVar || toCredentialEnvVar(c.service, c.field))
          .toLowerCase()
          .includes(q);
      return (
        idMatch ||
        serviceMatch ||
        fieldMatch ||
        labelMatch ||
        usageMatch ||
        envVarMatch
      );
    });
  }, [credentials, searchQuery]);

  return (
    <ScrollArea className="h-full w-full">
      <div className="max-w-4xl mx-auto px-6 py-8 flex flex-col gap-8">
        {/* Top Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2.5">
              <KeyRound className="size-6 text-primary" />
              Credentials &amp; Secret Vault
            </h1>
            <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl leading-relaxed">
              Amiro encrypts secrets at rest with AES-256-GCM in{" "}
              <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                protected/credentials.enc
              </code>
              . Agents access secrets safely via environment variable bindings (
              <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                $AMIRO_CRED_&lt;SERVICE&gt;_&lt;FIELD&gt;
              </code>
              ), MCP header expansion, and domain-scoped brokered requests
              without exposing plaintext to the LLM context.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={fetchCredentialsList}
              disabled={loading}
              title="Refresh credentials"
            >
              <RefreshCw
                className={`size-4 ${loading ? "animate-spin" : ""}`}
              />
            </Button>
            <Button
              data-testid="credentials-add-button"
              onClick={() => openAddDialog()}
              className="gap-2"
            >
              <Plus className="size-4" />
              Add Credential
            </Button>
          </div>
        </div>

        {/* Informational Card */}
        <Card
          data-testid="credentials-agent-guide-card"
          className="bg-card/60 border-border/80"
        >
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="size-5 text-emerald-500" />
              How Agents Use Your Credentials
            </CardTitle>
            <CardDescription>
              Security architecture ensuring models can perform authorized actions
              without ever reading secrets in plaintext.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-3 pt-0">
            <div className="rounded-lg border border-border/60 bg-background/50 p-3.5 flex flex-col gap-1.5">
              <div className="flex items-center gap-2 font-medium text-sm text-foreground">
                <Lock className="size-4 text-primary" />
                <span>Zero-Plaintext LLM Context</span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Secrets are sealed with AES-256-GCM (
                <code className="font-mono text-[11px]">
                  protected/credentials.enc
                </code>
                ). Agents only see metadata (
                <code className="font-mono text-[11px]">service/field</code>,
                label, and{" "}
                <code className="font-mono text-[11px]">$AMIRO_CRED_*</code>{" "}
                variable name).
              </p>
            </div>

            <div className="rounded-lg border border-border/60 bg-background/50 p-3.5 flex flex-col gap-1.5">
              <div className="flex items-center gap-2 font-medium text-sm text-foreground">
                <Terminal className="size-4 text-primary" />
                <span>Automatic Tool &amp; Shell Injection</span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Every stored credential is injected into the runtime environment
                as{" "}
                <code className="font-mono text-[11px]">
                  $AMIRO_CRED_&lt;SERVICE&gt;_&lt;FIELD&gt;
                </code>{" "}
                so <code className="font-mono text-[11px]">bash</code>,{" "}
                <code className="font-mono text-[11px]">mcp.json</code> headers
                (<code className="font-mono text-[11px]">${"{AMIRO_CRED_...}"}</code>
                ), and custom search providers can authenticate without echoing
                the key.
              </p>
            </div>

            <div className="rounded-lg border border-border/60 bg-background/50 p-3.5 flex flex-col gap-1.5">
              <div className="flex items-center gap-2 font-medium text-sm text-foreground">
                <Globe className="size-4 text-primary" />
                <span>Domain-Scoped Brokered Requests</span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Credentials with{" "}
                <code className="font-mono text-[11px]">allowedDomains</code>{" "}
                are enforced by the backend Credential Broker (
                <code className="font-mono text-[11px]">
                  /api/credentials/broker
                </code>
                ) and scrubbed from responses.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Search & Credentials List */}
        <section className="flex flex-col gap-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground pointer-events-none" />
              <Input
                data-testid="credentials-search-input"
                placeholder="Search credentials by service, label, env var..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 h-9"
              />
            </div>
            <div className="text-xs text-muted-foreground font-mono">
              {filteredCredentials.length} credential
              {filteredCredentials.length === 1 ? "" : "s"} configured
            </div>
          </div>

          <div
            data-testid="credentials-list"
            className="flex flex-col gap-3 min-h-[160px]"
          >
            {loading ? (
              <div className="flex flex-col items-center justify-center p-12 text-muted-foreground gap-3 border rounded-xl bg-card/20">
                <Loader2 className="size-6 animate-spin text-primary" />
                <span className="text-sm">Loading credential vault...</span>
              </div>
            ) : filteredCredentials.length === 0 ? (
              <div
                data-testid="credentials-empty"
                className="flex flex-col items-center justify-center p-12 text-center border border-dashed rounded-xl bg-card/20"
              >
                <div className="size-12 rounded-full bg-muted flex items-center justify-center mb-3">
                  <KeyRound className="size-6 text-muted-foreground" />
                </div>
                <h3 className="font-medium text-base text-foreground">
                  {searchQuery ? "No matching credentials" : "No credentials stored yet"}
                </h3>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm">
                  {searchQuery
                    ? "Try adjusting your search terms or clear the filter."
                    : "Add API keys, tokens, or private secrets so your agents can access external tools securely."}
                </p>
                {!searchQuery && (
                  <Button
                    onClick={() => openAddDialog()}
                    size="sm"
                    className="mt-4 gap-2"
                  >
                    <Plus className="size-4" />
                    Add your first credential
                  </Button>
                )}
              </div>
            ) : (
              filteredCredentials.map((cred) => {
                const envName =
                  cred.envVar || toCredentialEnvVar(cred.service, cred.field);
                const rowTestId = `credential-row-${cred.service}-${cred.field}`;
                const copyTestId = `credential-copy-env-${cred.service}-${cred.field}`;
                const deleteTestId = `credential-delete-${cred.service}-${cred.field}`;

                return (
                  <Card
                    key={cred.id}
                    data-testid={rowTestId}
                    className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:border-border transition-colors bg-card/40"
                  >
                    <div className="flex items-start sm:items-center gap-3.5 min-w-0">
                      <div className="size-9 rounded-lg border border-border/80 bg-background flex items-center justify-center shrink-0 text-muted-foreground">
                        <KeyRound className="size-4 text-primary" />
                      </div>
                      <div className="flex flex-col min-w-0 gap-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-sm text-foreground">
                            {cred.label || `${cred.service}/${cred.field}`}
                          </span>
                          <Badge
                            variant="secondary"
                            className="font-mono text-[11px] px-1.5 py-0"
                          >
                            {cred.service}/{cred.field}
                          </Badge>
                          <Badge
                            variant="outline"
                            className="font-mono text-[11px] px-1.5 py-0 text-muted-foreground"
                          >
                            {cred.hint}
                          </Badge>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <div className="flex items-center gap-1.5 bg-muted/60 border border-border/60 px-2 py-0.5 rounded text-xs font-mono text-muted-foreground">
                            <span>${envName}</span>
                            <button
                              type="button"
                              data-testid={copyTestId}
                              onClick={() => handleCopyEnv(cred)}
                              className="hover:text-foreground transition-colors p-0.5 rounded cursor-pointer"
                              title="Copy Env Var name"
                            >
                              {copiedEnvId === cred.id ? (
                                <Check className="size-3 text-emerald-500" />
                              ) : (
                                <Copy className="size-3" />
                              )}
                            </button>
                          </div>

                          {cred.allowedDomains && cred.allowedDomains.length > 0 && (
                            <Badge
                              variant="outline"
                              className="text-[11px] gap-1 text-sky-600 dark:text-sky-400 border-sky-300 dark:border-sky-800"
                            >
                              <Globe className="size-3" />
                              {cred.allowedDomains.join(", ")}
                            </Badge>
                          )}
                        </div>

                        {cred.usageDescription && (
                          <p className="text-xs text-muted-foreground line-clamp-1 italic">
                            &ldquo;{cred.usageDescription}&rdquo;
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                      <Button
                        variant="ghost"
                        size="sm"
                        data-testid={deleteTestId}
                        onClick={() => handleDelete(cred)}
                        disabled={deletingId === cred.id}
                        className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 h-8 px-2.5"
                        title="Delete credential"
                      >
                        {deletingId === cred.id ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Trash2 className="size-4" />
                        )}
                      </Button>
                    </div>
                  </Card>
                );
              })
            )}
          </div>
        </section>

        {/* Add Credential Modal Dialog */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent
            data-testid="credentials-add-dialog"
            className="sm:max-w-xl max-h-[90vh] overflow-y-auto"
          >
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <KeyRound className="size-5 text-primary" />
                Store New Credential
              </DialogTitle>
              <DialogDescription>
                Credentials are encrypted with AES-256-GCM. The plaintext secret
                is never exposed to LLM context.
              </DialogDescription>
            </DialogHeader>

            <form onSubmit={handleSave} className="flex flex-col gap-5 py-2">
              {/* Presets */}
              <div className="flex flex-col gap-2">
                <Label className="text-xs text-muted-foreground font-medium">
                  Quick Presets
                </Label>
                <div className="flex flex-wrap gap-1.5">
                  {PRESETS.map((p) => {
                    const isSelected = selectedPreset === p.name;
                    return (
                      <button
                        key={p.name}
                        type="button"
                        onClick={() => applyPreset(p)}
                        className={`text-xs px-2.5 py-1 rounded-full border transition-all cursor-pointer ${
                          isSelected
                            ? "bg-primary text-primary-foreground border-primary font-medium"
                            : "bg-muted/50 hover:bg-muted text-muted-foreground hover:text-foreground border-border/80"
                        }`}
                      >
                        {p.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Service & Field */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="service-input" className="text-xs font-medium">
                    Service <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="service-input"
                    data-testid="credential-service-input"
                    placeholder="e.g. github, stripe, 9router"
                    value={service}
                    onChange={(e) => setService(e.target.value)}
                    required
                  />
                  <span className="text-[11px] text-muted-foreground">
                    Namespace identifier (e.g. github)
                  </span>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="field-input" className="text-xs font-medium">
                    Field <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="field-input"
                    data-testid="credential-field-input"
                    placeholder="e.g. token, api_key"
                    value={field}
                    onChange={(e) => setField(e.target.value)}
                    required
                  />
                  <span className="text-[11px] text-muted-foreground">
                    Credential slot name (e.g. api_key)
                  </span>
                </div>
              </div>

              {/* Secret Value */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="value-input" className="text-xs font-medium">
                  Secret Value <span className="text-destructive">*</span>
                </Label>
                <div className="relative">
                  <Input
                    id="value-input"
                    data-testid="credential-value-input"
                    type={showSecret ? "text" : "password"}
                    placeholder="Paste your secret key, token, or password"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    className="pr-10 font-mono text-sm"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecret(!showSecret)}
                    className="absolute right-3 top-2.5 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                    title={showSecret ? "Hide secret" : "Show secret"}
                  >
                    {showSecret ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                  </button>
                </div>
                <span className="text-[11px] text-muted-foreground">
                  Stored encrypted with AES-256-GCM. Plaintext is never returned.
                </span>
              </div>

              {/* Label */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="label-input" className="text-xs font-medium">
                  Label (optional)
                </Label>
                <Input
                  id="label-input"
                  data-testid="credential-label-input"
                  placeholder="e.g. Production Stripe Key, Staging Bot"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </div>

              {/* Usage Description for Agent */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="usage-input" className="text-xs font-medium">
                  Usage Description for Agent (optional)
                </Label>
                <Input
                  id="usage-input"
                  data-testid="credential-usage-input"
                  placeholder="e.g. Use for Stripe billing and charge inspection calls"
                  value={usageDescription}
                  onChange={(e) => setUsageDescription(e.target.value)}
                />
                <span className="text-[11px] text-muted-foreground">
                  Injected into agent instructions to clarify when this credential should be picked.
                </span>
              </div>

              {/* Allowed Domains */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="domains-input" className="text-xs font-medium">
                  Allowed Domains (optional, comma-separated)
                </Label>
                <Input
                  id="domains-input"
                  data-testid="credential-domains-input"
                  placeholder="e.g. api.stripe.com, stripe.com"
                  value={allowedDomains}
                  onChange={(e) => setAllowedDomains(e.target.value)}
                />
                <span className="text-[11px] text-muted-foreground">
                  Outbound broker restriction: broker only forwards credential to these hostnames.
                </span>
              </div>

              {/* Live Preview of Agent Env Var */}
              <div className="rounded-lg border border-border/80 bg-muted/30 p-3 flex flex-col gap-1">
                <span className="text-xs font-medium text-foreground">
                  Agent Env Var:
                </span>
                <code className="text-xs font-mono font-semibold text-primary break-all">
                  ${liveEnvVar}
                </code>
                <span className="text-[11px] text-muted-foreground">
                  Available in tool executions, bash shell, and MCP headers via{" "}
                  <code className="text-[11px] font-mono">${"{" + liveEnvVar + "}"}</code>.
                </span>
              </div>

              <DialogFooter className="pt-2">
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
                  {saving && <Loader2 className="size-4 animate-spin" />}
                  Save Credential
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </ScrollArea>
  );
}
