"use client";

import { Suspense } from "react";
import { PairDevice } from "@/components/devices/pair-device";

// Outside the (auth) group on purpose: a desktop app that is already signed in
// locally must still reach this page to connect to a cloud-hosted Amiro.
// useSearchParams() (?code=) needs a Suspense boundary under output: "export".
export default function PairPage() {
  return (
    <Suspense>
      <PairDevice />
    </Suspense>
  );
}
