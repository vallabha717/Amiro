"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoginPanel } from "@/components/chat/login-panel";
import { CheckCircle2, ChevronRight, ServerCog } from "lucide-react";

/**
 * First-run wizard.
 *
 * The provider step is the same `LoginPanel` the chat `/login` command opens,
 * so onboarding and the chat surface can never drift apart. The old bespoke
 * list of hardcoded providers (and its "stored in your OS Keychain, never
 * leaves your device" claim) is gone: on the hosted/shared Amiro runtime the
 * credentials live server-side and are shared at the runtime level, which the
 * notice below states plainly instead of overpromising per-user isolation.
 */
export default function OnboardingWizard() {
  const router = useRouter();
  const [step, setStep] = useState(1);

  const finishSetup = () => {
    router.push("/");
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-muted/40 p-4">
      <Card className="w-full max-w-2xl shadow-lg">
        <CardHeader className="text-center pb-2">
          <CardTitle className="text-3xl font-bold tracking-tight">
            Welcome to Amiro
          </CardTitle>
          <CardDescription className="text-base">
            Let&apos;s get your AI environment set up.
          </CardDescription>
        </CardHeader>

        <CardContent className="pt-6">
          {step === 1 && (
            <div className="space-y-5">
              <Alert data-testid="onboarding-runtime-notice">
                <ServerCog />
                <AlertTitle>Shared runtime credentials</AlertTitle>
                <AlertDescription>
                  Amiro runs on a shared Amiro runtime. Provider credentials are
                  stored server-side on this host and used by every user of this
                  instance. They are not kept in an OS keychain and are not
                  isolated per user. Credentials are managed by an
                  administrator.
                </AlertDescription>
              </Alert>

              <div>
                <h3 className="text-lg font-medium mb-3">
                  Connect a provider
                </h3>
                <LoginPanel onClose={() => setStep(2)} />
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="flex flex-col items-center justify-center py-12 text-center space-y-4">
              <div className="h-16 w-16 bg-primary/10 rounded-full flex items-center justify-center text-primary mb-2">
                <CheckCircle2 className="h-8 w-8" />
              </div>
              <h2 className="text-2xl font-semibold">You&apos;re all set!</h2>
              <p className="text-muted-foreground max-w-md">
                Amiro is ready to go. You can connect more providers or change
                your default models anytime from the chat&apos;s{" "}
                <span className="font-mono">/login</span> command.
              </p>
            </div>
          )}
        </CardContent>

        <CardFooter className="flex justify-between border-t p-6 bg-muted/20">
          {step === 1 ? (
            <>
              <Button
                variant="ghost"
                data-testid="onboarding-skip-button"
                onClick={() => router.push("/")}
              >
                Skip for now
              </Button>
              <Button
                data-testid="onboarding-continue-button"
                onClick={() => setStep(2)}
              >
                Continue
                <ChevronRight className="ml-2 h-4 w-4" />
              </Button>
            </>
          ) : (
            <Button
              data-testid="onboarding-finish-button"
              onClick={finishSetup}
              className="w-full text-lg h-12"
            >
              Start Using Amiro
            </Button>
          )}
        </CardFooter>
      </Card>
    </div>
  );
}
