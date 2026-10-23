import { Lock } from "lucide-react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DetailCard } from "@/components/ui/detail-card";
import type { AdmissionPolicy } from "@/lib/backend/channels-api";

export interface ChannelTrustFloorSectionProps {
  channelLabel: string;
  policy: AdmissionPolicy;
  saving?: boolean;
  onChange: (next: AdmissionPolicy) => void;
  titleText?: string;
  subtitleText?: string;
  whoCanMessageLabel?: string;
  options: {
    no_one: { label: string; desc: string };
    guardian_only: { label: string; desc: string };
    trusted_contacts: { label: string; desc: string };
    any_contact: { label: string; desc: string };
    strangers: { label: string; desc: string };
  };
}

/**
 * Trust Floor (admission policy) section card.
 * Controls who can reach the agent through a channel (no one, guardian only, trusted, any, strangers).
 */
export function ChannelTrustFloorSection({
  channelLabel: _channelLabel,
  policy,
  saving = false,
  onChange,
  titleText = "Admission policy",
  subtitleText = "Control who can reach the agent through this channel.",
  whoCanMessageLabel = "Who can message",
  options,
}: ChannelTrustFloorSectionProps) {
  const currentDesc = options[policy]?.desc;

  return (
    <DetailCard
      title={
        <span className="flex items-center gap-2">
          <Lock className="size-3.5 text-primary" />
          {titleText}
        </span>
      }
      subtitle={subtitleText}
    >
      <div className="space-y-3">
        <div className="flex max-w-xs flex-col gap-1.5">
          <Label htmlFor="channel-policy-select" className="text-xs font-medium">
            {whoCanMessageLabel}
          </Label>
          <Select
            value={policy}
            onValueChange={(val) => onChange(val as AdmissionPolicy)}
            disabled={saving}
          >
            <SelectTrigger
              id="channel-policy-select"
              size="sm"
              data-testid="channel-policy-select"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="no_one">{options.no_one.label}</SelectItem>
              <SelectItem value="guardian_only">{options.guardian_only.label}</SelectItem>
              <SelectItem value="trusted_contacts">{options.trusted_contacts.label}</SelectItem>
              <SelectItem value="any_contact">{options.any_contact.label}</SelectItem>
              <SelectItem value="strangers">{options.strangers.label}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {currentDesc ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {currentDesc}
          </p>
        ) : null}
      </div>
    </DetailCard>
  );
}
