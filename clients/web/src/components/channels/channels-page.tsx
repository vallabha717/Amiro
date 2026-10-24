"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { PageShell } from "@/components/ui/page-shell";
import { ChannelAdapterList } from "./channel-adapter-list";
import { ChannelPanel } from "./channel-panel";
import {
  AdmissionPolicy,
  setChannelPolicy,
  SetupChannelId,
  useAvailableChannels,
  useChannelPolicies,
  useChannelReadiness,
} from "@/lib/backend/channels-api";

export function ChannelsPage() {
  const t = useTranslations("Channels");
  const { data: availData, isLoading: availLoading } = useAvailableChannels();
  const { data: readyData, mutate: refreshReadiness } = useChannelReadiness();
  const { data: policyData, mutate: refreshPolicies } = useChannelPolicies();

  const [selectedChannel, setSelectedChannel] = useState<SetupChannelId>("slack");
  const [policySaving, setPolicySaving] = useState(false);

  const channels = availData?.channels ?? [];
  const snapshots = readyData?.snapshots ?? [];
  const policies = policyData?.policies ?? [];

  const currentPolicy =
    policies.find((p) => p.channelType === selectedChannel)?.policy ?? "trusted_contacts";

  const handlePolicyChange = async (nextPolicy: AdmissionPolicy) => {
    setPolicySaving(true);
    try {
      await setChannelPolicy(selectedChannel, nextPolicy);
      await refreshPolicies();
      toast.success(t("policyUpdated"));
    } catch {
      toast.error(t("policyUpdateFailed"));
    } finally {
      setPolicySaving(false);
    }
  };

  return (
    <div data-testid="channels-page" className="h-full">
      <PageShell
        title={t("title")}
        subtitle={t("subtitle")}
        backHref="/agent"
        backLabel="Agent Hub"
      >
        <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-12">
          {/* Left rail: Adapter navigation list */}
          <div className="md:col-span-4">
            <ChannelAdapterList
              channels={channels}
              snapshots={snapshots}
              selectedKey={selectedChannel}
              loading={availLoading}
              onSelect={setSelectedChannel}
              title={t("adapters")}
              connectedLabel={t("connected")}
              notConnectedLabel={t("notConnected")}
            />
          </div>

          {/* Right column: Selected channel details */}
          <div className="md:col-span-8">
            <ChannelPanel
              channelId={selectedChannel}
              policy={currentPolicy}
              policySaving={policySaving}
              onPolicyChange={handlePolicyChange}
              onChannelUpdated={refreshReadiness}
            />
          </div>
        </div>
      </PageShell>
    </div>
  );
}
