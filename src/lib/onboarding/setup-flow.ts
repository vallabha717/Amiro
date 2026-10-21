/**
 * The setup chat's script: which step follows which, for first-run
 * onboarding and for a new Team agent. Pure so it can be tested on its own;
 * the chat itself lives in src/components/setup-chat/.
 *
 * A step is one agent turn: a streamed message, then a card the user answers.
 * Some steps open a follow-up turn (pick a provider, then connect it); the
 * follow-ups are listed in FOLLOW_UP and only appear when the card asks.
 */

export type SetupMode = "onboarding" | "team";

export type SetupStepId =
  | "greet"
  | "look"
  | "prompt"
  | "personality"
  | "provider"
  | "providerConnect"
  | "search"
  | "searchConnect"
  | "connectors"
  | "voice"
  | "voiceConnect"
  | "done";

/** The main line, in order. Follow-ups slot in after their parent. */
export const SETUP_STEPS: readonly SetupStepId[] = [
  "greet",
  "look",
  "prompt",
  "personality",
  "provider",
  "search",
  "connectors",
  "voice",
  "done",
];

/** Follow-up turns and the step they belong to. */
export const FOLLOW_UP: Partial<Record<SetupStepId, SetupStepId>> = {
  providerConnect: "provider",
  searchConnect: "search",
  voiceConnect: "voice",
};

/** Steps the user may skip; the rest must be answered. */
export const SKIPPABLE: ReadonlySet<SetupStepId> = new Set([
  "personality",
  "provider",
  "providerConnect",
  "search",
  "searchConnect",
  "connectors",
  "voice",
  "voiceConnect",
]);

/** The step on the main line that a step (or its follow-up) belongs to. */
export function mainStepOf(step: SetupStepId): SetupStepId {
  return FOLLOW_UP[step] ?? step;
}

/** The next step on the main line after `step` (a follow-up continues after its parent). */
export function nextStep(step: SetupStepId): SetupStepId {
  const index = SETUP_STEPS.indexOf(mainStepOf(step));
  return SETUP_STEPS[index + 1] ?? "done";
}

/** 1-based position and total of the steps the progress label counts. */
export function progressOf(step: SetupStepId): { index: number; total: number } {
  const counted: SetupStepId[] = SETUP_STEPS.filter((s) => s !== "greet" && s !== "done");
  const index = counted.indexOf(mainStepOf(step));
  return { index: index < 0 ? 0 : index + 1, total: counted.length };
}

/** One turn of the chat: the step it asks, and once answered, the user's reply. */
export interface SetupTurn {
  key: string;
  step: SetupStepId;
  /** What the follow-up is about, e.g. the provider id to connect. */
  subject?: string;
  /** Words the follow-up's message needs, e.g. the provider's name. */
  meta?: Record<string, string>;
  /** The user's answer as a chat bubble; unset while the turn is open. */
  reply?: string;
  skipped?: boolean;
}

/**
 * Close the open turn with the user's reply and open the next one. `next`
 * overrides the main line, e.g. to open a follow-up for the chosen provider.
 */
export function answerTurn(
  turns: SetupTurn[],
  reply: string,
  options: {
    skipped?: boolean;
    next?: { step: SetupStepId; subject?: string; meta?: Record<string, string> };
  } = {},
): SetupTurn[] {
  const open = turns[turns.length - 1];
  if (!open || open.reply !== undefined) return turns;
  const closed: SetupTurn = { ...open, reply, skipped: options.skipped };
  if (open.step === "done") return [...turns.slice(0, -1), closed];
  const next = options.next ?? { step: nextStep(open.step) };
  return [
    ...turns.slice(0, -1),
    closed,
    {
      key: `${next.step}-${turns.length}`,
      step: next.step,
      subject: next.subject,
      meta: next.meta,
    },
  ];
}

/**
 * Main-line steps left unfinished: the last answer for the step (or its
 * follow-up) was a skip. Picking a provider and then skipping the connect
 * leaves the provider step unfinished.
 */
export function skippedSteps(turns: SetupTurn[]): SetupStepId[] {
  const last = new Map<SetupStepId, boolean>();
  for (const turn of turns) {
    if (turn.reply !== undefined) last.set(mainStepOf(turn.step), !!turn.skipped);
  }
  return [...last].filter(([, skipped]) => skipped).map(([step]) => step);
}

export function firstTurn(): SetupTurn[] {
  return [{ key: "greet-0", step: "greet" }];
}
