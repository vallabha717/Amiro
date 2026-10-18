"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeft,
  BarChart3,
  Bell,
  Cpu,
  KeyRound,
  Puzzle,
  Search,
  SlidersHorizontal,
  Volume2,
  type LucideIcon,
} from "lucide-react";
import { cn } from "lib/utils";
import { RequireAdmin } from "@/lib/backend/auth-gate";

type AdminSection = {
  id: string;
  title: string;
  subtitle: string;
  href: string;
  icon: LucideIcon;
  testId: string;
  isActive: (pathname: string) => boolean;
};

const ADMIN_SECTIONS: AdminSection[] = [
  {
    id: "general",
    title: "General",
    subtitle: "Profile, credentials & workspace preferences",
    href: "/admin/general",
    icon: SlidersHorizontal,
    testId: "admin-sidebar-link-general",
    isActive: (p) => p === "/admin/general" || p.startsWith("/admin/general/"),
  },
  {
    id: "notifications",
    title: "Notifications",
    subtitle: "Web & desktop notification alerts, quiet hours & delivery channels",
    href: "/admin/notifications",
    icon: Bell,
    testId: "admin-sidebar-link-notifications",
    isActive: (p) => p.startsWith("/admin/notifications"),
  },
  {
    id: "credentials",
    title: "Credentials",
    subtitle: "Encrypted secrets and agent environment variables",
    href: "/admin/credentials",
    icon: KeyRound,
    testId: "admin-sidebar-link-credentials",
    isActive: (p) => p.startsWith("/admin/credentials"),
  },
  {
    id: "providers",
    title: "Models & Providers",
    subtitle: "Model gateways and provider credentials",
    href: "/admin/providers",
    icon: Cpu,
    testId: "admin-sidebar-link-providers",
    isActive: (p) => p.startsWith("/admin/providers"),
  },
  {
    id: "search",
    title: "Search Providers",
    subtitle: "Web search backends",
    href: "/admin/search",
    icon: Search,
    testId: "admin-sidebar-link-search",
    isActive: (p) => p.startsWith("/admin/search"),
  },
  {
    id: "voice",
    title: "Voice & Speech",
    subtitle: "Text-to-speech, speech-to-text, custom 9Router & read-aloud",
    href: "/admin/voice",
    icon: Volume2,
    testId: "admin-sidebar-link-voice",
    isActive: (p) => p.startsWith("/admin/voice"),
  },
  {
    id: "integrations",
    title: "Integrations & MCP",
    subtitle: "App connectors and MCP servers",
    href: "/admin/integrations",
    icon: Puzzle,
    testId: "admin-sidebar-link-integrations",
    isActive: (p) => p.startsWith("/admin/integrations"),
  },
  {
    id: "usage",
    title: "Usage & Users",
    subtitle: "Token usage, limits and accounts",
    href: "/admin/usage",
    icon: BarChart3,
    testId: "admin-sidebar-link-usage",
    isActive: (p) =>
      p.startsWith("/admin/usage") || p.startsWith("/admin/users"),
  },
];

function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const active =
    ADMIN_SECTIONS.find((section) => section.isActive(pathname)) ??
    ADMIN_SECTIONS[1];

  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col p-3 sm:p-5 overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/80 bg-card/40 backdrop-blur-sm shadow-sm">
        {/* Top header bar */}
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border/60 px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              href="/"
              aria-label="Back to app"
              data-testid="admin-shell-back-button"
              className="h-8 w-8 rounded-lg border border-border/70 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              <ArrowLeft className="size-4" />
            </Link>
            <div className="flex min-w-0 items-baseline gap-2">
              <h2 className="truncate text-lg font-semibold tracking-tight text-foreground">
                {active.title}
              </h2>
              <span className="hidden truncate text-xs text-muted-foreground sm:inline">
                {active.subtitle}
              </span>
            </div>
          </div>
        </div>

        {/* Mobile navigation bar */}
        <div className="flex md:hidden gap-1.5 overflow-x-auto border-b border-border/60 px-4 py-2 shrink-0">
          {ADMIN_SECTIONS.map((section) => {
            const isActive = section.isActive(pathname);
            return (
              <Link
                key={section.id}
                href={section.href}
                data-testid={`${section.testId}-mobile`}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors",
                  isActive
                    ? "border-border/70 bg-accent text-accent-foreground font-medium"
                    : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                <section.icon className="size-3.5" />
                <span>{section.title}</span>
              </Link>
            );
          })}
        </div>

        {/* Body */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <aside className="hidden md:flex w-60 shrink-0 flex-col justify-between border-r border-border/60 bg-background/40 p-3 overflow-y-auto">
            <nav
              aria-label="Admin preferences"
              className="flex flex-col gap-0.5"
            >
              {ADMIN_SECTIONS.map((section) => {
                const isActive = section.isActive(pathname);
                return (
                  <Link
                    key={section.id}
                    href={section.href}
                    data-testid={section.testId}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
                      isActive
                        ? "bg-accent text-accent-foreground font-medium shadow-2xs"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                    )}
                  >
                    <section.icon className="size-4 shrink-0" />
                    <span className="truncate">{section.title}</span>
                  </Link>
                );
              })}
            </nav>
          </aside>

          <div className="relative flex-1 min-w-0 min-h-0 overflow-y-auto overflow-x-hidden">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAdmin>
      <AdminShell>{children}</AdminShell>
    </RequireAdmin>
  );
}
