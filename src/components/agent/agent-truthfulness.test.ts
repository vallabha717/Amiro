import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static regression guard for the Agent hub, not a render test. The repo has no
 * DOM test environment (no jsdom/happy-dom and no testing-library), so the
 * behaviour of these two components is verified in the browser pass. What this
 * file locks down is the class of bug that was reported and fixed here: the hub
 * used to render invented memory counts (98/97/1) and a card of invented
 * schedules, and the personality studio labelled a locally generated string as
 * the agent's "live voice". Those must not come back without a deliberate edit.
 */

const hubSource = readFileSync(
  path.join(import.meta.dirname, "agent-overview.tsx"),
  "utf8",
);
const studioSource = readFileSync(
  path.join(import.meta.dirname, "agent-personality-studio.tsx"),
  "utf8",
);

describe("agent hub truthfulness", () => {
  it("does not ship invented memory counts as a fallback", () => {
    expect(hubSource).not.toMatch(/total:\s*98/);
    expect(hubSource).not.toMatch(/projectCount:\s*97/);
    expect(hubSource).not.toMatch(/globalCount:\s*1\b/);
    expect(hubSource).not.toMatch(/byCategory:\s*\{/);
    // The counts must come from the fetched identity, not from literals.
    expect(hubSource).toMatch(/identityData\?\.memoryStats/);
  });

  it("shows a real unavailable state instead of a plausible number", () => {
    expect(hubSource).toMatch(/memoryUnavailable\s*\?/);
    expect(hubSource).toMatch(/skillsLoaded\s*\?/);
  });

  it("gives identity fetch failure visible, retryable feedback", () => {
    expect(hubSource).toMatch(/data-testid="agent-identity-error"/);
    expect(hubSource).toMatch(/role="alert"/);
    expect(hubSource).toMatch(/retryIdentity/);
  });

  it("has no scheduled-routine examples, real or deferred", () => {
    expect(hubSource).not.toMatch(/SCHEDULE_GHOSTS/);
    expect(hubSource).not.toMatch(/Morning briefing|Nightly memory consolidation/);
    expect(hubSource).not.toMatch(/routines queued/);
    expect(hubSource).not.toMatch(/sectionKey="schedules"/);
  });

  it("opens the customizer from ?customize=1 without a Suspense-bound router hook", () => {
    expect(hubSource).toMatch(/new URLSearchParams\(window\.location\.search\)/);
    expect(hubSource).toMatch(/get\("customize"\) === "1"/);
    // No Suspense-bound router hook is called (the name may appear in prose).
    expect(hubSource).not.toMatch(/useSearchParams\s*\(/);
  });

  it("does not claim a voice feature in the customizer call to action", () => {
    expect(hubSource).not.toMatch(/avatar & voice/i);
  });
});

describe("personality studio truthfulness", () => {
  it("labels the sample as illustrative rather than live", () => {
    expect(studioSource).not.toMatch(/Live Voice Sample/);
    expect(studioSource).not.toMatch(/buildLiveSampleVoice/);
    expect(studioSource).toMatch(/Illustrative tone sample/);
    expect(studioSource).toMatch(/not recorded from or/);
  });

  it("states that the dials never change permissions", () => {
    expect(studioSource).toMatch(/data-testid="personality-permissions-note"/);
    expect(studioSource).toMatch(/never change tool\s+permissions, approvals, or safety policy/);
  });

  it("does not claim the update is written into Jcode memory", () => {
    expect(studioSource).not.toMatch(/synced to Jcode/i);
  });
});
