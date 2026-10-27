"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Check,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  Loader2,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  revealCredential,
  type CredentialMetadata,
} from "@/lib/backend/credentials-api";
import { credentialEnvVar } from "./credentials-view-utils";

interface CredentialRowProps {
  credential: CredentialMetadata;
  copied: boolean;
  deleting: boolean;
  onCopyEnv: (credential: CredentialMetadata) => void;
  onDelete: (credential: CredentialMetadata) => void;
}

/** Auto-hide a revealed secret so it does not stay on screen unattended. */
const REVEAL_TIMEOUT_MS = 30_000;

/** Stand-in shown (blurred) before reveal; it is never the real value. */
const BLURRED_PLACEHOLDER = "••••••••••••••••••••";

/**
 * The secret value, blurred until clicked. The real value is fetched from the
 * admin-only reveal endpoint on click, kept in component state only, and
 * dropped again when hidden or after `REVEAL_TIMEOUT_MS`. Copy is offered only
 * while the value is revealed.
 */
function RevealableValue({ credential }: { credential: CredentialMetadata }) {
  const [value, setValue] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const name = `${credential.service}/${credential.field}`;
  const revealed = value !== null;

  useEffect(() => {
    if (!revealed) return;
    const timer = setTimeout(() => setValue(null), REVEAL_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [revealed]);

  async function reveal() {
    setLoading(true);
    try {
      setValue(await revealCredential(credential.service, credential.field));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not reveal credential",
      );
    } finally {
      setLoading(false);
    }
  }

  async function copy() {
    if (value === null) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy to the clipboard");
    }
  }

  const frame =
    "inline-flex min-w-0 max-w-[22rem] items-center gap-1 rounded-md border border-border/60 bg-muted/50 font-mono text-[11px] text-foreground";
  const iconButton =
    "rounded-sm p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  const testId = `credential-value-${credential.service}-${credential.field}`;

  if (!revealed) {
    return (
      <button
        type="button"
        data-private
        data-testid={testId}
        data-revealed="false"
        onClick={reveal}
        disabled={loading}
        aria-label={`Click to reveal value of ${name}`}
        title="Click to reveal"
        className={`${frame} cursor-pointer px-2 py-0.5 hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait`}
      >
        <span
          aria-hidden
          className="truncate select-none blur-[5px] transition-[filter]"
        >
          {BLURRED_PLACEHOLDER}
        </span>
        {loading ? (
          <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />
        ) : (
          <Eye className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        )}
      </button>
    );
  }

  return (
    <span
      data-private
      data-testid={testId}
      data-revealed="true"
      className={`${frame} pl-2`}
    >
      <span className="truncate select-all">{value}</span>
      <button
        type="button"
        onClick={copy}
        data-testid={`credential-copy-value-${credential.service}-${credential.field}`}
        aria-label={`Copy value of ${name}`}
        title="Copy value"
        className={iconButton}
      >
        {copied ? (
          <Check className="size-3 text-emerald-500" aria-hidden />
        ) : (
          <Copy className="size-3" aria-hidden />
        )}
      </button>
      <button
        type="button"
        onClick={() => setValue(null)}
        data-testid={`credential-hide-${credential.service}-${credential.field}`}
        aria-label={`Hide value of ${name}`}
        title="Hide"
        className={iconButton}
      >
        <EyeOff className="size-3" aria-hidden />
      </button>
    </span>
  );
}

/**
 * A compact settings row: key icon, title and, on the `$ENV_VAR = value` line, the blurred secret,
 * destructive action on the right. The value is only fetched and shown after
 * an explicit click on the blurred field.
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
            <span aria-hidden>=</span>
            <RevealableValue credential={credential} />
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
