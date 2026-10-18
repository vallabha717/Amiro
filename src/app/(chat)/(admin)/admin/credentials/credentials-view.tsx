"use client";

import {
  Check,
  ChevronDown,
  Copy,
  Globe,
  KeyRound,
  Loader2,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CredentialMetadata } from "@/lib/backend/credentials-api";
import { credentialEnvVar } from "./credentials-view-utils";

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
