"use client";

import { useTranslations } from "next-intl";
import { FlipWords } from "ui/flip-words";
import { BackgroundPaths } from "ui/background-paths";
import { RedirectIfAuthed } from "@/lib/backend/auth-gate";
import { VrndaLogo } from "@/components/layouts/vrnda-logo";

// Was a Server Component calling getSession()+redirect() -- now a client
// gate (RedirectIfAuthed) since there's no server-side session to read
// without a round trip to the sidecar (see auth-gate.tsx's doc comment).
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useTranslations("Auth.Intro");
  return (
    <RedirectIfAuthed>
      <main className="relative w-full flex flex-col h-screen">
        <div className="flex-1">
          <div className="flex min-h-screen w-full">
            <div className="hidden lg:flex lg:w-1/2 bg-muted border-r flex-col p-18 relative">
              <div className="absolute inset-0 w-full h-full">
                <BackgroundPaths />
              </div>
              <h1 className="text-xl font-semibold flex items-center gap-1.5 animate-in fade-in duration-1000">
                <VrndaLogo className="size-8" />
                <span>Amiro</span>
              </h1>
              <div className="flex-1" />
              <FlipWords
                words={[t("description")]}
                className=" mb-4 text-muted-foreground"
              />
            </div>

            <div className="w-full lg:w-1/2 p-6">{children}</div>
          </div>
        </div>
      </main>
    </RedirectIfAuthed>
  );
}
