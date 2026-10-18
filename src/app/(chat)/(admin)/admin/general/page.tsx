"use client";

import { ScrollArea } from "ui/scroll-area";
import { GeneralSettings } from "@/components/general/general-settings";

/**
 * Admin → General, mirroring Vellum's General page: Timezone, Version and
 * Compute and resources. Account and credentials live in their own pages.
 */
export default function AdminGeneralPage() {
  return (
    <ScrollArea className="h-full w-full">
      <div className="max-w-3xl mx-auto px-8 py-8">
        <GeneralSettings />
      </div>
    </ScrollArea>
  );
}
