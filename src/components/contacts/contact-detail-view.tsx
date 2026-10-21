import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { DetailCard } from "@/components/ui/detail-card";
import { ContactChannelsSection } from "./contact-channels-section";
import { ContactPermissionsSection } from "./contact-permissions-section";
import { GitMerge, Loader2, Plus, Trash2 } from "lucide-react";
import {
  ContactPayload,
  deleteContact,
  updateContactChannelStatus,
  upsertContact,
  verifyContactChannel,
} from "@/lib/backend/contacts-api";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

export interface ContactDetailViewProps {
  contact: ContactPayload;
  canMerge: boolean;
  onUpdated: () => void;
  onOpenMerge: () => void;
}

/**
 * Contact detail view matching Vellum's ContactDetailView / GuardianDetailView.
 * Modular, clean layout organizing identity, linked accounts, and autonomy risk permissions.
 */
export function ContactDetailView({
  contact,
  canMerge,
  onUpdated,
  onOpenMerge,
}: ContactDetailViewProps) {
  const t = useTranslations("Contacts");
  const isGuardian = contact.role === "guardian";

  const [displayName, setDisplayName] = useState(contact.displayName);
  const [notes, setNotes] = useState(contact.notes ?? "");
  const [threshold, setThreshold] = useState<string>(
    contact.autoApproveThreshold ?? "inherit",
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // New channel inline form state
  const [newChannelType, setNewChannelType] = useState("telegram");
  const [newChannelAddr, setNewChannelAddr] = useState("");
  const [addingChannel, setAddingChannel] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await upsertContact({
        id: contact.id,
        displayName: displayName.trim() || contact.displayName,
        notes: notes.trim() || null,
        autoApproveThreshold: threshold === "inherit" ? null : threshold,
      });
      await onUpdated();
      toast.success(t("saved"));
    } catch {
      toast.error(t("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteContact(contact.id);
      await onUpdated();
      toast.success(t("deleted"));
    } catch {
      toast.error(t("deleteFailed"));
    } finally {
      setDeleting(false);
    }
  };

  const handleAddChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newChannelAddr.trim()) return;
    setAddingChannel(true);
    try {
      await upsertContact({
        id: contact.id,
        displayName: contact.displayName,
        channels: [
          { type: newChannelType, address: newChannelAddr.trim(), isPrimary: false },
        ],
      });
      setNewChannelAddr("");
      await onUpdated();
      toast.success(t("channelAdded"));
    } catch {
      toast.error(t("channelAddFailed"));
    } finally {
      setAddingChannel(false);
    }
  };

  const handleVerifyChannel = async (channelId: string) => {
    try {
      await verifyContactChannel(channelId);
      await onUpdated();
      toast.success(t("channelVerified"));
    } catch {
      toast.error(t("channelVerifyFailed"));
    }
  };

  const handleRevokeChannel = async (channelId: string) => {
    try {
      await updateContactChannelStatus(channelId, { status: "revoked" });
      await onUpdated();
      toast.success(t("channelRevoked"));
    } catch {
      toast.error(t("channelRevokeFailed"));
    }
  };

  const permissionOptions = {
    inherit: { label: t("inheritDefault"), desc: t("inheritDefaultDesc") || "" },
    none: { label: t("thresholdStrict"), desc: t("thresholdStrictDesc") || "" },
    low: { label: t("thresholdConservative"), desc: t("thresholdConservativeDesc") || "" },
    medium: { label: t("thresholdRelaxed"), desc: t("thresholdRelaxedDesc") || "" },
    high: { label: t("thresholdFullAccess"), desc: t("thresholdFullAccessDesc") || "" },
  };

  return (
    <div className="flex flex-col gap-5" data-testid="contact-detail-card">
      {/* Identity Card */}
      <DetailCard
        title={
          <div className="flex items-center gap-2">
            <span>{contact.displayName}</span>
            <Badge
              variant={isGuardian ? "default" : "secondary"}
              className="text-[10px]"
            >
              {isGuardian ? "Guardian" : "Human"}
            </Badge>
          </div>
        }
        subtitle={isGuardian ? t("guardianDescription") : t("contactDescription")}
        accessory={
          <div className="flex items-center gap-2">
            {!isGuardian && canMerge ? (
              <Button
                variant="outline"
                size="sm"
                onClick={onOpenMerge}
                data-testid="contact-merge-trigger"
                className="h-8 text-xs"
              >
                <GitMerge className="mr-1.5 size-3.5" />
                {t("merge")}
              </Button>
            ) : null}
            {!isGuardian ? (
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDelete}
                disabled={deleting}
                data-testid="contact-delete-button"
                className="h-8 text-xs"
              >
                <Trash2 className="mr-1.5 size-3.5" />
                {t("delete")}
              </Button>
            ) : null}
          </div>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="contact-name" className="text-xs">
                {t("nameLabel")}
              </Label>
              <Input
                id="contact-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="h-8 text-xs"
                data-testid="contact-name-input"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="contact-notes" className="text-xs">
                {t("notesLabel")}
              </Label>
              <Input
                id="contact-notes"
                placeholder={t("notesPlaceholder")}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="h-8 text-xs"
                data-testid="contact-notes-input"
              />
            </div>
          </div>

          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving}
            data-testid="save-contact-button"
          >
            {saving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
            {t("saveChanges")}
          </Button>
        </div>
      </DetailCard>

      {/* Linked Accounts Section */}
      <DetailCard
        title={t("linkedAccountsTitle")}
        subtitle={t("linkedAccountsSubtitle")}
      >
        <div className="space-y-4">
          <ContactChannelsSection
            channels={contact.channels}
            isGuardian={isGuardian}
            onVerify={handleVerifyChannel}
            onRevoke={handleRevokeChannel}
            verifiedLabel={t("verified")}
            unverifiedLabel={t("unverified")}
            revokedLabel={t("revoked")}
            verifyActionLabel={t("verify")}
            revokeActionLabel={t("revoke")}
          />

          {/* Add channel inline form */}
          <form
            onSubmit={handleAddChannel}
            className="flex flex-wrap items-center gap-2 pt-2 border-t border-border/60"
          >
            <select
              value={newChannelType}
              onChange={(e) => setNewChannelType(e.target.value)}
              className="h-8 rounded-md border border-input bg-card px-2.5 text-xs text-foreground shadow-xs outline-none"
              data-testid="add-channel-type-select"
            >
              <option value="telegram">Telegram</option>
              <option value="slack">Slack</option>
              <option value="discord">Discord</option>
              <option value="phone">Phone</option>
              <option value="email">Email</option>
            </select>
            <Input
              placeholder={t("channelAddressPlaceholder")}
              value={newChannelAddr}
              onChange={(e) => setNewChannelAddr(e.target.value)}
              className="h-8 w-44 text-xs"
              data-testid="add-channel-address-input"
            />
            <Button
              size="sm"
              type="submit"
              disabled={addingChannel || !newChannelAddr.trim()}
              data-testid="add-channel-button"
              className="h-8 text-xs"
            >
              <Plus className="mr-1 size-3" />
              {t("linkChannel")}
            </Button>
          </form>
        </div>
      </DetailCard>

      {/* Risk / Permission Section (for regular contacts) */}
      {!isGuardian && (
        <ContactPermissionsSection
          threshold={threshold}
          onChange={(val) => {
            setThreshold(val);
            void upsertContact({
              id: contact.id,
              displayName: contact.displayName,
              autoApproveThreshold: val === "inherit" ? null : val,
            }).then(() => onUpdated());
          }}
          options={permissionOptions}
          titleText={t("autoApproveThreshold")}
          subtitleText={t("contactPermissionsSubtitle")}
        />
      )}
    </div>
  );
}
