"use client";

import Link from "next/link";
import { ArrowRight, KeyRound } from "lucide-react";
import { ScrollArea } from "ui/scroll-area";
import { Card, CardDescription, CardHeader, CardTitle } from "ui/card";
import { UserDetailContent } from "@/components/user/user-detail/user-detail-content";
import { UserInstructionsContent } from "@/components/chat-preferences-content";

/**
 * Admin → General (Vellum-style preferences page).
 *
 * Combines the signed-in account's profile/credentials cards
 * (`UserDetailContent view="user"`: Profile, Password, Workspace Trust,
 * GitHub credential card) with the personalization instructions
 * (`UserInstructionsContent`) in one scrollable column.
 */
export default function AdminGeneralPage() {
  return (
    <ScrollArea className="h-full w-full">
      <div className="max-w-3xl mx-auto px-8 py-8 flex flex-col gap-8">
        <section className="flex flex-col gap-4">
          <div>
            <h3 className="text-xl font-semibold">Profile &amp; Credentials</h3>
            <p className="text-sm text-muted-foreground pt-2">
              Manage your account details, password, workspace trust and
              connected credentials.
            </p>
          </div>

          <Link
            href="/admin/credentials"
            data-testid="admin-general-credentials-link"
          >
            <Card className="cursor-pointer transition-colors hover:bg-accent/40 border-border/80">
              <CardHeader className="flex flex-row items-center gap-3 space-y-0 py-4">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background/40">
                  <KeyRound className="size-5 text-primary" />
                </div>
                <div className="min-w-0 flex-1">
                  <CardTitle className="text-base">
                    Credentials &amp; Secret Vault
                  </CardTitle>
                  <CardDescription>
                    Manage encrypted secrets, tokens, API keys and agent
                    environment variable bindings.
                  </CardDescription>
                </div>
                <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
              </CardHeader>
            </Card>
          </Link>

          <UserDetailContent view="user" />
        </section>

        <section className="flex flex-col gap-4 border-t border-border/60 pt-8">
          <UserInstructionsContent />
        </section>
      </div>
    </ScrollArea>
  );
}
