import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/backend/client";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { DetailCard } from "@/components/ui/detail-card";
import { ConnectedChannelHeader } from "./connected-channel-header";
import { Loader2 } from "lucide-react";
import {
  deleteSlackConfig,
  patchSlackThreadMode,
  saveSlackConfig,
  useSlackConfig,
} from "@/lib/backend/channels-api";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

export function SlackConnectionCard({ onUpdated }: { onUpdated: () => void }) {
  const t = useTranslations("Channels");
  const { data: config, mutate } = useSlackConfig();
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const isConnected = config?.connected ?? false;

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
    } catch (error) {
      // Show why: a rejected token says so, rather than a generic failure.
      toast.error(error instanceof ApiError && error.message ? error.message : t("slackSaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await deleteSlackConfig();
      await mutate();
      onUpdated();
      toast.success(t("slackDisconnected"));
    } catch {
      toast.error(t("slackDisconnectFailed"));
    } finally {
      setDisconnecting(false);
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

  return (
    <DetailCard
      title={t("slackSetupTitle")}
      subtitle={t("slackSetupSubtitle")}
      className="gap-4"
    >
      {isConnected ? (
        <div className="space-y-4" data-testid="slack-setup-card">
          <ConnectedChannelHeader
            address={config?.botUsername ? `@${config.botUsername}` : undefined}
            isReady={true}
            pending={disconnecting}
            onDisconnect={handleDisconnect}
            disconnectLabel={t("disconnect")}
            connectedLabel={config?.teamName || t("slackConnected")}
          />

          <div className="space-y-2 pt-1">
            <Label className="text-xs font-medium">{t("threadBehavior")}</Label>
            <RadioGroup
              value={config?.threadMode ?? "mention_then_thread"}
              onValueChange={(val) =>
                handleThreadMode(val as "mention_only" | "mention_then_thread")
              }
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
        <form onSubmit={handleSave} className="space-y-3" data-testid="slack-setup-card">
          <div className="space-y-1">
            <Label htmlFor="slack-bot-token" className="text-xs">
              {t("slackBotToken")}
            </Label>
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
            <Label htmlFor="slack-app-token" className="text-xs">
              {t("slackAppToken")}
            </Label>
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
          <Button
            size="sm"
            type="submit"
            disabled={saving || !botToken || !appToken}
            data-testid="slack-save-button"
          >
            {saving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
            {t("connectSlack")}
          </Button>
        </form>
      )}
    </DetailCard>
  );
}
