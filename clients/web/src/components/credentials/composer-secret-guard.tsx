"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useSWRConfig } from "swr";
import {
  AlertTriangle,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { Button } from "ui/button";
import { Input } from "ui/input";
import { Label } from "ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "ui/dialog";
import { toast } from "sonner";

import {
  detectSecretsInText,
  isStorableFromInput,
  maskSecretValue,
  rewriteDraftWithStoredCredential,
  suggestCredentialSlot,
  type CredentialSlot,
  type DetectedSecret,
} from "@/lib/security/secret-detection";
import {
  saveCredential,
  toCredentialEnvVar,
} from "@/lib/backend/credentials-api";

// ---------------------------------------------------------------------------
// Hook: useComposerSecretGuard
// ---------------------------------------------------------------------------

export interface UseComposerSecretGuardOptions {
  input: string;
  setInput: (val: string) => void;
}

export interface UseComposerSecretGuardResult {
  matches: DetectedSecret[];
  sendBlocked: boolean;
  dismissed: boolean;
  dialogOpen: boolean;
  setDialogOpen: (open: boolean) => void;
  checkBeforeSend: (text: string) => boolean;
  dismiss: () => void;
  allowOnceAndResend: (sendFn: () => void) => void;
}

export function useComposerSecretGuard({
  input,
  setInput: _setInput,
}: UseComposerSecretGuardOptions): UseComposerSecretGuardResult {
  const matches = useMemo(() => detectSecretsInText(input), [input]);
  const [sendBlocked, setSendBlocked] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const allowOnceTextRef = useRef<string | null>(null);
  const prevMatchesCountRef = useRef(matches.length);

  // When all secrets are removed from the draft, reset states
  useEffect(() => {
    if (matches.length === 0) {
      setDismissed(false);
      setSendBlocked(false);
      allowOnceTextRef.current = null;
    } else if (matches.length > prevMatchesCountRef.current) {
      // New secret was introduced
      setDismissed(false);
    }
    prevMatchesCountRef.current = matches.length;
  }, [matches.length]);

  const checkBeforeSend = useCallback(
    (text: string): boolean => {
      // If the bypass token was armed for this exact text, consume it and allow
      if (allowOnceTextRef.current !== null && allowOnceTextRef.current === text) {
        allowOnceTextRef.current = null;
        setSendBlocked(false);
        return true;
      }

      const detected = detectSecretsInText(text);
      if (detected.length > 0) {
        setSendBlocked(true);
        return false;
      }

      setSendBlocked(false);
      return true;
    },
    [],
  );

  const dismiss = useCallback(() => {
    setDismissed(true);
    setSendBlocked(false);
  }, []);

  const allowOnceAndResend = useCallback(
    (sendFn: () => void) => {
      allowOnceTextRef.current = input;
      setSendBlocked(false);
      setDismissed(true);
      sendFn();
    },
    [input],
  );

  return {
    matches,
    sendBlocked,
    dismissed,
    dialogOpen,
    setDialogOpen,
    checkBeforeSend,
    dismiss,
    allowOnceAndResend,
  };
}

// ---------------------------------------------------------------------------
// Component: ComposerSecretNoticeBar
// ---------------------------------------------------------------------------

export interface ComposerSecretNoticeBarProps {
  matches: DetectedSecret[];
  composerInput: string;
  sendBlocked: boolean;
  dismissed: boolean;
  onDismiss: () => void;
  onSendAnyway?: () => void;
  onStoreSecurely: () => void;
}

export function ComposerSecretNoticeBar({
  matches,
  composerInput,
  sendBlocked,
  dismissed,
  onDismiss,
  onSendAnyway,
  onStoreSecurely,
}: ComposerSecretNoticeBarProps) {
  const first = matches[0];
  if (!first || (dismissed && !sendBlocked)) {
    return null;
  }

  const storable = isStorableFromInput(first, composerInput);

  return (
    <div
      className="mb-2 w-full rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-950 shadow-sm transition dark:border-amber-500/30 dark:bg-amber-950/20 dark:text-amber-200"
      data-testid="composer-secret-notice"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          {sendBlocked ? (
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          ) : (
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          )}
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-1.5 font-medium">
              <span>
                {sendBlocked
                  ? "Message blocked: API key detected"
                  : "API key or secret detected in composer"}
              </span>
              <span className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[11px] text-amber-900 dark:text-amber-300">
                {maskSecretValue(first.value)}
              </span>
            </div>
            <p className="text-[11px] text-amber-800/90 dark:text-amber-300/80">
              API keys should not be sent in plain chat where they can appear in transcripts or logs. Save it securely to your encrypted Credential Vault instead.
            </p>
          </div>
        </div>

        {!sendBlocked && (
          <button
            type="button"
            onClick={onDismiss}
            className="text-amber-700/70 hover:text-amber-950 dark:text-amber-400 dark:hover:text-amber-100"
            data-testid="composer-dismiss-notice"
            aria-label="Dismiss warning"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2">
        {storable && (
          <Button
            type="button"
            size="sm"
            className="h-7 gap-1.5 text-xs bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-600 dark:hover:bg-amber-500"
            onClick={onStoreSecurely}
            data-testid="composer-store-securely"
          >
            <Lock className="size-3" />
            Store securely
          </Button>
        )}

        {sendBlocked && onSendAnyway && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs border-amber-600/40 text-amber-900 hover:bg-amber-500/20 dark:border-amber-400/30 dark:text-amber-200"
            onClick={onSendAnyway}
            data-testid="composer-send-anyway"
          >
            Send anyway
          </Button>
        )}

        {sendBlocked && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-amber-800 hover:bg-amber-500/20 dark:text-amber-300"
            onClick={onDismiss}
            data-testid="composer-dismiss-notice"
          >
            Dismiss
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component: StoreCredentialModal
// ---------------------------------------------------------------------------

export interface StoreCredentialModalProps {
  secret: DetectedSecret | null;
  composerInput: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  setInput: (val: string) => void;
  onStored?: (slot: CredentialSlot) => void;
}

export function StoreCredentialModal({
  secret,
  composerInput,
  open,
  onOpenChange,
  setInput,
  onStored,
}: StoreCredentialModalProps) {
  const serviceInputId = useId();
  const fieldInputId = useId();
  const labelInputId = useId();
  const valueInputId = useId();

  const { mutate } = useSWRConfig();

  const [service, setService] = useState("");
  const [field, setField] = useState("");
  const [label, setLabel] = useState("");
  const [isRevealed, setIsRevealed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync suggestion on secret change
  useEffect(() => {
    if (secret) {
      const suggestion = suggestCredentialSlot(secret.label);
      setService(suggestion.service);
      setField(suggestion.field);
      setLabel(
        secret.label && secret.label !== "Token-shaped value" ? secret.label : "",
      );
      setError(null);
    }
  }, [secret]);

  if (!secret) return null;

  const envVar = toCredentialEnvVar(service || "SERVICE", field || "FIELD");
  const canSave =
    service.trim().length > 0 && field.trim().length > 0 && !isSubmitting;

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave || !secret) return;

    setIsSubmitting(true);
    setError(null);

    const slot: CredentialSlot = {
      service: service.trim().toLowerCase(),
      field: field.trim().toLowerCase(),
    };

    try {
      await saveCredential({
        service: slot.service,
        field: slot.field,
        value: secret.value,
        label: label.trim() || undefined,
      });

      await mutate("/api/credentials");

      // Rewrite composer draft replacing secret with vault reference
      const rewritten = rewriteDraftWithStoredCredential(
        composerInput,
        secret.value,
        slot,
      );
      setInput(rewritten);

      onStored?.(slot);
      toast.success(
        `Stored ${slot.service}/${slot.field} securely in Credential Vault`,
      );
      onOpenChange(false);
    } catch (err: any) {
      setError(err?.message || "Failed to store credential. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        data-testid="store-credential-modal"
      >
        <DialogHeader>
          <div className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-lg bg-primary/10 text-primary">
              <ShieldCheck className="size-4" />
            </span>
            <DialogTitle className="text-base font-semibold">
              Store Credential Securely
            </DialogTitle>
          </div>
          <DialogDescription className="text-xs text-muted-foreground pt-1">
            Save this key into your encrypted Credential Vault. Amiro will rewrite your draft so the raw key is never sent or logged in chat.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSave} className="space-y-3.5 py-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor={serviceInputId} className="text-xs font-medium">
                Service / Provider
              </Label>
              <Input
                id={serviceInputId}
                value={service}
                onChange={(e) => setService(e.target.value)}
                placeholder="e.g. openai"
                disabled={isSubmitting}
                className="h-8 text-xs font-mono"
                required
                data-testid="store-credential-service"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={fieldInputId} className="text-xs font-medium">
                Field Name
              </Label>
              <Input
                id={fieldInputId}
                value={field}
                onChange={(e) => setField(e.target.value)}
                placeholder="e.g. api_key"
                disabled={isSubmitting}
                className="h-8 text-xs font-mono"
                required
                data-testid="store-credential-field"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={labelInputId} className="text-xs font-medium">
              Display Label (optional)
            </Label>
            <Input
              id={labelInputId}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. OpenAI Production Key"
              disabled={isSubmitting}
              className="h-8 text-xs"
              data-testid="store-credential-label"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={valueInputId} className="text-xs font-medium">
              Detected Secret Value
            </Label>
            <div className="relative flex items-center">
              <Input
                id={valueInputId}
                type={isRevealed ? "text" : "password"}
                value={secret.value}
                readOnly
                disabled
                className="h-8 pr-9 text-xs font-mono bg-muted/50 cursor-not-allowed"
                data-private
                data-testid="store-credential-value"
              />
              <button
                type="button"
                onClick={() => setIsRevealed((v) => !v)}
                className="absolute right-2.5 text-muted-foreground hover:text-foreground"
                aria-label={isRevealed ? "Hide value" : "Reveal value"}
              >
                {isRevealed ? (
                  <EyeOff className="size-3.5" />
                ) : (
                  <Eye className="size-3.5" />
                )}
              </button>
            </div>
            <p className="font-mono text-[11px] text-muted-foreground">
              Exposed to runtime as: <span className="text-foreground">${envVar}</span>
            </p>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <DialogFooter className="gap-2 sm:gap-0 pt-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
              data-testid="store-credential-cancel"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              className="gap-1.5"
              disabled={!canSave}
              data-testid="store-credential-save"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Storing…
                </>
              ) : (
                <>
                  <KeyRound className="size-3.5" />
                  Store & rewrite draft
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Combined ComposerSecretGuard Component
// ---------------------------------------------------------------------------

export interface ComposerSecretGuardProps {
  guard: UseComposerSecretGuardResult;
  input: string;
  setInput: (val: string) => void;
  onSendAnyway?: () => void;
}

export function ComposerSecretGuard({
  guard,
  input,
  setInput,
  onSendAnyway,
}: ComposerSecretGuardProps) {
  const first = guard.matches[0] ?? null;

  return (
    <>
      <ComposerSecretNoticeBar
        matches={guard.matches}
        composerInput={input}
        sendBlocked={guard.sendBlocked}
        dismissed={guard.dismissed}
        onDismiss={guard.dismiss}
        onSendAnyway={onSendAnyway}
        onStoreSecurely={() => guard.setDialogOpen(true)}
      />
      <StoreCredentialModal
        secret={first}
        composerInput={input}
        open={guard.dialogOpen}
        onOpenChange={guard.setDialogOpen}
        setInput={setInput}
      />
    </>
  );
}
