import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DetailCard } from "@/components/ui/detail-card";

export interface ContactPermissionsSectionProps {
  threshold: string;
  onChange: (next: string) => void;
  titleText?: string;
  subtitleText?: string;
  options: {
    inherit: { label: string; desc: string };
    none: { label: string; desc: string };
    low: { label: string; desc: string };
    medium: { label: string; desc: string };
    high: { label: string; desc: string };
  };
}

/**
 * Autonomy / risk threshold permission card for a contact.
 * Modeled on Vellum's ContactPermissionsSection.
 */
export function ContactPermissionsSection({
  threshold,
  onChange,
  titleText = "Permissions",
  subtitleText = "Highest risk this contact can take without asking you.",
  options,
}: ContactPermissionsSectionProps) {
  const currentDesc = options[threshold as keyof typeof options]?.desc;

  return (
    <DetailCard title={titleText} subtitle={subtitleText}>
      <div className="space-y-3">
        <div className="flex max-w-xs flex-col gap-1.5">
          <Select value={threshold} onValueChange={onChange}>
            <SelectTrigger id="contact-threshold-select" size="sm" data-testid="contact-threshold-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit">{options.inherit.label}</SelectItem>
              <SelectItem value="none">{options.none.label}</SelectItem>
              <SelectItem value="low">{options.low.label}</SelectItem>
              <SelectItem value="medium">{options.medium.label}</SelectItem>
              <SelectItem value="high">{options.high.label}</SelectItem>
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
