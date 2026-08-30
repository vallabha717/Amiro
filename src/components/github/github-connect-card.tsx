"use client";

import { useGitHubStatus } from "@/hooks/queries/use-github";
import {
  GITHUB_STATUS_KEY,
  connectGitHub,
  disconnectGitHub,
} from "@/lib/backend/github-api";
import { Github, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { mutate } from "swr";
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
import { handleErrorWithToast } from "ui/shared-toast";

/**
 * Distinct from the AI provider-key form, per
 * docs/coding-agent-parity/04-git-remote-operations.md: a provider key
 * controls model spend, this one controls write access to a user's
 * repositories, so it gets its own card and its own storage entry
 * (internal/secrets, keyed separately from any provider) rather than
 * folding into ProviderSettingsCard.
 */
export function GitHubConnectCard() {
  const { data, isLoading } = useGitHubStatus();
  const connected = data?.connected ?? false;

  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  const handleConnect = async () => {
    const trimmed = token.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await connectGitHub(trimmed);
      setToken("");
      toast.success("GitHub connected");
      mutate(GITHUB_STATUS_KEY);
    } catch (err) {
      handleErrorWithToast(err as Error);
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    setBusy(true);
    try {
      await disconnectGitHub();
      toast.success("GitHub disconnected");
      mutate(GITHUB_STATUS_KEY);
    } catch (err) {
      handleErrorWithToast(err as Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card data-testid="github-connect-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Github className="size-4" />
          GitHub
        </CardTitle>
        <CardDescription>
          Connect a personal access token so the agent can push branches and
          open pull requests. A push or pull request always asks for your
          approval first, in every mode.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {isLoading ? null : connected ? (
          <div
            data-testid="github-connected-row"
            className="flex items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2"
          >
            <Badge
              variant="outline"
              className="w-fit text-[10px]"
              data-testid="github-status-badge"
            >
              connected
            </Badge>
            <Button
              variant="ghost"
              size="icon"
              data-testid="github-disconnect-button"
              disabled={busy}
              onClick={handleDisconnect}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Badge
              variant="outline"
              className="w-fit text-[10px]"
              data-testid="github-status-badge"
            >
              not connected
            </Badge>
            <div className="flex gap-2">
              <Input
                type="password"
                placeholder="paste a personal access token"
                value={token}
                disabled={busy}
                data-testid="github-token-input"
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleConnect();
                }}
              />
              <Button
                size="sm"
                disabled={busy || !token.trim()}
                data-testid="github-connect-button"
                onClick={handleConnect}
              >
                Connect
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
