"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Account creation moved into the onboarding wizard; keep old links working. */
export default function SetupPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/onboarding");
  }, [router]);
  return null;
}
