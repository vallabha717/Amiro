"use client";

import { useState } from "react";
import {
  ExternalLink,
  Loader2,
  CheckCircle2,
  Sparkles,
  PlugZap,
  Radio,
  Copy,
  Check,
} from "lucide-react";
import { Button } from "ui/button";
import { Input } from "ui/input";
import { toast } from "sonner";
import { apiJson } from "@/lib/backend/client";

export interface OAuthConnectRequest {
  id: string;
  type: "provider" | "mcp" | "composio" | "custom";
  provider?: string;
  server?: string;
  toolkit?: string;
  connectionId?: string;
  flow?: "authorization_code" | "device_code";
  authorizationUrl?: string;
  redirectUrl?: string;
  userCode?: string;
  verificationUri?: string;
}

export function OAuthConnectCard({
  connect,
  readonly = false,
  onDone,
}: {
  connect: OAuthConnectRequest;
  readonly?: boolean;
  onDone?: (msg: string) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<string>("pending");
  const [copiedCode, setCopiedCode] = useState(false);
  const [authCode, setAuthCode] = useState("");
  const [submittingCode, setSubmittingCode] = useState(false);

  const authUrl = connect.authorizationUrl || connect.redirectUrl || "";
  const title = connect.provider
    ? `${connect.provider.toUpperCase()} Login`
    : connect.toolkit
      ? `Connect ${connect.toolkit}`
      : connect.server
        ? `MCP Server: ${connect.server}`
        : "Connect Account";

  const handleCopyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
    toast.success("Code copied to clipboard");
  };

  const handleCheckStatus = async () => {
    setChecking(true);
    try {
      if (connect.type === "provider" && connect.provider) {
        const res = await apiJson<any>(
          `/api/providers/${encodeURIComponent(connect.provider)}/oauth/status`,
        );
        setStatus(res?.status || "pending");
        if (res?.status === "authorized" || res?.status === "success") {
          toast.success(`${connect.provider} is authorized!`);
          onDone?.(`I've logged in to ${connect.provider}. Please proceed.`);
        } else {
          toast.info(`Status: ${res?.status || "Pending authorization"}`);
        }
      } else if (connect.type === "mcp" && connect.server) {
        const res = await apiJson<any>(
          `/api/connectors/${encodeURIComponent(connect.server)}/oauth/status`,
        );
        setStatus(res?.status || "pending");
        if (res?.status === "authorized" || res?.status === "success") {
          toast.success(`${connect.server} is authorized!`);
          onDone?.(`I've authorized ${connect.server}. Please proceed.`);
        } else {
          toast.info(`Status: ${res?.status || "Pending authorization"}`);
        }
      } else if (connect.type === "composio" && connect.connectionId) {
        const res = await apiJson<any>(
          `/api/composio/connections/${encodeURIComponent(connect.connectionId)}/status`,
        );
        setStatus(res?.status || "pending");
        if (res?.status === "ACTIVE" || res?.status === "CONNECTED") {
          toast.success(`${connect.toolkit || "App"} connected!`);
          onDone?.(
            `I've authorized ${connect.toolkit || "the app"}. Please proceed.`,
          );
        } else {
          toast.info(`Status: ${res?.status || "Pending"}`);
        }
      }
    } catch (err: any) {
      toast.error(err?.message || "Failed to check status");
    } finally {
      setChecking(false);
    }
  };

  const handleSubmitCallbackCode = async () => {
    if (!authCode.trim() || !connect.provider) return;
    setSubmittingCode(true);
    try {
      await apiJson(
        `/api/providers/${encodeURIComponent(connect.provider)}/oauth/callback`,
        {
          method: "POST",
          body: JSON.stringify({ code: authCode.trim() }),
        },
      );
      setStatus("authorized");
      toast.success(`${connect.provider} login completed!`);
      onDone?.(`I've completed login for ${connect.provider}. Please proceed.`);
    } catch (err: any) {
      toast.error(err?.message || "Failed to complete authorization code");
    } finally {
      setSubmittingCode(false);
    }
  };

  const isComplete =
    status === "authorized" || status === "success" || status === "ACTIVE";

  return (
    <div
      className="my-3 w-full max-w-lg overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-all"
      data-testid="oauth-connect-card"
      data-type={connect.type}
    >
      <div className="flex items-center justify-between border-b border-border bg-muted/40 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-lg bg-primary/10 text-primary">
            <PlugZap className="size-4" />
          </span>
          <div>
            <h4 className="text-sm font-semibold text-foreground">{title}</h4>
            <p className="text-[11px] text-muted-foreground">
              Interactive OAuth Authorization
            </p>
          </div>
        </div>
        {isComplete ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="size-3" />
            Connected
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-600 dark:text-sky-400">
            <Radio className="size-2.5 animate-pulse" />
            Waiting for approval
          </span>
        )}
      </div>

      <div className="space-y-3.5 p-4">
        {connect.userCode ? (
          <div className="space-y-2.5 rounded-lg border border-border/80 bg-muted/20 p-3.5">
            <p className="text-xs text-muted-foreground">
              1. Copy your verification code:
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-base font-bold tracking-wider text-foreground">
                {connect.userCode}
              </code>
              <Button
                size="sm"
                variant="outline"
                className="h-9 gap-1.5 text-xs"
                onClick={() => handleCopyCode(connect.userCode!)}
              >
                {copiedCode ? (
                  <Check className="size-3.5 text-emerald-600" />
                ) : (
                  <Copy className="size-3.5" />
                )}
                {copiedCode ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground pt-1">
              2. Open the login page and paste the code:
            </p>
            {authUrl && (
              <Button asChild size="sm" className="w-full gap-1.5">
                <a href={authUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="size-3.5" />
                  Open {connect.provider || "Login"} Page
                </a>
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-2.5">
            <p className="text-xs text-muted-foreground leading-relaxed">
              Sign in with your account to authorize access. After approving in
              your browser, return here to continue.
            </p>
            {authUrl && (
              <Button asChild size="sm" className="w-full gap-1.5">
                <a href={authUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="size-3.5" />
                  Authorize {connect.provider || connect.toolkit || "Account"}
                </a>
              </Button>
            )}
          </div>
        )}

        {/* Optional manual authorization code input for loopback callback fallback */}
        {connect.type === "provider" && !connect.userCode && !isComplete && (
          <div className="border-t border-border/60 pt-3 space-y-2">
            <p className="text-[11px] text-muted-foreground">
              If the browser redirects to a URL with a code (or localhost fails
              to open), paste it below:
            </p>
            <div className="flex gap-2">
              <Input
                value={authCode}
                onChange={(e) => setAuthCode(e.target.value)}
                placeholder="Paste authorization code or callback URL"
                className="h-8 text-xs font-mono"
              />
              <Button
                size="sm"
                className="h-8 text-xs shrink-0"
                disabled={!authCode.trim() || submittingCode}
                onClick={handleSubmitCallbackCode}
              >
                {submittingCode && (
                  <Loader2 className="size-3 animate-spin mr-1" />
                )}
                Submit Code
              </Button>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between border-t border-border/60 pt-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={handleCheckStatus}
            disabled={checking || isComplete}
          >
            {checking ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Sparkles className="size-3" />
            )}
            Check status
          </Button>

          {!readonly && onDone && isComplete && (
            <Button
              type="button"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={() => onDone("Connected! Let's continue.")}
            >
              Continue
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
