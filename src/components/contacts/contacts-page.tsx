"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  ArrowLeft,
  CheckCircle,
  GitMerge,
  Loader2,
  Plus,
  Search,
  Trash2,
  User,
  UserPlus,
} from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ContactPayload,
  deleteContact,
  mergeContacts,
  updateContactChannelStatus,
  upsertContact,
  useContacts,
  verifyContactChannel,
} from "@/lib/backend/contacts-api";
import { ChannelIcon, getChannelLabel } from "@/components/channels/channel-presentation";

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

  const filtered = search.trim()
    ? regularContacts.filter((c) =>
        c.displayName.toLowerCase().includes(search.trim().toLowerCase()) ||
        c.channels.some((ch) => ch.address.toLowerCase().includes(search.trim().toLowerCase())),
      )
    : regularContacts;

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
    <div
      className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col gap-5 overflow-y-auto p-4 sm:p-6"
      data-testid="contacts-page"
    >
      {/* Top action header matching Memory / Workspace / Superpowers */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/agent"
            data-testid="contacts-back-link"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-card px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            Agent Hub
          </Link>
          <div className="flex min-w-0 flex-col">
            <h1 className="font-brand text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
              {t("title")}
            </h1>
            <p className="text-xs text-muted-foreground">{t("subtitle")}</p>
          </div>
        </div>
        <Button size="sm" onClick={() => setAddDialogOpen(true)} data-testid="add-contact-button" className="shrink-0 self-start sm:self-auto">
          <UserPlus className="mr-1.5 size-3.5" />
          {t("addContact")}
        </Button>
      </div>

      <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-12">
        {/* Left column: Contact entries list */}
        <div className="md:col-span-4">
          <Card className="gap-2.5 py-3 shadow-xs">
            <CardHeader className="px-3 py-1">
              <div className="relative">
                <Search className="absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
                <Input
                  placeholder={t("searchPlaceholder")}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-8 pl-7 text-xs"
                  data-testid="contact-search-input"
                />
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-1 px-2 py-0">
              {isLoading ? (
                <div className="flex items-center justify-center p-6 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                </div>
              ) : (
                <>
                  {/* Guardian item */}
                  {guardian && (
                    <button
                      type="button"
                      onClick={() => setSelectedId(guardian.id)}
                      data-testid={`contact-row-${guardian.id}`}
                      className={`group flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left transition-colors ${
                        activeContactId === guardian.id
                          ? "bg-accent text-accent-foreground font-medium"
                          : "hover:bg-accent/60 text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                          <User className="size-3" />
                        </div>
                        <div className="flex flex-col leading-tight">
                          <span className="text-xs font-semibold text-foreground">{guardian.displayName} ({t("you")})</span>
                          <span className="text-[10px] text-muted-foreground">{t("roleGuardian")}</span>
                        </div>
                      </div>
                    </button>
                  )}

                  {guardian && regularContacts.length > 0 && <div className="my-1 border-t border-border/60" />}

                  {/* Regular contacts list */}
                  {filtered.length === 0 ? (
                    <p className="p-3 text-center text-[11px] text-muted-foreground">{t("noMatches")}</p>
                  ) : (
                    filtered.map((c) => {
                      const isSelected = activeContactId === c.id;
                      const verified = c.channels.some((ch) => ch.status === "active" || ch.status === "verified");

                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => setSelectedId(c.id)}
                          data-testid={`contact-row-${c.id}`}
                          className={`group flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left transition-colors ${
                            isSelected
                              ? "bg-accent text-accent-foreground font-medium"
                              : "hover:bg-accent/60 text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          <div className="flex min-w-0 items-center gap-2.5">
                            <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-foreground">
                              {c.displayName.charAt(0).toUpperCase()}
                            </div>
                            <div className="flex min-w-0 flex-col leading-tight">
                              <span className="truncate text-xs font-medium text-foreground">{c.displayName}</span>
                              <span className="truncate text-[10px] text-muted-foreground">
                                {c.channels.length > 0
                                  ? c.channels.map((ch) => getChannelLabel(ch.type)).join(", ")
                                  : t("noChannels")}
                              </span>
                            </div>
                          </div>
                          {verified ? (
                            <span className="inline-flex shrink-0 items-center rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary border border-primary/20">
                              {t("verified")}
                            </span>
                          ) : null}
                        </button>
                      );
                    })
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right column: Selected contact details */}
        <div className="flex flex-col gap-4 md:col-span-8">
          {activeContact ? (
            <ContactDetailCard
              contact={activeContact}
              onUpdated={mutate}
              onOpenMerge={() => setMergeDialogOpen(true)}
              canMerge={mergeCandidates.length > 0}
            />
          ) : (
            <Card className="flex h-48 items-center justify-center text-center p-6 shadow-xs">
              <p className="text-xs text-muted-foreground">{t("selectContactPrompt")}</p>
            </Card>
          )}
        </div>
      </div>

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
            <Button size="sm" variant="destructive" onClick={handleMerge} disabled={!donorId} data-testid="confirm-merge-button">
              {t("mergeButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Contact Detail Card
// ---------------------------------------------------------------------------

function ContactDetailCard({
  contact,
  onUpdated,
  onOpenMerge,
  canMerge,
}: {
  contact: ContactPayload;
  onUpdated: () => void;
  onOpenMerge: () => void;
  canMerge: boolean;
}) {
  const t = useTranslations("Contacts");
  const [displayName, setDisplayName] = useState(contact.displayName);
  const [notes, setNotes] = useState(contact.notes ?? "");
  const [threshold, setThreshold] = useState<string>(contact.autoApproveThreshold ?? "inherit");
  const [saving, setSaving] = useState(false);
  const [newChannelType, setNewChannelType] = useState("telegram");
  const [newChannelAddr, setNewChannelAddr] = useState("");

  const isGuardian = contact.role === "guardian";

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
    try {
      await deleteContact(contact.id);
      await onUpdated();
      toast.success(t("deleted"));
    } catch {
      toast.error(t("deleteFailed"));
    }
  };

  const handleAddChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newChannelAddr) return;
    try {
      await upsertContact({
        id: contact.id,
        displayName: contact.displayName,
        channels: [{ type: newChannelType, address: newChannelAddr, isPrimary: false }],
      });
      setNewChannelAddr("");
      await onUpdated();
      toast.success(t("channelAdded"));
    } catch {
      toast.error(t("channelAddFailed"));
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

  return (
    <div className="flex flex-col gap-4" data-testid="contact-detail-card">
      {/* General info */}
      <Card className="gap-4 py-4 shadow-xs">
        <CardHeader className="flex flex-row items-center justify-between px-5 py-0">
          <div>
            <CardTitle className="text-base font-semibold">{contact.displayName}</CardTitle>
            <CardDescription className="text-xs">
              {isGuardian ? t("guardianDescription") : t("contactDescription")}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {!isGuardian && canMerge ? (
              <Button variant="outline" size="sm" onClick={onOpenMerge} data-testid="contact-merge-trigger">
                <GitMerge className="mr-1.5 size-3.5" />
                {t("merge")}
              </Button>
            ) : null}
            {!isGuardian ? (
              <Button variant="destructive" size="sm" onClick={handleDelete} data-testid="contact-delete-button">
                <Trash2 className="mr-1.5 size-3.5" />
                {t("delete")}
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-3 px-5 py-0">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="contact-name" className="text-xs">{t("nameLabel")}</Label>
              <Input
                id="contact-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="h-8 text-xs"
                data-testid="contact-name-input"
              />
            </div>
            {!isGuardian && (
              <div className="space-y-1">
                <Label htmlFor="contact-threshold" className="text-xs">{t("autoApproveThreshold")}</Label>
                <Select value={threshold} onValueChange={setThreshold}>
                  <SelectTrigger id="contact-threshold" size="sm" data-testid="contact-threshold-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">{t("inheritDefault")}</SelectItem>
                    <SelectItem value="none">{t("thresholdStrict")}</SelectItem>
                    <SelectItem value="low">{t("thresholdConservative")}</SelectItem>
                    <SelectItem value="medium">{t("thresholdRelaxed")}</SelectItem>
                    <SelectItem value="high">{t("thresholdFullAccess")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="contact-notes" className="text-xs">{t("notesLabel")}</Label>
            <Input
              id="contact-notes"
              placeholder={t("notesPlaceholder")}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="h-8 text-xs"
              data-testid="contact-notes-input"
            />
          </div>
          <Button size="sm" onClick={handleSave} disabled={saving} data-testid="save-contact-button">
            {saving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
            {t("saveChanges")}
          </Button>
        </CardContent>
      </Card>

      {/* Linked channels */}
      <Card className="gap-4 py-4 shadow-xs">
        <CardHeader className="px-5 py-0">
          <CardTitle className="text-sm font-semibold">{t("linkedAccountsTitle")}</CardTitle>
          <CardDescription className="text-xs">{t("linkedAccountsSubtitle")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-5 py-0">
          <div className="flex flex-col divide-y divide-border/60">
            {contact.channels.length === 0 ? (
              <p className="py-3 text-center text-[11px] text-muted-foreground">{t("noChannelsLinked")}</p>
            ) : (
              contact.channels.map((ch) => {
                const isVerified = ch.status === "active" || ch.status === "verified";
                const isRevoked = ch.status === "revoked";

                return (
                  <div key={ch.id} className="flex items-center justify-between py-2.5">
                    <div className="flex items-center gap-2.5">
                      <ChannelIcon channelId={ch.type} className="size-3.5 text-muted-foreground" />
                      <div className="flex flex-col leading-tight">
                        <span className="text-xs font-medium text-foreground">{getChannelLabel(ch.type)}</span>
                        <span className="text-[11px] text-muted-foreground font-mono">{ch.address}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {isVerified ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary border border-primary/20">
                          <CheckCircle className="size-3" />
                          {t("verified")}
                        </span>
                      ) : isRevoked ? (
                        <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">
                          {t("revoked")}
                        </span>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleVerifyChannel(ch.id)}
                          data-testid={`verify-channel-${ch.id}`}
                        >
                          {t("verify")}
                        </Button>
                      )}
                      {!isRevoked ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRevokeChannel(ch.id)}
                          className="h-7 text-xs text-destructive hover:bg-destructive/10"
                          data-testid={`revoke-channel-${ch.id}`}
                        >
                          {t("revoke")}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Add channel address form */}
          <form onSubmit={handleAddChannel} className="flex flex-col gap-2 rounded-lg border border-border/70 bg-card p-2.5 sm:flex-row sm:items-end">
            <div className="space-y-1 sm:w-36">
              <Label className="text-[11px]">{t("channelType")}</Label>
              <Select value={newChannelType} onValueChange={setNewChannelType}>
                <SelectTrigger size="sm">
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
            <div className="flex-1 space-y-1">
              <Label className="text-[11px]">{t("channelAddress")}</Label>
              <Input
                placeholder="e.g. @username or +1555..."
                value={newChannelAddr}
                onChange={(e) => setNewChannelAddr(e.target.value)}
                required
                className="h-8 text-xs"
                data-testid="add-channel-address-input"
              />
            </div>
            <Button type="submit" variant="outline" size="sm" disabled={!newChannelAddr} data-testid="add-channel-button">
              <Plus className="mr-1.5 size-3.5" />
              {t("add")}
            </Button>
          </form>
        </CardContent>
      </Card>
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
  onCreated: (newContactId: string) => void;
}) {
  const t = useTranslations("Contacts");
  const [displayName, setDisplayName] = useState("");
  const [notes, setNotes] = useState("");
  const [channelType, setChannelType] = useState("telegram");
  const [channelAddress, setChannelAddress] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim()) return;
    setSaving(true);
    try {
      const channels = channelAddress.trim()
        ? [{ type: channelType, address: channelAddress.trim(), isPrimary: true }]
        : undefined;

      const createdRes = await upsertContact({
        displayName: displayName.trim(),
        notes: notes.trim() || null,
        channels,
      });

      setDisplayName("");
      setNotes("");
      setChannelAddress("");
      onOpenChange(false);
      onCreated(createdRes.contact.id);
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
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="text-base">{t("addContactTitle")}</DialogTitle>
            <DialogDescription className="text-xs">{t("addContactDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-3">
            <div className="space-y-1">
              <Label htmlFor="new-name" className="text-xs">{t("nameLabel")}</Label>
              <Input
                id="new-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="e.g. Alice"
                required
                className="h-8 text-xs"
                data-testid="new-contact-name-input"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="new-notes" className="text-xs">{t("notesLabel")}</Label>
              <Input
                id="new-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t("notesPlaceholder")}
                className="h-8 text-xs"
              />
            </div>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs">{t("optionalChannel")}</Label>
                <Select value={channelType} onValueChange={setChannelType}>
                  <SelectTrigger size="sm">
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
              <div className="space-y-1">
                <Label htmlFor="new-address" className="text-xs">{t("channelAddress")}</Label>
                <Input
                  id="new-address"
                  value={channelAddress}
                  onChange={(e) => setChannelAddress(e.target.value)}
                  placeholder="e.g. @handle"
                  className="h-8 text-xs"
                />
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button size="sm" type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("cancel")}
            </Button>
            <Button size="sm" type="submit" disabled={saving || !displayName.trim()} data-testid="save-new-contact-button">
              {saving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
              {t("create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
