import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2 } from "lucide-react";

export interface ConnectedChannelHeaderProps {
  address?: string;
  isReady: boolean;
  pending?: boolean;
  onDisconnect?: () => void;
  disconnectLabel?: string;
  disconnectingLabel?: string;
  connectedLabel?: string;
  readyLabel?: string;
}

/**
 * Top bar inside a connected channel card (Slack, Telegram, Phone, Discord).
 * Displays connection status badge, address / bot handle, and right-aligned disconnect button.
 */
export function ConnectedChannelHeader({
  address,
  isReady,
  pending = false,
  onDisconnect,
  disconnectLabel = "Disconnect",
  disconnectingLabel = "Disconnecting…",
  connectedLabel = "Connected",
  readyLabel = "Active",
}: ConnectedChannelHeaderProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/30 p-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <Badge
          variant="outline"
          className="gap-1 border-primary/20 bg-primary/10 text-primary"
        >
          <CheckCircle2 className="size-3" />
          {isReady ? readyLabel : connectedLabel}
        </Badge>
        {address ? (
          <span className="truncate font-mono text-xs text-muted-foreground">
            {address}
          </span>
        ) : null}
      </div>

      {onDisconnect ? (
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={onDisconnect}
          disabled={pending}
          className="h-7 text-xs"
        >
          {pending ? disconnectingLabel : disconnectLabel}
        </Button>
      ) : null}
    </div>
  );
}
