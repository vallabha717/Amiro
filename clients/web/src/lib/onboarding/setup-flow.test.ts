import { describe, expect, it } from "vitest";
import {
  SETUP_STEPS,
  answerTurn,
  firstTurn,
  mainStepOf,
  nextStep,
  progressOf,
  type SetupTurn,
  skippedSteps,
} from "./setup-flow";

describe("setup flow", () => {
  it("walks look → prompt → personality → provider → search → connectors → speak → listen", () => {
    expect(SETUP_STEPS).toEqual([
      "greet",
      "look",
      "prompt",
      "personality",
      "provider",
      "search",
      "connectors",
      "voice",
      "listen",
      "done",
    ]);
    expect(nextStep("look")).toBe("prompt");
    expect(nextStep("voice")).toBe("listen");
    expect(nextStep("listen")).toBe("done");
    expect(nextStep("done")).toBe("done");
  });

  it("continues after the parent once a follow-up is answered", () => {
    expect(mainStepOf("providerConnect")).toBe("provider");
    expect(nextStep("providerConnect")).toBe("search");
    expect(nextStep("searchConnect")).toBe("connectors");
    expect(nextStep("voiceConnect")).toBe("listen");
    expect(nextStep("listenConnect")).toBe("done");
  });

  it("counts progress over the real steps only", () => {
    expect(progressOf("look")).toEqual({ index: 1, total: 8 });
    expect(progressOf("providerConnect")).toEqual({ index: 4, total: 8 });
    expect(progressOf("greet").index).toBe(0);
  });

  it("answers the open turn and opens the next, or a chosen follow-up", () => {
    let turns = firstTurn();
    turns = answerTurn(turns, "Let's go");
    expect(turns.map((t) => t.step)).toEqual(["greet", "look"]);
    expect(turns[0].reply).toBe("Let's go");

    turns = answerTurn(turns, "Teal sprout");
    turns = answerTurn(turns, "Looks good");
    turns = answerTurn(turns, "Balanced");
    turns = answerTurn(turns, "Anthropic", {
      next: { step: "providerConnect", subject: "anthropic-api" },
    });
    const open = turns[turns.length - 1];
    expect(open.step).toBe("providerConnect");
    expect(open.subject).toBe("anthropic-api");
    turns = answerTurn(turns, "Connected");
    expect(turns[turns.length - 1].step).toBe("search");
  });

  it("ignores a second answer to a closed turn and closes done without a next", () => {
    const done = answerTurn([{ key: "done-0", step: "done" }], "Finish");
    expect(done).toHaveLength(1);
    expect(answerTurn(done, "again")).toBe(done);
  });

  it("reports a step as skipped when its last answer was a skip", () => {
    let turns: SetupTurn[] = [{ key: "search-0", step: "search" }];
    turns = answerTurn(turns, "Skip", { skipped: true });
    turns = answerTurn(turns, "Skip", { skipped: true });
    expect(skippedSteps(turns)).toEqual(["search", "connectors"]);

    const connected = answerTurn(
      answerTurn([{ key: "provider-0", step: "provider" }], "OpenAI", {
        next: { step: "providerConnect", subject: "openai-api" },
      }),
      "Skip",
      { skipped: true },
    );
    // Picked a provider but skipped connecting it: still unfinished.
    expect(skippedSteps(connected)).toEqual(["provider"]);
    const finished = answerTurn(
      answerTurn([{ key: "provider-0", step: "provider" }], "OpenAI", {
        next: { step: "providerConnect", subject: "openai-api" },
      }),
      "Connected",
    );
    expect(skippedSteps(finished)).toEqual([]);
  });
});
