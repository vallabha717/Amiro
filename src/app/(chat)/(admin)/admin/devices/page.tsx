"use client";

import { useTranslations } from "next-intl";
import { ScrollArea } from "ui/scroll-area";
import { DevicesSettings } from "@/components/devices/devices-settings";

/** Admin → Devices: pair phones, phone access on the local network, and which
 * Amiro this app is connected to. */
export default function AdminDevicesPage() {
  const t = useTranslations("Devices");
  return (
    <ScrollArea className="h-full w-full">
      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-8 sm:py-8">
        <h1 className="mb-6 text-xl font-semibold">{t("title")}</h1>
        <DevicesSettings />
      </div>
    </ScrollArea>
  );
}
