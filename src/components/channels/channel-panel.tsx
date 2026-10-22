import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/backend/client";
import { Label } from "@/components/ui/label";
import { DetailCard } from "@/components/ui/detail-card";
import { EmptyState } from "@/components/ui/empty-state";
import { ConnectedChannelHeader } from "./connected-channel-header";
import { ChannelTrustFloorSection } from "./channel-trust-floor-section";
import { SlackConnectionCard } from "./slack-connection-card";
import { ChannelIcon, getChannelLabel } from "./channel-presentation";
import { Loader2, Mail } from "lucide-react";
import {
  AdmissionPolicy,
  deleteDiscordConfig,
  deleteTelegramConfig,
  deleteTwilioCredentials,
  saveDiscordConfig,
  saveTelegramConfig,
  saveTwilioCredentials,
  SetupChannelId,
  useDiscordConfig,
  useTelegramConfig,
  useTwilioConfig,
} from "@/lib/backend/channels-api";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

export interface ChannelPanelProps {
  channelId: SetupChannelId;
  policy: AdmissionPolicy;
  policySaving: boolean;
  onPolicyChange: (policy: AdmissionPolicy) => void;
  onChannelUpdated: () => void;
}

/**
 * The selected channel's detail panel in master-detail layout.
 * Disconnected channels render a clean Vellum EmptyState pitch with manual entry escape hatch.
 * Connected channels render ConnectedChannelHeader, settings, and trust-floor control.
 */
