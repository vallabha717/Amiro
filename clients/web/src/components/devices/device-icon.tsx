import type { DevicePlatform } from "@/lib/backend/devices-api";
import { Laptop, Monitor, Smartphone } from "lucide-react";

export function DeviceIcon({ platform }: { platform: DevicePlatform }) {
  const Icon = platform === "desktop" ? Laptop : platform === "web" ? Monitor : Smartphone;
  return <Icon aria-hidden className="size-5 shrink-0 text-muted-foreground" />;
}
