"use client";

import { Actions, Eyebrow, PrimaryButton, StepTitle } from "./ui";

const WHERE: Record<string, string> = {
  desktop: "on this computer",
  "local-server": "on this computer",
  "vm-remote": "on your server",
};

export function WelcomeStep({
  mode,
  onStart,
}: {
  mode: string;
  onStart: () => void;
}) {
  return (
    <div>
      <Eyebrow>Welcome</Eyebrow>
      <StepTitle
        sub={
          <>
            Your own AI agent, running {WHERE[mode] ?? "on this computer"}.
            Setup takes about a minute. Only the password is required;
            everything else can wait.
          </>
        }
      >
        Hi. Let&rsquo;s get you set&nbsp;up.
      </StepTitle>
      <ul className="space-y-3 text-[15px] text-foreground/80">
        {[
          ["1", "Secure it with a password"],
          ["2", "Name your agent and pick its look"],
          ["3", "Connect the AI model that powers it"],
        ].map(([n, text]) => (
          <li key={n} className="flex items-center gap-3">
            <span className="grid size-6 place-items-center rounded-full border border-foreground/15 text-xs tabular-nums text-muted-foreground">
              {n}
            </span>
            {text}
          </li>
        ))}
      </ul>
      <Actions>
        <PrimaryButton
          autoFocus
          onClick={onStart}
          data-testid="onboarding-start"
        >
          Get started
        </PrimaryButton>
      </Actions>
      <p className="mt-8 text-xs leading-relaxed text-muted-foreground">
        Setting up a server? Everything here can also come from{" "}
        <span className="font-mono">amiro.toml</span> or a{" "}
        <span className="font-mono">.env</span> file. See{" "}
        <span className="font-mono">docs/SETUP.md</span>.
      </p>
    </div>
  );
}