export function ChannelPanel({
  channelId,
  policy,
  policySaving,
  onPolicyChange,
  onChannelUpdated,
}: ChannelPanelProps) {
  const t = useTranslations("Channels");

  const trustFloorOptions = {
    no_one: { label: t("policyNoOne"), desc: t("policyDescNoOne") },
    guardian_only: { label: t("policyGuardianOnly"), desc: t("policyDescGuardianOnly") },
    trusted_contacts: { label: t("policyTrustedContacts"), desc: t("policyDescTrustedContacts") },
    any_contact: { label: t("policyAnyContact"), desc: t("policyDescAnyContact") },
    strangers: { label: t("policyStrangers"), desc: t("policyDescStrangers") },
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Admission policy / trust floor control for this channel */}
      <ChannelTrustFloorSection
        channelLabel={getChannelLabel(channelId)}
        policy={policy}
        saving={policySaving}
        onChange={onPolicyChange}
        titleText={t("trustFloorTitle", { channel: getChannelLabel(channelId) })}
        subtitleText={t("trustFloorDescription")}
        whoCanMessageLabel={t("whoCanMessage")}
        options={trustFloorOptions}
      />

      {/* Selected channel adapter card */}
      {channelId === "slack" && (
        <SlackConnectionCard onUpdated={onChannelUpdated} />
      )}
      {channelId === "telegram" && (
        <TelegramChannelPanel onUpdated={onChannelUpdated} />
      )}
      {channelId === "discord" && (
        <DiscordChannelPanel onUpdated={onChannelUpdated} />
      )}
      {channelId === "phone" && (
        <PhoneChannelPanel onUpdated={onChannelUpdated} />
      )}
      {channelId === "email" && (
        <EmailChannelPanel />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Telegram Panel
// ---------------------------------------------------------------------------

function TelegramChannelPanel({ onUpdated }: { onUpdated: () => void }) {
  const t = useTranslations("Channels");
  const { data: config, mutate } = useTelegramConfig();
  const [botToken, setBotToken] = useState("");
  const [manualEntry, setManualEntry] = useState(false);
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const isConnected = config?.connected ?? false;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!botToken) return;
    setSaving(true);
    try {
      await saveTelegramConfig(botToken);
      setBotToken("");
      setManualEntry(false);
      await mutate();
      onUpdated();
      toast.success(t("telegramSaved"));
    } catch (error) {
      // Show why: a rejected token says so, rather than a generic failure.
      toast.error(error instanceof ApiError && error.message ? error.message : t("telegramSaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await deleteTelegramConfig();
      await mutate();
      onUpdated();
      toast.success(t("telegramDisconnected"));
    } catch {
      toast.error(t("telegramDisconnectFailed"));
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <DetailCard
      title={t("telegramSetupTitle")}
      subtitle={t("telegramSetupSubtitle")}
      className="gap-4"
    >
      {isConnected ? (
        <div data-testid="telegram-setup-card">
          <ConnectedChannelHeader
            address={config?.botUsername ? `@${config.botUsername}` : undefined}
            isReady={true}
            pending={disconnecting}
            onDisconnect={handleDisconnect}
            disconnectLabel={t("disconnect")}
            connectedLabel={t("telegramConnected")}
          />
        </div>
      ) : !manualEntry ? (
        <div data-testid="telegram-setup-card">
          <EmptyState
            icon={<ChannelIcon channelId="telegram" className="size-6 text-primary" />}
            title={t("telegramDisconnectedTitle")}
            description={t("telegramDisconnectedPitch")}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => setManualEntry(true)}
                data-testid="telegram-connect-manual-button"
              >
                {t("connectManually")}
              </Button>
            }
          />
        </div>
      ) : (
        <form onSubmit={handleSave} className="space-y-3" data-testid="telegram-setup-card">
          <div className="space-y-1">
            <Label htmlFor="telegram-bot-token" className="text-xs">
              {t("telegramBotToken")}
            </Label>
            <Input
              id="telegram-bot-token"
              type="password"
              placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              required
              className="h-8 text-xs"
              data-testid="telegram-bot-token-input"
            />
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              type="submit"
              disabled={saving || !botToken}
              data-testid="telegram-save-button"
            >
              {saving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
              {t("saveToken")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              type="button"
              onClick={() => setManualEntry(false)}
            >
              {t("cancel")}
            </Button>
          </div>
        </form>
      )}
    </DetailCard>
  );
}

// ---------------------------------------------------------------------------
// Discord Panel
// ---------------------------------------------------------------------------

function DiscordChannelPanel({ onUpdated }: { onUpdated: () => void }) {
  const t = useTranslations("Channels");
  const { data: config, mutate } = useDiscordConfig();
  const [botToken, setBotToken] = useState("");
  const [manualEntry, setManualEntry] = useState(false);
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const isConnected = config?.connected ?? false;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!botToken) return;
    setSaving(true);
    try {
      await saveDiscordConfig(botToken);
      setBotToken("");
      setManualEntry(false);
      await mutate();
      onUpdated();
      toast.success(t("discordSaved"));
    } catch (error) {
      // Show why: a rejected token says so, rather than a generic failure.
      toast.error(error instanceof ApiError && error.message ? error.message : t("discordSaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await deleteDiscordConfig();
      await mutate();
      onUpdated();
      toast.success(t("discordDisconnected"));
    } catch {
      toast.error(t("discordDisconnectFailed"));
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <DetailCard
      title={t("discordSetupTitle")}
      subtitle={t("discordSetupSubtitle")}
      className="gap-4"
    >
      {isConnected ? (
        <div data-testid="discord-setup-card">
          <ConnectedChannelHeader
            address={config?.botUsername ? `@${config.botUsername}` : undefined}
            isReady={true}
            pending={disconnecting}
            onDisconnect={handleDisconnect}
            disconnectLabel={t("disconnect")}
            connectedLabel={t("discordConnected")}
          />
        </div>
      ) : !manualEntry ? (
        <div data-testid="discord-setup-card">
          <EmptyState
            icon={<ChannelIcon channelId="discord" className="size-6 text-primary" />}
            title={t("discordDisconnectedTitle")}
            description={t("discordDisconnectedPitch")}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => setManualEntry(true)}
                data-testid="discord-connect-manual-button"
              >
                {t("connectManually")}
              </Button>
            }
          />
        </div>
      ) : (
        <form onSubmit={handleSave} className="space-y-3" data-testid="discord-setup-card">
          <div className="space-y-1">
            <Label htmlFor="discord-bot-token" className="text-xs">
              {t("discordBotToken")}
            </Label>
            <Input
              id="discord-bot-token"
              type="password"
              placeholder="Bot token..."
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              required
              className="h-8 text-xs"
              data-testid="discord-bot-token-input"
            />
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              type="submit"
              disabled={saving || !botToken}
              data-testid="discord-save-button"
            >
              {saving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
              {t("saveToken")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              type="button"
              onClick={() => setManualEntry(false)}
            >
              {t("cancel")}
            </Button>
          </div>
        </form>
      )}
    </DetailCard>
  );
}

// ---------------------------------------------------------------------------
// Phone Panel
// ---------------------------------------------------------------------------

function PhoneChannelPanel({ onUpdated }: { onUpdated: () => void }) {
  const t = useTranslations("Channels");
  const { data: config, mutate } = useTwilioConfig();
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [manualEntry, setManualEntry] = useState(false);
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const isConnected = config?.hasCredentials ?? false;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accountSid || !authToken) return;
    setSaving(true);
    try {
      await saveTwilioCredentials(accountSid, authToken);
      setAccountSid("");
      setAuthToken("");
      setManualEntry(false);
      await mutate();
      onUpdated();
      toast.success(t("phoneSaved"));
    } catch {
      toast.error(t("phoneSaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await deleteTwilioCredentials();
      await mutate();
      onUpdated();
      toast.success(t("phoneDisconnected"));
    } catch {
      toast.error(t("phoneDisconnectFailed"));
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <DetailCard
      title={t("phoneSetupTitle")}
      subtitle={t("phoneSetupSubtitle")}
      className="gap-4"
    >
      {isConnected ? (
        <div data-testid="phone-setup-card">
          <ConnectedChannelHeader
            address={config?.phoneNumber ? `Phone: ${config.phoneNumber}` : undefined}
            isReady={true}
            pending={disconnecting}
            onDisconnect={handleDisconnect}
            disconnectLabel={t("disconnect")}
            connectedLabel={t("phoneConnected")}
          />
        </div>
      ) : !manualEntry ? (
        <div data-testid="phone-setup-card">
          <EmptyState
            icon={<ChannelIcon channelId="phone" className="size-6 text-primary" />}
            title={t("phoneDisconnectedTitle")}
            description={t("phoneDisconnectedPitch")}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => setManualEntry(true)}
                data-testid="phone-connect-manual-button"
              >
                {t("connectManually")}
              </Button>
            }
          />
        </div>
      ) : (
        <form onSubmit={handleSave} className="space-y-3" data-testid="phone-setup-card">
          <div className="space-y-1">
            <Label htmlFor="twilio-sid" className="text-xs">
              {t("twilioSid")}
            </Label>
            <Input
              id="twilio-sid"
              type="text"
              placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              value={accountSid}
              onChange={(e) => setAccountSid(e.target.value)}
              required
              className="h-8 text-xs"
              data-testid="twilio-sid-input"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="twilio-token" className="text-xs">
              {t("twilioToken")}
            </Label>
            <Input
              id="twilio-token"
              type="password"
              placeholder="Auth token..."
              value={authToken}
              onChange={(e) => setAuthToken(e.target.value)}
              required
              className="h-8 text-xs"
              data-testid="twilio-token-input"
            />
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              type="submit"
              disabled={saving || !accountSid || !authToken}
              data-testid="phone-save-button"
            >
              {saving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
              {t("saveCredentials")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              type="button"
              onClick={() => setManualEntry(false)}
            >
              {t("cancel")}
            </Button>
          </div>
        </form>
      )}
    </DetailCard>
  );
}

// ---------------------------------------------------------------------------
// Email Panel
// ---------------------------------------------------------------------------

function EmailChannelPanel() {
  const t = useTranslations("Channels");

  return (
    <DetailCard
      title={t("emailSetupTitle")}
      subtitle={t("emailSetupSubtitle")}
      className="gap-4"
    >
      <div data-testid="email-setup-card">
        <EmptyState
          icon={<Mail className="size-6 text-primary" />}
          title={t("emailBuiltinTitle")}
          description={t("emailBuiltinDesc")}
        />
      </div>
    </DetailCard>
  );
}
