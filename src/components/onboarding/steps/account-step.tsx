"use client";

import { listTimezones } from "@/lib/onboarding/onboarding-api";
import { cn } from "@/lib/utils";
import { Eye, EyeOff } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import {
  Actions,
  Eyebrow,
  FieldLabel,
  Kbd,
  PrimaryButton,
  StepTitle,
  inputClass,
} from "./ui";

/** Same rules as the backend's validate_password. */
export function passwordChecks(password: string) {
  return {
    length: password.length >= 12,
    letter: /\p{L}/u.test(password),
    numberOrSymbol: /[\d\W_]/.test(password),
  };
}

function strength(password: string): 0 | 1 | 2 | 3 | 4 {
  if (!password) return 0;
  const c = passwordChecks(password);
  let score = 0;
  if (password.length >= 8) score++;
  if (c.length) score++;
  if (c.letter && c.numberOrSymbol) score++;
  if (password.length >= 16 && /[A-Z]/.test(password) && /[a-z]/.test(password))
    score++;
  return Math.min(score, 4) as 0 | 1 | 2 | 3 | 4;
}

const STRENGTH_LABEL = ["", "Too short", "Almost", "Good", "Strong"];

export function AccountStep({
  defaultTimezone,
  onTyping,
  onSubmit,
}: {
  defaultTimezone: string;
  onTyping: (typing: boolean) => void;
  onSubmit: (input: {
    name: string;
    login: string;
    password: string;
    timezone: string;
  }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [timezone, setTimezone] = useState(defaultTimezone);
  const [editTz, setEditTz] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zones = useMemo(() => (editTz ? listTimezones() : []), [editTz]);

  const checks = passwordChecks(password);
  const valid = checks.length && checks.letter && checks.numberOrSymbol;
  const score = strength(password);
  const matches = confirm.length > 0 && confirm === password;
  const ready = login.trim().length > 0 && valid && matches;

  const typed = () => {
    onTyping(true);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => onTyping(false), 700);
  };

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        login: login.trim(),
        password,
        timezone,
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not create the account.",
      );
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate>
      <Eyebrow>Your account</Eyebrow>
      <StepTitle sub="This is how you sign in to Amiro, from this browser or any other.">
        Make it yours.
      </StepTitle>

      <div className="space-y-5">
        <div>
          <FieldLabel htmlFor="onb-name" hint="Optional">
            What should your agent call you?
          </FieldLabel>
          <input
            id="onb-name"
            className={inputClass}
            value={name}
            autoFocus
            autoComplete="name"
            placeholder="Your name"
            onChange={(e) => {
              setName(e.target.value);
              typed();
            }}
            data-testid="onboarding-name"
          />
        </div>
        <div>
          <FieldLabel htmlFor="onb-login">Email or username</FieldLabel>
          <input
            id="onb-login"
            className={inputClass}
            value={login}
            autoComplete="username"
            placeholder="you@example.com"
            onChange={(e) => {
              setLogin(e.target.value);
              typed();
            }}
            data-testid="onboarding-login"
          />
        </div>
        <div>
          <FieldLabel
            htmlFor="onb-password"
            hint={password ? STRENGTH_LABEL[score] : "12+ characters"}
          >
            Password
          </FieldLabel>
          <div className="relative">
            <input
              id="onb-password"
              type={show ? "text" : "password"}
              className={cn(inputClass, "pr-12")}
              value={password}
              autoComplete="new-password"
              onChange={(e) => {
                setPassword(e.target.value);
                typed();
              }}
              aria-describedby="onb-password-rules"
              data-testid="onboarding-password"
            />
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              className="absolute right-2 top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-lg text-muted-foreground hover:text-foreground"
              aria-label={show ? "Hide password" : "Show password"}
            >
              {show ? (
                <EyeOff className="size-4" />
              ) : (
                <Eye className="size-4" />
              )}
            </button>
          </div>
          <div className="mt-2 grid grid-cols-4 gap-1.5" aria-hidden>
            {[1, 2, 3, 4].map((i) => (
              <span
                key={i}
                className={cn(
                  "h-1 rounded-full transition-colors duration-300",
                  score >= i ? "bg-[var(--onb-accent)]" : "bg-foreground/10",
                )}
              />
            ))}
          </div>
          <p
            id="onb-password-rules"
            className="mt-2 text-xs text-muted-foreground"
          >
            At least 12 characters, with a letter and a number or symbol.
          </p>
        </div>
        <div>
          <FieldLabel
            htmlFor="onb-confirm"
            hint={confirm && !matches ? "Doesn't match yet" : undefined}
          >
            Confirm password
          </FieldLabel>
          <input
            id="onb-confirm"
            type={show ? "text" : "password"}
            className={inputClass}
            value={confirm}
            autoComplete="new-password"
            onChange={(e) => {
              setConfirm(e.target.value);
              typed();
            }}
            data-testid="onboarding-confirm"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>Timezone</span>
          {editTz ? (
            <select
              className="h-9 rounded-lg border border-foreground/10 bg-background px-2 text-sm text-foreground"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              aria-label="Timezone"
            >
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          ) : (
            <button
              type="button"
              onClick={() => setEditTz(true)}
              className="rounded-full border border-foreground/10 px-3 py-1 text-foreground hover:border-foreground/25"
            >
              {timezone.replaceAll("_", " ")} · Change
            </button>
          )}
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-5 text-sm text-destructive">
          {error}
        </p>
      )}

      <Actions>
        <PrimaryButton
          type="submit"
          disabled={!ready}
          loading={busy}
          data-testid="onboarding-create-account"
        >
          Create account
        </PrimaryButton>
      </Actions>
      <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
        Forgot it later? On the machine running Amiro, run{" "}
        <Kbd>amiro-backend reset-password</Kbd>.
      </p>
    </form>
  );
}
