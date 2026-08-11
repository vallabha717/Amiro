"use client";

import type { ReactNode } from "react";
import { RequireAdmin } from "@/lib/backend/auth-gate";

// Was a Server Component calling requireAdminPermission()+unauthorized();
// now RequireAdmin (client-side role check against useSession(), see
// auth-gate.tsx). The pages under this group are further scoped down --
// see admin/users/(list)/page.tsx's doc comment for why.
export default function AdminLayout({ children }: { children: ReactNode }) {
  return <RequireAdmin>{children}</RequireAdmin>;
}
