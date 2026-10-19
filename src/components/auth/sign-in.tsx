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
import { useRouter } from "next/navigation";
import { useState } from "react";

import { authClient } from "auth/client";
import { Loader } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { safe } from "ts-safe";

// Amiro is a single-owner, email/password app: there is no social sign-in and
// no sign-up. A fresh instance with no account is routed to the first-run
// "Set up Amiro" page by the (auth) layout's RedirectIfAuthed gate, so this
// page only ever renders the credentials form.
export default function SignIn() {
  const t = useTranslations();
  const router = useRouter();

  const [loading, setLoading] = useState(false);

  const [formData, setFormData] = useObjectState({
    email: "",
    password: "",
  });

  const emailAndPasswordSignIn = () => {
    setLoading(true);
    safe(async () => {
      const res = await authClient.signIn.email(
        { email: formData.email, password: formData.password },
        {
          onError(ctx) {
            toast.error(ctx.error.message || ctx.error.statusText);
          },
        },
      );
      if (res?.data) {
        router.push("/onboarding");
      }
      return res;
    }).watch(() => setLoading(false));
  };

  return (
    <div className="w-full h-full flex flex-col p-4 md:p-8 justify-center">
      <Card className="w-full md:max-w-md bg-background border-none mx-auto shadow-none">
        <CardHeader className="my-4">
          <CardTitle className="text-2xl text-center my-1">
            {t("Auth.SignIn.title")}
          </CardTitle>
          <CardDescription className="text-center text-muted-foreground">
            {t("Auth.SignIn.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col min-h-[19rem]">
          <div className="flex flex-col gap-6">
            <div className="grid gap-2">
              <Label htmlFor="email">Email or username</Label>
              <Input
                id="email"
                data-testid="signin-email-input"
                autoFocus
                disabled={loading}
                value={formData.email}
                onChange={(e) => setFormData({ email: e.target.value })}
                type="text"
                autoComplete="username"
                placeholder="you@example.com"
                required
              />
            </div>
            <div className="grid gap-2">
              <div className="flex items-center">
                <Label htmlFor="password">Password</Label>
              </div>
              <Input
                id="password"
                data-testid="signin-password-input"
                disabled={loading}
                value={formData.password}
                placeholder="********"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    emailAndPasswordSignIn();
                  }
                }}
                onChange={(e) => setFormData({ password: e.target.value })}
                type="password"
                required
              />
            </div>
            <Button
              className="w-full"
              onClick={emailAndPasswordSignIn}
              disabled={loading}
              data-testid="signin-submit-button"
            >
              {loading ? (
                <Loader className="size-4 animate-spin ml-1" />
              ) : (
                t("Auth.SignIn.signIn")
              )}
            </Button>
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer text-center hover:text-foreground">
                Forgot your password?
              </summary>
              <p className="mt-3 leading-relaxed">
                Amiro keeps no email recovery: it runs on your own machine. On
                the computer or server running Amiro, run{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono">
                  amiro-backend reset-password
                </code>{" "}
                (for the desktop app, see docs/SETUP.md for where it lives). It
                asks for a new password and signs out every session.
              </p>
            </details>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
