import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { ChannelIcon } from "./channel-presentation";
import type { SetupChannelId } from "@/lib/backend/channels-api";

export interface ChannelItem {
  id: string;
  label: string;
}

export interface ChannelSnapshot {
  channel: string;
  ready: boolean;
  address?: string | null;
}

export interface ChannelAdapterListProps {
  channels: ChannelItem[];
  snapshots: ChannelSnapshot[];
  selectedKey: SetupChannelId;
  loading?: boolean;
  onSelect: (key: SetupChannelId) => void;
  title?: string;
  connectedLabel?: string;
  notConnectedLabel?: string;
}

/**
 * Left-rail channel adapters list modeled on Vellum's ChannelAdapterList.
 * Provides accessible selection, brand icons, and connection status badges.
 */
export function ChannelAdapterList({
  channels,
  snapshots,
  selectedKey,
  loading = false,
  onSelect,
  title = "Adapters",
  connectedLabel = "Connected",
  notConnectedLabel = "Not connected",
}: ChannelAdapterListProps) {
  return (
    <Card className="gap-3 py-3 shadow-xs">
      <CardHeader className="px-4 py-1">
        <CardTitle className="text-xs font-semibold tracking-tight uppercase text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1 px-2 py-0">
        {loading ? (
          <div className="flex items-center justify-center p-6 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : (
          channels.map((ch) => {
            const snap = snapshots.find((s) => s.channel === ch.id);
            const isReady = snap?.ready ?? false;
            const isSelected = selectedKey === ch.id;

            return (
              <button
                key={ch.id}
                type="button"
                onClick={() => onSelect(ch.id as SetupChannelId)}
                data-testid={`channel-row-${ch.id}`}
                className={`group flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left transition-colors ${
                  isSelected
                    ? "bg-accent text-accent-foreground font-medium"
                    : "hover:bg-accent/60 text-muted-foreground hover:text-foreground"
                }`}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <ChannelIcon
                    channelId={ch.id}
                    className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground"
                  />
                  <span className="truncate text-xs font-medium text-foreground">
                    {ch.label}
                  </span>
                </div>
                <Badge
                  variant={isReady ? "default" : "secondary"}
                  className={`text-[10px] font-medium leading-none ${
                    isReady
                      ? "border border-primary/20 bg-primary/10 text-primary"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {isReady ? connectedLabel : notConnectedLabel}
                </Badge>
              </button>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
