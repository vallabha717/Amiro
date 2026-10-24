import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, UserCheck } from "lucide-react";
import { ChannelIcon, getChannelLabel } from "@/components/channels/channel-presentation";
import type { ContactChannelPayload } from "@/lib/backend/contacts-api";

export interface ContactChannelsSectionProps {
  channels: ContactChannelPayload[];
  isGuardian?: boolean;
  onVerify: (channelId: string) => void;
  onRevoke: (channelId: string) => void;
  verifiedLabel?: string;
  unverifiedLabel?: string;
  revokedLabel?: string;
  verifyActionLabel?: string;
  verifyMeLabel?: string;
  revokeActionLabel?: string;
  emptyLabel?: string;
  /** A verification is in flight: hold the verify buttons. */
  busy?: boolean;
}

/**
 * Renders the linked channels list inside a contact detail card.
 * Modeled on Vellum's ContactChannelsSection with verified status badges and actions.
 */
export function ContactChannelsSection({
  channels,
  isGuardian = false,
  onVerify,
  onRevoke,
  verifiedLabel = "Verified",
  unverifiedLabel: _unverifiedLabel = "Unverified",
  revokedLabel = "Revoked",
  verifyActionLabel = "Verify",
  verifyMeLabel = "Verify me",
  revokeActionLabel = "Revoke",
  emptyLabel = "No accounts linked to this contact yet.",
  busy = false,
}: ContactChannelsSectionProps) {
  if (channels.length === 0) {
    return (
      <div className="py-4 text-center text-xs text-muted-foreground">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-border/60">
      {channels.map((ch) => {
        const isVerified = ch.status === "active" || ch.status === "verified";
        const isRevoked = ch.status === "revoked";

        return (
          <div key={ch.id} className="flex items-center justify-between py-2.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <ChannelIcon channelId={ch.type} className="size-4 shrink-0 text-muted-foreground" />
              <div className="flex min-w-0 flex-col leading-tight">
                <span className="text-xs font-medium text-foreground">
                  {getChannelLabel(ch.type)}
                </span>
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {ch.address}
                </span>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {isVerified ? (
                <Badge
                  variant="outline"
                  className="gap-1 border-primary/20 bg-primary/10 text-primary text-[10px]"
                >
                  <CheckCircle2 className="size-3" />
                  {verifiedLabel}
                </Badge>
              ) : isRevoked ? (
                <Badge
                  variant="secondary"
                  className="bg-destructive/10 text-destructive text-[10px]"
                >
                  {revokedLabel}
                </Badge>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onVerify(ch.id)}
                  disabled={busy}
                  data-testid={`verify-channel-${ch.type}`}
                  className="h-7 px-2.5 text-xs"
                >
                  <UserCheck className="mr-1 size-3" />
                  {isGuardian ? verifyMeLabel : verifyActionLabel}
                </Button>
              )}

              {!isRevoked && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onRevoke(ch.id)}
                  className="h-7 text-xs text-muted-foreground hover:text-destructive"
                >
                  {revokeActionLabel}
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
