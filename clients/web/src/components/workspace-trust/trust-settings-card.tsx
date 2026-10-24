"use client";

import { useWorkspaceTrustGrants } from "@/hooks/queries/use-workspace-trust";
import {
  WORKSPACE_TRUST_KEY,
  revokeWorkspaceTrust,
} from "@/lib/backend/workspace-trust-api";
import { FolderLock, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { mutate } from "swr";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "ui/card";
import { handleErrorWithToast } from "ui/shared-toast";

/**
 * The other half of the trust prompt: every root the signed-in user has
 * granted, with a revoke action. The `granted_via` badge is the one place
 * that value surfaces at all this phase -- a fuller audit trail (who, when,
 * from which surface) is Tier 3 of docs/future-implementation/
 * amiro-vs-coding-agents-comparison.md, not this one.
 */
export function WorkspaceTrustSettingsCard() {
  const t = useTranslations("WorkspaceTrust");
  const { data } = useWorkspaceTrustGrants();
  const grants = data?.grants ?? [];

  const handleRevoke = async (root: string) => {
    try {
      await revokeWorkspaceTrust(root);
      toast.success(t("revokedToast"));
      mutate(WORKSPACE_TRUST_KEY);
    } catch (err) {
      handleErrorWithToast(err as Error);
    }
  };

  return (
    <Card data-testid="workspace-trust-settings-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <FolderLock className="size-4" />
          {t("settingsTitle")}
        </CardTitle>
        <CardDescription>{t("settingsDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {grants.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("empty")}</p>
        ) : (
          grants.map((grant) => (
            <div
              key={grant.resolvedRoot}
              data-testid="workspace-trust-grant-row"
              className="flex items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span className="truncate text-xs font-medium">
                  {grant.resolvedRoot}
                </span>
                <Badge variant="outline" className="w-fit text-[10px]">
                  {grant.grantedVia === "env"
                    ? t("grantedViaEnv")
                    : t("grantedViaPrompt")}
                </Badge>
              </div>
              <Button
                variant="ghost"
                size="icon"
                data-testid="workspace-trust-revoke-button"
                onClick={() => handleRevoke(grant.resolvedRoot)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
