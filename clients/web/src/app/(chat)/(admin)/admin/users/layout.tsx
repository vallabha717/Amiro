"use client";

import type { ReactNode } from "react";
import { RequireAdmin } from "@/lib/backend/auth-gate";

export default function UsersAdminLayout({ children }: { children: ReactNode }) {
  return <RequireAdmin>{children}</RequireAdmin>;
}
