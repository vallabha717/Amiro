"use client";

import type { ReactNode } from "react";
import { RequireAdmin } from "@/lib/backend/auth-gate";

export default function UsageAdminLayout({ children }: { children: ReactNode }) {
  return <RequireAdmin>{children}</RequireAdmin>;
}
