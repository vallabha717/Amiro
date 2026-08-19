"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { apiJson } from "@/lib/backend/client";
import { CheckCircle2, ChevronRight, Loader2 } from "lucide-react";

const providers = [
  { id: "openai", name: "OpenAI", requiresBaseUrl: true },
  { id: "litellm", name: "LiteLLM", requiresBaseUrl: true },
  { id: "anthropic", name: "Anthropic", requiresBaseUrl: false },
  { id: "google", name: "Google Gemini", requiresBaseUrl: false },
  { id: "groq", name: "Groq", requiresBaseUrl: false },
  { id: "ollama", name: "Ollama", requiresBaseUrl: true, defaultBaseUrl: "http://localhost:11434" },
];

export default function OnboardingWizard() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [selectedProvider, setSelectedProvider] = useState(providers[0].id);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const activeProvider = providers.find((p) => p.id === selectedProvider);

  const handleSaveProvider = async () => {
    if (!apiKey && activeProvider?.id !== "ollama") {
      toast.error("API Key is required");
      return;
    }

    setIsSaving(true);
    try {
      await apiJson("/api/ai/providers", {
        method: "POST",
        body: JSON.stringify({
          provider: selectedProvider,
          name: activeProvider?.name || selectedProvider,
          apiKey: apiKey,
          baseUrl: baseUrl,
        }),
      });

      toast.success(`${activeProvider?.name} configured successfully!`);
      setStep(2); // Move to completion step
    } catch (e: any) {
      toast.error(e.message || "Failed to save provider");
    } finally {
      setIsSaving(false);
    }
  };

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
            Let's get your AI environment set up.
          </CardDescription>
        </CardHeader>
        
        <CardContent className="pt-6">
          {step === 1 && (
            <div className="space-y-8">
              <div>
                <h3 className="text-lg font-medium mb-3">1. Select a Provider</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {providers.map((provider) => (
                    <div
                      key={provider.id}
                      data-testid={`onboarding-provider-${provider.id}`}
                      onClick={() => {
                        setSelectedProvider(provider.id);
                        setApiKey("");
                        setBaseUrl(provider.defaultBaseUrl || "");
                      }}
                      className={`cursor-pointer rounded-lg border-2 p-4 text-center transition-all ${
                        selectedProvider === provider.id
                          ? "border-primary bg-primary/5 text-primary"
                          : "border-muted hover:border-primary/50"
                      }`}
                    >
                      <div className="font-medium">{provider.name}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-4 rounded-lg bg-card p-6 border">
                <h3 className="text-lg font-medium">
                  2. Configure {activeProvider?.name}
                </h3>
                
                <div className="space-y-2">
                  <Label htmlFor="apiKey">API Key</Label>
                  <Input
                    id="apiKey"
                    data-testid="onboarding-api-key-input"
                    type="password"
                    placeholder={`sk-...`}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Your key is stored securely in your OS Keychain and never leaves your device.
                  </p>
                </div>

                {activeProvider?.requiresBaseUrl && (
                  <div className="space-y-2 pt-2">
                    <Label htmlFor="baseUrl">Custom Base URL (Optional)</Label>
                    <Input
                      id="baseUrl"
                      data-testid="onboarding-base-url-input"
                      type="url"
                      placeholder="https://api.openai.com/v1"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Override if using an OpenAI-compatible proxy (like LiteLLM or LM Studio).
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="flex flex-col items-center justify-center py-12 text-center space-y-4">
              <div className="h-16 w-16 bg-primary/10 rounded-full flex items-center justify-center text-primary mb-2">
                <CheckCircle2 className="h-8 w-8" />
              </div>
              <h2 className="text-2xl font-semibold">You're all set!</h2>
              <p className="text-muted-foreground max-w-md">
                Your AI provider is configured and ready to go. You can add more providers or change your default models anytime in the Settings panel.
              </p>
            </div>
          )}
        </CardContent>

        <CardFooter className="flex justify-between border-t p-6 bg-muted/20">
          {step === 1 ? (
            <>
              <Button variant="ghost" data-testid="onboarding-skip-button" onClick={() => router.push("/")}>
                Skip for now
              </Button>
              <Button data-testid="onboarding-save-button" onClick={handleSaveProvider} disabled={isSaving}>
                {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Save & Continue
                <ChevronRight className="ml-2 h-4 w-4" />
              </Button>
            </>
          ) : (
            <Button data-testid="onboarding-finish-button" onClick={finishSetup} className="w-full text-lg h-12">
              Start Using Amiro
            </Button>
          )}
        </CardFooter>
      </Card>
    </div>
  );
}
