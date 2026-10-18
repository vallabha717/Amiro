"use client";

import { ScrollArea } from "ui/scroll-area";
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
          <UserDetailContent view="user" />
        </section>

        <section className="flex flex-col gap-4 border-t border-border/60 pt-8">
          <UserInstructionsContent />
        </section>
      </div>
    </ScrollArea>
  );
}
