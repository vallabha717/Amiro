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
    <div className="flex h-full min-h-0 w-full flex-col gap-6 overflow-y-auto p-4 sm:p-6 lg:p-8" data-testid="contacts-page">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-wrap items-start gap-3">
          <Link
            href="/agent"
            data-testid="contacts-back-link"
            className="mt-1 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-card px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            Agent Hub
          </Link>
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">{t("title")}</h1>
            <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
          </div>
        </div>
        <Button onClick={() => setAddDialogOpen(true)} data-testid="add-contact-button" className="shrink-0 self-start sm:self-auto">
          <UserPlus className="mr-2 size-4" />
          {t("addContact")}
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left column: Contact entries list */}
        <div className="lg:col-span-4">
          <Card className="h-full">
            <CardHeader className="pb-3">
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                <Input
                  placeholder={t("searchPlaceholder")}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-8"
                  data-testid="contact-search-input"
                />
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 p-2">
              {isLoading ? (
                <div className="flex items-center justify-center p-8 text-muted-foreground">
                  <Loader2 className="size-5 animate-spin" />
                </div>
              ) : (
                <>
                  {/* Guardian item */}
                  {guardian && (
                    <button
                      type="button"
                      onClick={() => setSelectedId(guardian.id)}
                      data-testid={`contact-row-${guardian.id}`}
                      className={`flex w-full items-center justify-between rounded-lg p-3 text-left transition-colors ${
                        activeContactId === guardian.id
                          ? "bg-primary text-primary-foreground font-medium"
                          : "hover:bg-accent text-foreground"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                          <User className="size-4" />
                        </div>
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">{guardian.displayName} ({t("you")})</span>
                          <span
                            className={`text-xs ${
                              activeContactId === guardian.id ? "text-primary-foreground/80" : "text-muted-foreground"
                            }`}
                          >
                            {t("roleGuardian")}
                          </span>
                        </div>
                      </div>
                    </button>
                  )}

                  {guardian && regularContacts.length > 0 && <div className="my-1 border-t border-border" />}

                  {/* Regular contacts list */}
                  {filtered.length === 0 ? (
                    <p className="p-4 text-center text-xs text-muted-foreground">{t("noMatches")}</p>
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
                          className={`flex w-full items-center justify-between rounded-lg p-3 text-left transition-colors ${
                            isSelected
                              ? "bg-primary text-primary-foreground font-medium"
                              : "hover:bg-accent text-foreground"
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground font-medium text-xs">
                              {c.displayName.charAt(0).toUpperCase()}
                            </div>
                            <div className="flex flex-col">
                              <span className="text-sm font-medium">{c.displayName}</span>
                              <span
                                className={`text-xs ${
                                  isSelected ? "text-primary-foreground/80" : "text-muted-foreground"
                                }`}
                              >
                                {c.channels.length > 0
                                  ? c.channels.map((ch) => getChannelLabel(ch.type)).join(", ")
                                  : t("noChannels")}
                              </span>
                            </div>
                          </div>
                          {verified ? (
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                                isSelected ? "bg-white/20 text-white" : "bg-green-500/10 text-green-600 dark:text-green-400"
                              }`}
                            >
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
        <div className="flex flex-col gap-6 lg:col-span-8">
          {activeContact ? (
            <ContactDetailCard
              contact={activeContact}
              onUpdated={mutate}
              onOpenMerge={() => setMergeDialogOpen(true)}
              canMerge={mergeCandidates.length > 0}
            />
          ) : (
            <Card className="flex h-64 items-center justify-center text-center p-8">
              <p className="text-sm text-muted-foreground">{t("selectContactPrompt")}</p>
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitMerge className="size-5" />
              {t("mergeTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("mergeDescription", { survivor: activeContact?.displayName ?? "" })}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>{t("selectDonorContact")}</Label>
              <Select value={donorId} onValueChange={setDonorId}>
                <SelectTrigger>
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
            <p className="text-xs text-muted-foreground">{t("mergeWarning")}</p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setMergeDialogOpen(false)}>
              {t("cancel")}
            </Button>
            <Button variant="destructive" onClick={handleMerge} disabled={!donorId} data-testid="confirm-merge-button">
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
    <div className="flex flex-col gap-6" data-testid="contact-detail-card">
      {/* General info */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-lg font-semibold">{contact.displayName}</CardTitle>
            <CardDescription>
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
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="contact-name">{t("nameLabel")}</Label>
              <Input
                id="contact-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                data-testid="contact-name-input"
              />
            </div>
            {!isGuardian && (
              <div className="space-y-1.5">
                <Label htmlFor="contact-threshold">{t("autoApproveThreshold")}</Label>
                <Select value={threshold} onValueChange={setThreshold}>
                  <SelectTrigger id="contact-threshold" data-testid="contact-threshold-select">
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
          <div className="space-y-1.5">
            <Label htmlFor="contact-notes">{t("notesLabel")}</Label>
            <Input
              id="contact-notes"
              placeholder={t("notesPlaceholder")}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              data-testid="contact-notes-input"
            />
          </div>
          <Button onClick={handleSave} disabled={saving} data-testid="save-contact-button">
            {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            {t("saveChanges")}
          </Button>
        </CardContent>
      </Card>

      {/* Linked channels */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">{t("linkedAccountsTitle")}</CardTitle>
          <CardDescription>{t("linkedAccountsSubtitle")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex flex-col divide-y divide-border">
            {contact.channels.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">{t("noChannelsLinked")}</p>
            ) : (
              contact.channels.map((ch) => {
                const isVerified = ch.status === "active" || ch.status === "verified";
                const isRevoked = ch.status === "revoked";

                return (
                  <div key={ch.id} className="flex items-center justify-between py-3">
                    <div className="flex items-center gap-3">
                      <ChannelIcon channelId={ch.type} className="size-4 text-muted-foreground" />
                      <div className="flex flex-col">
                        <span className="text-sm font-medium">{getChannelLabel(ch.type)}</span>
                        <span className="text-xs text-muted-foreground">{ch.address}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {isVerified ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-600 dark:text-green-400">
                          <CheckCircle className="size-3" />
                          {t("verified")}
                        </span>
                      ) : isRevoked ? (
                        <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-600">
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
                          className="text-destructive hover:bg-destructive/10"
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
          <form onSubmit={handleAddChannel} className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-end">
            <div className="space-y-1 sm:w-40">
              <Label className="text-xs">{t("channelType")}</Label>
              <Select value={newChannelType} onValueChange={setNewChannelType}>
                <SelectTrigger>
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
              <Label className="text-xs">{t("channelAddress")}</Label>
              <Input
                placeholder="e.g. @username or +1555..."
                value={newChannelAddr}
                onChange={(e) => setNewChannelAddr(e.target.value)}
                required
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
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t("addContactTitle")}</DialogTitle>
            <DialogDescription>{t("addContactDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-name">{t("nameLabel")}</Label>
              <Input
                id="new-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="e.g. Alice"
                required
                data-testid="new-contact-name-input"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-notes">{t("notesLabel")}</Label>
              <Input
                id="new-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t("notesPlaceholder")}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t("optionalChannel")}</Label>
                <Select value={channelType} onValueChange={setChannelType}>
                  <SelectTrigger>
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
              <div className="space-y-1.5">
                <Label htmlFor="new-address">{t("channelAddress")}</Label>
                <Input
                  id="new-address"
                  value={channelAddress}
                  onChange={(e) => setChannelAddress(e.target.value)}
                  placeholder="e.g. @handle"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={saving || !displayName.trim()} data-testid="save-new-contact-button">
              {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              {t("create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
