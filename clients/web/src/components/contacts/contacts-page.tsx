"use client";

import { useState } from "react";
import { toast } from "sonner";
import { GitMerge, UserPlus } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageShell } from "@/components/ui/page-shell";
import { ContactsList } from "./contacts-list";
import { ContactDetailView } from "./contact-detail-view";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  mergeContacts,
  upsertContact,
  useContacts,
} from "@/lib/backend/contacts-api";

export function ContactsPage() {
  const t = useTranslations("Contacts");
  const { data, mutate, isLoading } = useContacts();
  const contacts = data?.contacts ?? [];

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [donorId, setDonorId] = useState<string>("");

  const guardian = contacts.find((c) => c.role === "guardian") ?? null;
  const regularContacts = contacts.filter((c) => c.role !== "guardian");

  const activeContactId = selectedId || (guardian?.id ?? null);
  const activeContact = contacts.find((c) => c.id === activeContactId) ?? null;

  const handleMerge = async () => {
    if (!activeContact || !donorId) return;
    try {
      await mergeContacts(activeContact.id, donorId);
      await mutate();
      setMergeDialogOpen(false);
      setDonorId("");
      toast.success(t("mergeSuccess"));
    } catch {
      toast.error(t("mergeFailed"));
    }
  };

  const mergeCandidates = regularContacts.filter((c) => c.id !== activeContact?.id);

  return (
    <div data-testid="contacts-page" className="h-full">
      <PageShell
        title={t("title")}
        subtitle={t("subtitle")}
        backHref="/agent"
        backLabel="Agent Hub"
        backTestId="contacts-back-link"
        action={
          <Button
            size="sm"
            onClick={() => setAddDialogOpen(true)}
            data-testid="add-contact-button"
            className="h-8 text-xs font-medium"
          >
            <UserPlus className="mr-1.5 size-3.5" />
            {t("addContact")}
          </Button>
        }
      >
        <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-12">
          {/* Left rail: Contacts list */}
          <div className="md:col-span-4">
            <ContactsList
              contacts={contacts}
              guardian={guardian}
              regularContacts={regularContacts}
              selectedId={activeContactId}
              search={search}
              loading={isLoading}
              onSearchChange={setSearch}
              onSelect={setSelectedId}
              searchPlaceholder={t("searchPlaceholder")}
              noMatchesText={t("noMatches")}
              youText={t("you")}
              roleGuardianText={t("roleGuardian")}
              noChannelsText={t("noChannels")}
              verifiedText={t("verified")}
            />
          </div>

          {/* Right column: Selected contact details */}
          <div className="md:col-span-8">
            {activeContact ? (
              <ContactDetailView
                contact={activeContact}
                canMerge={mergeCandidates.length > 0}
                onUpdated={mutate}
                onOpenMerge={() => setMergeDialogOpen(true)}
              />
            ) : (
              <Card className="flex h-48 items-center justify-center p-6 text-center shadow-xs">
                <p className="text-xs text-muted-foreground">
                  {t("selectContactPrompt")}
                </p>
              </Card>
            )}
          </div>
        </div>
      </PageShell>

      {/* Add Contact Dialog */}
      <AddContactDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        onCreated={(newContactId) => {
          setSelectedId(newContactId);
          void mutate();
        }}
      />

      {/* Merge Contact Dialog */}
      <Dialog open={mergeDialogOpen} onOpenChange={setMergeDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <GitMerge className="size-4 text-primary" />
              {t("mergeTitle")}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {t("mergeDescription", { survivor: activeContact?.displayName ?? "" })}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-1">
            <div className="space-y-1">
              <Label className="text-xs">{t("selectDonorContact")}</Label>
              <Select value={donorId} onValueChange={setDonorId}>
                <SelectTrigger size="sm">
                  <SelectValue placeholder={t("chooseContactToMerge")} />
                </SelectTrigger>
                <SelectContent>
                  {mergeCandidates.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.displayName} ({c.channels.length} {t("channelsCount")})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-[11px] text-muted-foreground">{t("mergeWarning")}</p>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button size="sm" variant="outline" onClick={() => setMergeDialogOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={handleMerge}
              disabled={!donorId}
              data-testid="confirm-merge-button"
            >
              {t("mergeButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add Contact Dialog
// ---------------------------------------------------------------------------

function AddContactDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const t = useTranslations("Contacts");
  const [name, setName] = useState("");
  const [channelType, setChannelType] = useState("telegram");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      const channels = address.trim()
        ? [{ type: channelType, address: address.trim(), isPrimary: true }]
        : [];
      const res = await upsertContact({
        displayName: name.trim(),
        notes: notes.trim() || null,
        channels,
      });
      setName("");
      setAddress("");
      setNotes("");
      onOpenChange(false);
      onCreated(res.contact.id);
      toast.success(t("created"));
    } catch {
      toast.error(t("createFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleCreate}>
          <DialogHeader>
            <DialogTitle className="text-base">{t("addContactTitle")}</DialogTitle>
            <DialogDescription className="text-xs">
              {t("addContactSubtitle")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-3">
            <div className="space-y-1">
              <Label htmlFor="new-name" className="text-xs">
                {t("nameLabel")} *
              </Label>
              <Input
                id="new-name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Alice Walker"
                className="h-8 text-xs"
                data-testid="new-contact-name-input"
              />
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-1 space-y-1">
                <Label htmlFor="channel-type" className="text-xs">
                  {t("channelTypeLabel")}
                </Label>
                <Select value={channelType} onValueChange={setChannelType}>
                  <SelectTrigger id="channel-type" size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="telegram">Telegram</SelectItem>
                    <SelectItem value="slack">Slack</SelectItem>
                    <SelectItem value="discord">Discord</SelectItem>
                    <SelectItem value="phone">Phone</SelectItem>
                    <SelectItem value="email">Email</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="col-span-2 space-y-1">
                <Label htmlFor="new-address" className="text-xs">
                  {t("handleOrAddressLabel")}
                </Label>
                <Input
                  id="new-address"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="@handle or phone or email"
                  className="h-8 text-xs"
                  data-testid="new-contact-address-input"
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="new-notes" className="text-xs">
                {t("notesLabel")}
              </Label>
              <Input
                id="new-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t("notesPlaceholder")}
                className="h-8 text-xs"
              />
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              size="sm"
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t("cancel")}
            </Button>
            <Button
              size="sm"
              type="submit"
              disabled={saving || !name.trim()}
              data-testid="save-new-contact-button"
            >
              {t("saveContact")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
