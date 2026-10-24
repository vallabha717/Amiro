"use client";

import { Suspense } from "react";
import { ApproveDevice } from "@/components/devices/approve-device";

// Outside the (chat) shell: a bare page reached from a link on the device.
// useSearchParams() (?code=) needs a Suspense boundary under output: "export".
export default function DevicePage() {
  return (
    <Suspense>
      <ApproveDevice />
    </Suspense>
  );
}
