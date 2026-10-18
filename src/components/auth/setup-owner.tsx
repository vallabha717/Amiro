"use client";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useObjectState } from "@/hooks/use-object-state";
import { ApiError } from "@/lib/backend/client";
import { setupOwner } from "@/lib/backend/session-context";
import { Check, Loader, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";

/**
 * First-run owner setup. Amiro is a single-owner app: the very first person to
 * open a fresh instance chooses the owner's email/username and password here.
 * The form is deliberately link-free -- there is nothing to navigate to until
 * the owner exists. The backend creates the account only while the user store
 * is empty, so this page is the one and only account-creation path.
 */
export default function SetupOwner() {
  const t = useTranslations("Auth.Setup");
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useObjectState({
    email: "",
    password: "",
    confirm: "",
  });

  const rules = useMemo(
    () => ({
      length: formData.password.length >= 12,
      letter: /[a-zA-Z]/.test(formData.password),
      numberOrSymbol: /[\d\W_]/.test(formData.password),
    }),
    [formData.password],
  );

  const submit = async () => {
    const email = formData.email.trim();
    if (!email) {
      toast.error(t("identifierRequired"));
      return;
    }
    if (!rules.length || !rules.letter || !rules.numberOrSymbol) {
      toast.error(t("weakPassword"));
      return;
    }
    if (formData.password !== formData.confirm) {
      toast.error(t("passwordMismatch"));
      return;
    }
    setLoading(true);
    try {
      await setupOwner(email, formData.password);
      toast.success(t("success"));
      router.push("/onboarding");
    } catch (e) {
      toast.error(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : t("failed"),
      );
    } finally {
      setLoading(false);
    }
  };

  const ruleRow = (ok: boolean, label: string) => (
    <div className="flex items-center gap-2 text-xs">
      {ok ? (
        <Check className="size-3 text-primary" />
      ) : (
        <X className="size-3 text-destructive" />
      )}
      <span className={ok ? "text-primary" : "text-muted-foreground"}>
        {label}
      </span>
    </div>
  );

  return (
    <div className="w-full h-full flex flex-col p-4 md:p-8 justify-center">
      <Card className="w-full md:max-w-md bg-background border-none mx-auto shadow-none">
        <CardHeader className="my-4">
          <CardTitle className="text-2xl text-center my-1">
            {t("title")}
          </CardTitle>
          <CardDescription className="text-center text-muted-foreground">
            {t("description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="grid gap-2">
            <Label htmlFor="setup-email">{t("identifierLabel")}</Label>
            <Input
              id="setup-email"
              data-testid="setup-email-input"
              autoFocus
              disabled={loading}
              value={formData.email}
              onChange={(e) => setFormData({ email: e.target.value })}
              type="text"
              autoComplete="username"
              placeholder="owner@example.com"
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="setup-password">{t("passwordLabel")}</Label>
            <Input
              id="setup-password"
              data-testid="setup-password-input"
              disabled={loading}
              value={formData.password}
              onChange={(e) => setFormData({ password: e.target.value })}
              type="password"
              autoComplete="new-password"
              placeholder="********"
              required
            />
            {formData.password && (
              <div className="mt-1 space-y-1">
                {ruleRow(rules.length, t("ruleLength"))}
                {ruleRow(rules.letter, t("ruleLetter"))}
                {ruleRow(rules.numberOrSymbol, t("ruleNumberOrSymbol"))}
              </div>
            )}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="setup-confirm">{t("confirmLabel")}</Label>
            <Input
              id="setup-confirm"
              data-testid="setup-confirm-input"
              disabled={loading}
              value={formData.confirm}
              onChange={(e) => setFormData({ confirm: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              type="password"
              autoComplete="new-password"
              placeholder="********"
              required
            />
          </div>
          <Button
            className="w-full"
            onClick={submit}
            disabled={loading}
            data-testid="setup-submit-button"
          >
            {loading ? (
              <Loader className="size-4 animate-spin ml-1" />
            ) : (
              t("submit")
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
