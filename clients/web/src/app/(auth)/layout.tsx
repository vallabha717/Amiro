"use client";

import { useTranslations } from "next-intl";
import { RedirectIfAuthed } from "@/lib/backend/auth-gate";
import { VrndaLogo } from "@/components/layouts/vrnda-logo";
import { AnimatedAuthTree } from "@/components/auth/animated-auth-tree";

// Was a Server Component calling getSession()+redirect() -- now a client
// gate (RedirectIfAuthed) since there's no server-side session to read
// without a round trip to the sidecar (see auth-gate.tsx's doc comment).
//
// RedirectIfAuthed deliberately wraps only {children}, not the whole shell:
// it renders null while the session request is in flight, so wrapping the
// outer <main> made the entire page blank-then-pop on every load. Keeping
// the branding panel outside the gate means only the form area waits.
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useTranslations("Auth.Intro");
  return (
    // h-dvh + overflow-hidden on one element only. The previous h-screen
    // <main> wrapping a min-h-screen child guaranteed the content box was
    // at least as tall as the viewport *inside* an already-viewport-tall
    // parent, so the page gained and lost a scrollbar as the auth form
    // changed height -- the layout half of the reported "glitching".
    <main className="relative w-full h-dvh overflow-hidden">
      <div className="flex h-full w-full">
        <div className="hidden lg:flex lg:w-1/2 bg-muted border-r flex-col p-12 xl:p-16 relative overflow-hidden">
          {/* Animated tree container with organic breathing and mouse parallax */}
          <div className="pointer-events-auto absolute inset-x-8 top-[8%] bottom-[12%] text-foreground/75">
            <AnimatedAuthTree />
          </div>
          <h1 className="relative z-10 text-3xl font-semibold flex items-center gap-2 animate-in fade-in duration-1000">
            <VrndaLogo className="size-7 shrink-0" />
            <span className="font-brand font-bold text-3xl tracking-tight">Amiro</span>
          </h1>
          <div className="flex-1" />
          <p className="relative z-10 mb-4 max-w-sm text-muted-foreground px-2">
            {t("description")}
          </p>
        </div>

        <div className="w-full lg:w-1/2 h-full overflow-y-auto">
          <RedirectIfAuthed>{children}</RedirectIfAuthed>
        </div>
      </div>
    </main>
  );
}
