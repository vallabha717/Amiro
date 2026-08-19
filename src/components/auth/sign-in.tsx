"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useObjectState } from "@/hooks/use-object-state";

import { ArrowRight, Loader } from "lucide-react";
import { safe } from "ts-safe";
import { authClient } from "auth/client";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useAuthStatus } from "@/hooks/queries/use-auth-status";

// Social sign-in (Google/GitHub/Microsoft) is not carried over: the Go
// sidecar's auth model (internal/auth, Phase 2) is email/password only,
// no OAuth provider wiring -- see auth/client.ts's doc comment.
export default function SignIn() {
  const t = useTranslations();
  const router = useRouter();

  const [loading, setLoading] = useState(false);
  // Ports better-chatbot's `isFirstUser` gate (its sign-in page passed the
  // flag into this component and rendered the credential block only when
  // `!isFirstUser`). On a brand-new instance there is nothing to sign in
  // *to*, so offering email/password is a dead end -- show the sign-up call
  // to action instead.
  const { data: authStatus, isLoading: statusLoading } = useAuthStatus();
  const isFirstUser = authStatus?.isFirstUser ?? false;

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
            {isFirstUser
              ? t("Auth.SignUp.titleAdmin")
              : t("Auth.SignIn.title")}
          </CardTitle>
          <CardDescription className="text-center text-muted-foreground">
            {isFirstUser
              ? t("Auth.SignUp.signUpDescriptionAdmin")
              : t("Auth.SignIn.description")}
          </CardDescription>
        </CardHeader>
        {/* Reserves the credential block's height while /api/auth/status is
            in flight, so the form doesn't render-then-disappear on a fresh
            instance (or pop in late on an existing one). */}
        <CardContent className="flex flex-col min-h-[19rem]">
          {statusLoading ? null : isFirstUser ? (
            <div className="flex flex-col gap-6">
              <Link href="/sign-up" className="w-full">
                <Button className="w-full" data-testid="signin-signup-button">
                  {t("Auth.SignUp.createAccount")}
                  <ArrowRight className="size-4 ml-1" />
                </Button>
              </Link>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-6">
                <div className="grid gap-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    data-testid="signin-email-input"
                    autoFocus
                    disabled={loading}
                    value={formData.email}
                    onChange={(e) => setFormData({ email: e.target.value })}
                    type="email"
                    placeholder="user@example.com"
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
              </div>
              <div className="my-8 text-center text-sm text-muted-foreground">
                {t("Auth.SignIn.noAccount")}
                <Link
                  href="/sign-up"
                  className="underline-offset-4 text-primary"
                >
                  {t("Auth.SignIn.signUp")}
                </Link>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
