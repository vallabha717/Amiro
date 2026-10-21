"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  ArrowLeft,
  CheckCircle,
  ExternalLink,
  Loader2,
  Lock,
} from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import {
  AdmissionPolicy,
  deleteDiscordConfig,
  deleteSlackConfig,
  deleteTelegramConfig,
  deleteTwilioCredentials,
  patchSlackThreadMode,
  saveDiscordConfig,
  saveSlackConfig,
  saveTelegramConfig,
  saveTwilioCredentials,
  setChannelPolicy,
  SetupChannelId,
  useAvailableChannels,
  useChannelPolicies,
  useChannelReadiness,
  useDiscordConfig,
  useSlackConfig,
  useTelegramConfig,
  useTwilioConfig,
} from "@/lib/backend/channels-api";
import { ChannelIcon, getChannelLabel } from "./channel-presentation";

export function ChannelsPage() {
  const t = useTranslations("Channels");
  const { data: availData, isLoading: availLoading } = useAvailableChannels();
  const { data: readyData, mutate: refreshReadiness } = useChannelReadiness();
  const { data: policyData, mutate: refreshPolicies } = useChannelPolicies();

  const [selectedChannel, setSelectedChannel] = useState<SetupChannelId>("slack");

  const channels = availData?.channels ?? [];
  const snapshots = readyData?.snapshots ?? [];
  const policies = policyData?.policies ?? [];

  const currentPolicy = policies.find((p) => p.channelType === selectedChannel)?.policy ?? "trusted_contacts";

  const handlePolicyChange = async (nextPolicy: AdmissionPolicy) => {
    try {
      await setChannelPolicy(selectedChannel, nextPolicy);
      await refreshPolicies();
      toast.success(t("policyUpdated"));
    } catch {
      toast.error(t("policyUpdateFailed"));
    }
  };

  return (
    <div
      className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col gap-5 overflow-y-auto p-4 sm:p-6"
      data-testid="channels-page"
    >
      {/* Header bar matching Memory / Workspace / Superpowers */}
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/agent"
          data-testid="channels-back-link"
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

      <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-12">
        {/* Left column: Channel adapters list (compact rail) */}
        <div className="md:col-span-4">
          <Card className="gap-3 py-3 shadow-xs">
            <CardHeader className="px-4 py-1">
              <CardTitle className="text-xs font-semibold tracking-tight uppercase text-muted-foreground">
                {t("adapters")}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-1 px-2 py-0">
              {availLoading ? (
                <div className="flex items-center justify-center p-6 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                </div>
              ) : (
                channels.map((ch) => {
                  const snap = snapshots.find((s) => s.channel === ch.id);
                  const isReady = snap?.ready ?? false;
                  const isSelected = selectedChannel === ch.id;

                  return (
                    <button
                      key={ch.id}
                      type="button"
                      onClick={() => setSelectedChannel(ch.id as SetupChannelId)}
                      data-testid={`channel-row-${ch.id}`}
                      className={`group flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left transition-colors ${
                        isSelected
                          ? "bg-accent text-accent-foreground font-medium"
                          : "hover:bg-accent/60 text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <ChannelIcon channelId={ch.id} className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
                        <span className="truncate text-xs font-medium text-foreground">{ch.label}</span>
                      </div>
                      <span
                        className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium leading-none ${
                          isReady
                            ? "bg-primary/10 text-primary border border-primary/20"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {isReady ? t("connected") : t("notConnected")}
                      </span>
                    </button>
                  );
                })
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right column: Selected channel configuration */}
        <div className="flex flex-col gap-4 md:col-span-8">
          {/* Trust floor / Admission policy card */}
          <Card className="gap-4 py-4 shadow-xs">
            <CardHeader className="px-5 py-0">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <Lock className="size-3.5 text-primary" />
                {t("trustFloorTitle", { channel: getChannelLabel(selectedChannel) })}
              </CardTitle>
              <CardDescription className="text-xs">{t("trustFloorDescription")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 px-5 py-0">
              <div className="flex max-w-xs flex-col gap-1.5">
                <Label htmlFor="channel-policy-select" className="text-xs font-medium">
                  {t("whoCanMessage")}
                </Label>
                <Select value={currentPolicy} onValueChange={(val) => handlePolicyChange(val as AdmissionPolicy)}>
                  <SelectTrigger id="channel-policy-select" size="sm" data-testid="channel-policy-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="no_one">{t("policyNoOne")}</SelectItem>
                    <SelectItem value="guardian_only">{t("policyGuardianOnly")}</SelectItem>
                    <SelectItem value="trusted_contacts">{t("policyTrustedContacts")}</SelectItem>
                    <SelectItem value="any_contact">{t("policyAnyContact")}</SelectItem>
                    <SelectItem value="strangers">{t("policyStrangers")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {currentPolicy === "no_one" && t("policyDescNoOne")}
                {currentPolicy === "guardian_only" && t("policyDescGuardianOnly")}
                {currentPolicy === "trusted_contacts" && t("policyDescTrustedContacts")}
                {currentPolicy === "any_contact" && t("policyDescAnyContact")}
                {currentPolicy === "strangers" && t("policyDescStrangers")}
              </p>
            </CardContent>
          </Card>

          {/* Adapter-specific setup card */}
          {selectedChannel === "slack" && (
            <SlackChannelSetupCard onUpdated={refreshReadiness} />
          )}
          {selectedChannel === "telegram" && (
            <TelegramChannelSetupCard onUpdated={refreshReadiness} />
          )}
          {selectedChannel === "discord" && (
            <DiscordChannelSetupCard onUpdated={refreshReadiness} />
          )}
          {selectedChannel === "phone" && (
            <PhoneChannelSetupCard onUpdated={refreshReadiness} />
          )}
          {selectedChannel === "email" && (
            <EmailChannelSetupCard />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Slack Card
// ---------------------------------------------------------------------------

function SlackChannelSetupCard({ onUpdated }: { onUpdated: () => void }) {
  const t = useTranslations("Channels");
  const { data: config, mutate } = useSlackConfig();
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!botToken || !appToken) return;
    setSaving(true);
    try {
      await saveSlackConfig({ botToken, appToken });
      setBotToken("");
      setAppToken("");
      await mutate();
      onUpdated();
      toast.success(t("slackSaved"));
    } catch {
      toast.error(t("slackSaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      await deleteSlackConfig();
      await mutate();
      onUpdated();
      toast.success(t("slackDisconnected"));
    } catch {
      toast.error(t("slackDisconnectFailed"));
    }
  };

  const handleThreadMode = async (mode: "mention_only" | "mention_then_thread") => {
    try {
      await patchSlackThreadMode(mode);
      await mutate();
      toast.success(t("threadModeUpdated"));
    } catch {
      toast.error(t("threadModeUpdateFailed"));
    }
  };

  const isConnected = config?.connected ?? false;

  return (
    <Card className="gap-4 py-4 shadow-xs" data-testid="slack-setup-card">
      <CardHeader className="px-5 py-0">
        <CardTitle className="text-sm font-semibold">{t("slackSetupTitle")}</CardTitle>
        <CardDescription className="text-xs">{t("slackSetupSubtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-5 py-0">
        {isConnected ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-lg border border-border/70 bg-card p-3">
              <div className="flex items-center gap-2.5">
                <CheckCircle className="size-4 text-primary" />
                <div className="leading-tight">
                  <p className="text-xs font-semibold text-foreground">{config?.teamName || t("slackConnected")}</p>
                  <p className="text-[11px] text-muted-foreground">{config?.botUsername ? `@${config.botUsername}` : ""}</p>
                </div>
              </div>
              <Button variant="destructive" size="sm" onClick={handleDisconnect} data-testid="slack-disconnect-button">
                {t("disconnect")}
              </Button>
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-medium">{t("threadBehavior")}</Label>
              <RadioGroup
                value={config?.threadMode ?? "mention_then_thread"}
                onValueChange={(val) => handleThreadMode(val as "mention_only" | "mention_then_thread")}
                className="flex flex-col gap-2"
              >
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="mention_then_thread" id="mode-thread" />
                  <Label htmlFor="mode-thread" className="text-xs font-normal">
                    {t("followThreads")}
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="mention_only" id="mode-mention" />
                  <Label htmlFor="mode-mention" className="text-xs font-normal">
                    {t("mentionsOnly")}
                  </Label>
                </div>
              </RadioGroup>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSave} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="slack-bot-token" className="text-xs">{t("slackBotToken")}</Label>
              <Input
                id="slack-bot-token"
                type="password"
                placeholder="xoxb-..."
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                required
                className="h-8 text-xs"
                data-testid="slack-bot-token-input"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="slack-app-token" className="text-xs">{t("slackAppToken")}</Label>
              <Input
                id="slack-app-token"
                type="password"
                placeholder="xapp-..."
                value={appToken}
                onChange={(e) => setAppToken(e.target.value)}
                required
                className="h-8 text-xs"
                data-testid="slack-app-token-input"
              />
            </div>
            <Button size="sm" type="submit" disabled={saving || !botToken || !appToken} data-testid="slack-save-button">
              {saving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
              {t("connectSlack")}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Telegram Card
// ---------------------------------------------------------------------------

function TelegramChannelSetupCard({ onUpdated }: { onUpdated: () => void }) {
  const t = useTranslations("Channels");
  const { data: config, mutate } = useTelegramConfig();
  const [botToken, setBotToken] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!botToken) return;
    setSaving(true);
    try {
      await saveTelegramConfig(botToken);
      setBotToken("");
      await mutate();
      onUpdated();
      toast.success(t("telegramSaved"));
    } catch {
      toast.error(t("telegramSaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      await deleteTelegramConfig();
      await mutate();
      onUpdated();
      toast.success(t("telegramDisconnected"));
    } catch {
      toast.error(t("telegramDisconnectFailed"));
    }
  };

  const isConnected = config?.connected ?? false;

  return (
    <Card className="gap-4 py-4 shadow-xs" data-testid="telegram-setup-card">
      <CardHeader className="px-5 py-0">
        <CardTitle className="text-sm font-semibold">{t("telegramSetupTitle")}</CardTitle>
        <CardDescription className="text-xs">{t("telegramSetupSubtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-5 py-0">
        {isConnected ? (
          <div className="flex items-center justify-between rounded-lg border border-border/70 bg-card p-3">
            <div className="flex items-center gap-2.5">
              <CheckCircle className="size-4 text-primary" />
              <div className="leading-tight">
                <p className="text-xs font-semibold text-foreground">{t("telegramConnected")}</p>
                <p className="text-[11px] text-muted-foreground">{config?.botUsername ? `@${config.botUsername}` : ""}</p>
              </div>
            </div>
            <Button variant="destructive" size="sm" onClick={handleDisconnect} data-testid="telegram-disconnect-button">
              {t("disconnect")}
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSave} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="telegram-token" className="text-xs">{t("botToken")}</Label>
              <Input
                id="telegram-token"
                type="password"
                placeholder="123456789:ABCdefGHI..."
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                required
                className="h-8 text-xs"
                data-testid="telegram-token-input"
              />
            </div>
            <Button size="sm" type="submit" disabled={saving || !botToken} data-testid="telegram-save-button">
              {saving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
              {t("connectTelegram")}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Discord Card
// ---------------------------------------------------------------------------

function DiscordChannelSetupCard({ onUpdated }: { onUpdated: () => void }) {
  const t = useTranslations("Channels");
  const { data: config, mutate } = useDiscordConfig();
  const [botToken, setBotToken] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!botToken) return;
    setSaving(true);
    try {
      await saveDiscordConfig(botToken);
      setBotToken("");
      await mutate();
      onUpdated();
      toast.success(t("discordSaved"));
    } catch {
      toast.error(t("discordSaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      await deleteDiscordConfig();
      await mutate();
      onUpdated();
      toast.success(t("discordDisconnected"));
    } catch {
      toast.error(t("discordDisconnectFailed"));
    }
  };

  const isConnected = config?.connected ?? false;

  return (
    <Card className="gap-4 py-4 shadow-xs" data-testid="discord-setup-card">
      <CardHeader className="px-5 py-0">
        <CardTitle className="text-sm font-semibold">{t("discordSetupTitle")}</CardTitle>
        <CardDescription className="text-xs">{t("discordSetupSubtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-5 py-0">
        {isConnected ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-lg border border-border/70 bg-card p-3">
              <div className="flex items-center gap-2.5">
                <CheckCircle className="size-4 text-primary" />
                <div className="leading-tight">
                  <p className="text-xs font-semibold text-foreground">{t("discordConnected")}</p>
                  <p className="text-[11px] text-muted-foreground">{config?.botUsername ? `@${config.botUsername}` : ""}</p>
                </div>
              </div>
              <Button variant="destructive" size="sm" onClick={handleDisconnect} data-testid="discord-disconnect-button">
                {t("disconnect")}
              </Button>
            </div>
            {config?.inviteUrl ? (
              <a
                href={config.inviteUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
              >
                {t("addBotToServer")} <ExternalLink className="size-3" />
              </a>
            ) : null}
          </div>
        ) : (
          <form onSubmit={handleSave} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="discord-token" className="text-xs">{t("botToken")}</Label>
              <Input
                id="discord-token"
                type="password"
                placeholder="MTk4NjIyNDgz..."
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                required
                className="h-8 text-xs"
                data-testid="discord-token-input"
              />
            </div>
            <Button size="sm" type="submit" disabled={saving || !botToken} data-testid="discord-save-button">
              {saving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
              {t("connectDiscord")}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Phone (Twilio) Card
// ---------------------------------------------------------------------------

function PhoneChannelSetupCard({ onUpdated }: { onUpdated: () => void }) {
  const t = useTranslations("Channels");
  const { data: config, mutate } = useTwilioConfig();
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accountSid || !authToken) return;
    setSaving(true);
    try {
      await saveTwilioCredentials(accountSid, authToken, phoneNumber || undefined);
      setAccountSid("");
      setAuthToken("");
      setPhoneNumber("");
      await mutate();
      onUpdated();
      toast.success(t("twilioSaved"));
    } catch {
      toast.error(t("twilioSaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      await deleteTwilioCredentials();
      await mutate();
      onUpdated();
      toast.success(t("twilioDisconnected"));
    } catch {
      toast.error(t("twilioDisconnectFailed"));
    }
  };

  const isConnected = config?.hasCredentials ?? false;

  return (
    <Card className="gap-4 py-4 shadow-xs" data-testid="twilio-setup-card">
      <CardHeader className="px-5 py-0">
        <CardTitle className="text-sm font-semibold">{t("phoneSetupTitle")}</CardTitle>
        <CardDescription className="text-xs">{t("phoneSetupSubtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-5 py-0">
        {isConnected ? (
          <div className="flex items-center justify-between rounded-lg border border-border/70 bg-card p-3">
            <div className="flex items-center gap-2.5">
              <CheckCircle className="size-4 text-primary" />
              <div className="leading-tight">
                <p className="text-xs font-semibold text-foreground">{t("phoneConnected")}</p>
                <p className="text-[11px] text-muted-foreground">{config?.phoneNumber || t("noPhoneAssigned")}</p>
              </div>
            </div>
            <Button variant="destructive" size="sm" onClick={handleDisconnect} data-testid="twilio-disconnect-button">
              {t("disconnect")}
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSave} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="twilio-sid" className="text-xs">{t("twilioSid")}</Label>
              <Input
                id="twilio-sid"
                placeholder="AC..."
                value={accountSid}
                onChange={(e) => setAccountSid(e.target.value)}
                required
                className="h-8 text-xs"
                data-testid="twilio-sid-input"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="twilio-token" className="text-xs">{t("twilioToken")}</Label>
              <Input
                id="twilio-token"
                type="password"
                placeholder="Auth Token"
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
                required
                className="h-8 text-xs"
                data-testid="twilio-token-input"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="twilio-phone" className="text-xs">{t("phoneNumberOptional")}</Label>
              <Input
                id="twilio-phone"
                placeholder="+15551234567"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                className="h-8 text-xs"
                data-testid="twilio-phone-input"
              />
            </div>
            <Button size="sm" type="submit" disabled={saving || !accountSid || !authToken} data-testid="twilio-save-button">
              {saving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
              {t("saveCredentials")}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Email Card
// ---------------------------------------------------------------------------

function EmailChannelSetupCard() {
  const t = useTranslations("Channels");
  return (
    <Card className="gap-3 py-4 shadow-xs" data-testid="email-setup-card">
      <CardHeader className="px-5 py-0">
        <CardTitle className="text-sm font-semibold">{t("emailSetupTitle")}</CardTitle>
        <CardDescription className="text-xs">{t("emailSetupSubtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="px-5 py-0">
        <p className="text-xs leading-relaxed text-muted-foreground">{t("emailSetupInstructions")}</p>
      </CardContent>
    </Card>
  );
}
