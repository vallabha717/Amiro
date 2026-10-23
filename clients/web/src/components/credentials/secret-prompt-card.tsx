"use client";

import { useId, useState, type FormEvent } from "react";
import useSWR, { useSWRConfig } from "swr";
import {
  CheckCircle2,
  Eye,
  EyeOff,
  Globe,
  Info,
  KeyRound,
  Loader2,
  Lock,
  RotateCw,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { Button } from "ui/button";
import { Input } from "ui/input";
import { Label } from "ui/label";
import {
  listCredentials,
  saveCredential,
  toCredentialEnvVar,
  type CredentialMetadata,
} from "@/lib/backend/credentials-api";

export interface SecretPromptRequest {
  id: string;
  service: string;
  field: string;
  label?: string;
  description?: string;
  placeholder?: string;
  purpose?: string;
  allowedDomains?: string[];
  allowedTools?: string[];
}

export interface SecretPromptCardProps {
  prompt: SecretPromptRequest;
  readonly?: boolean;
  onSaved?: (message: string) => void;
  onCancel?: () => void;
}

export function useCredentials() {
  return useSWR<CredentialMetadata[]>("/api/credentials", () => listCredentials(), {
    revalidateOnFocus: false,
  });
}

function ContextChip({
  icon: Icon,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{children}</span>
    </div>
  );
}

export function SecretPromptCard({
  prompt,
  readonly = false,
  onSaved,
  onCancel,
}: SecretPromptCardProps) {
  const inputId = useId();
  const { data: credentials } = useCredentials();
  const { mutate } = useSWRConfig();

  const [value, setValue] = useState("");
  const [isRevealed, setIsRevealed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [notified, setNotified] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const envVar = toCredentialEnvVar(prompt.service, prompt.field);
  const existing = credentials?.find(
    (c) => c.service === prompt.service && c.field === prompt.field,
  );
  const isStored = Boolean(existing) || saved;

  const trimmedValue = value.trim();
  const canSubmit = trimmedValue.length > 0 && !isSubmitting && !readonly;
  const displayName = prompt.label || `${prompt.service} / ${prompt.field}`;

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    setIsSubmitting(true);
    setError(null);

    try {
      await saveCredential({
        service: prompt.service,
        field: prompt.field,
        value: trimmedValue,
        label: prompt.label,
        usageDescription: prompt.purpose || prompt.description,
        allowedDomains: prompt.allowedDomains,
        allowedTools: prompt.allowedTools,
      });

      await mutate("/api/credentials");
      setValue("");
      setIsRevealed(false);
      setSaved(true);
      setIsEditing(false);
      setNotified(true);

      const successNotice =
        "I've saved the " +
        displayName +
        " credential in the encrypted vault (" +
        prompt.service +
        "/" +
        prompt.field +
        "). Please continue.";
      onSaved?.(successNotice);
    } catch (err: any) {
      setError(err?.message || "Failed to store credential. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleContinue = () => {
    setNotified(true);
    const continueNotice =
      "I've stored the credential in the vault as " +
      prompt.service +
      "/" +
      prompt.field +
      ". Please continue.";
    onSaved?.(continueNotice);
  };

  return (
    <div
      className="my-3 w-full max-w-lg overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-all"
      data-testid="secret-prompt-card"
      data-service={prompt.service}
      data-field={prompt.field}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border bg-muted/40 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-lg bg-primary/10 text-primary">
            <Lock className="size-4" />
          </span>
          <div>
            <h4 className="text-sm font-semibold text-foreground">
              {displayName}
            </h4>
            <p className="font-mono text-[11px] text-muted-foreground">
              ${envVar}
            </p>
          </div>
        </div>
        {isStored && !isEditing && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400"
            data-testid="secret-prompt-saved"
          >
            <CheckCircle2 className="size-3" />
            Vault secured
          </span>
        )}
      </div>

      <div className="space-y-3.5 p-4">
        {/* Chips for purpose, tools, domains */}
        {(prompt.purpose || prompt.allowedTools?.length || prompt.allowedDomains?.length) && (
          <div className="flex flex-wrap gap-1.5">
            {prompt.purpose && (
              <ContextChip icon={Info}>Purpose: {prompt.purpose}</ContextChip>
            )}
            {prompt.allowedTools && prompt.allowedTools.length > 0 && (
              <ContextChip icon={Wrench}>
                Tools: {prompt.allowedTools.join(", ")}
              </ContextChip>
            )}
            {prompt.allowedDomains && prompt.allowedDomains.length > 0 && (
              <ContextChip icon={Globe}>
                Domains: {prompt.allowedDomains.join(", ")}
              </ContextChip>
            )}
          </div>
        )}

        {prompt.description && (
          <p className="text-xs text-muted-foreground leading-relaxed">
            {prompt.description}
          </p>
        )}

        {/* Existing credential view */}
        {isStored && !isEditing ? (
          <div className="space-y-3 rounded-lg border border-border/80 bg-muted/20 p-3.5">
            <div className="flex items-start gap-2.5">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <div className="space-y-1 text-xs">
                <p className="font-medium text-foreground">
                  Saved securely to vault · {prompt.service}/{prompt.field}
                </p>
                <p className="text-muted-foreground">
                  The agent references this key via <code className="font-mono text-foreground">${envVar}</code> and never sees raw plaintext.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between pt-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setIsEditing(true)}
                disabled={readonly}
              >
                <RotateCw className="size-3" />
                Update key
              </Button>

              {!readonly && onSaved && (
                <Button
                  type="button"
                  size="sm"
                  className="h-8 gap-1.5 text-xs"
                  onClick={handleContinue}
                  disabled={notified}
                >
                  <KeyRound className="size-3.5" />
                  {notified ? "Agent notified" : "Continue"}
                </Button>
              )}
            </div>
          </div>
        ) : (
          /* Secret input form */
          <form onSubmit={handleSave} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor={inputId} className="text-xs font-medium text-foreground">
                Enter {displayName}
              </Label>
              <div className="relative flex items-center">
                <Input
                  id={inputId}
                  type={isRevealed ? "text" : "password"}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={prompt.placeholder || `Enter ${prompt.field}...`}
                  disabled={isSubmitting || readonly}
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                  data-private
                  data-testid="secret-prompt-input"
                  className="pr-10 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => setIsRevealed((prev) => !prev)}
                  disabled={isSubmitting || readonly}
                  className="absolute right-2.5 text-muted-foreground transition hover:text-foreground disabled:opacity-50"
                  aria-label={isRevealed ? "Hide secret" : "Show secret"}
                >
                  {isRevealed ? (
                    <EyeOff className="size-4" />
                  ) : (
                    <Eye className="size-4" />
                  )}
                </button>
              </div>
            </div>

            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <ShieldCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" />
              <span>Never echoed in chat. Stored in local encrypted vault.</span>
            </div>

            {error && (
              <p className="text-xs text-destructive">{error}</p>
            )}

            <div className="flex items-center justify-between pt-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 text-xs"
                onClick={() => {
                  if (isEditing) {
                    setIsEditing(false);
                    setValue("");
                  } else {
                    onCancel?.();
                  }
                }}
                disabled={isSubmitting}
                data-testid="secret-prompt-cancel"
              >
                Cancel
              </Button>

              <Button
                type="submit"
                size="sm"
                className="h-8 gap-1.5 text-xs"
                disabled={!canSubmit}
                data-testid="secret-prompt-save"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    Saving…
                  </>
                ) : (
                  <>
                    <ShieldCheck className="size-3.5" />
                    Save securely
                  </>
                )}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
