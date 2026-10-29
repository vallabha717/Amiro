import type { PlanComment } from "./use-artifacts";

/**
 * The plan decision, as the chat message the user sends.
 *
 * `ui_propose_plan` ends the agent's turn (like `ui_ask_user`), so the user's
 * answer is an ordinary next message. The first words are the contract:
 * `readPlanDecisionMessage` tells approval from revision by them, so the
 * Plan tab can show "Approved" after a reload from the transcript alone.
 */
const APPROVED = "Plan approved";
const CHANGES = "Changes requested on the plan";

type Note = Pick<PlanComment, "section" | "quote" | "note">;

function noteLines(comments: Note[]): string {
  return comments
    .map((c) => {
      const where = c.section ? ` (in "${c.section}")` : "";
      return c.quote ? `- On «${c.quote}»${where}: ${c.note}` : `- ${c.note}`;
    })
    .join("\n");
}

export function formatPlanDecisionMessage(
  decision: "proceed" | "revise",
  title: string,
  comments: Note[],
): string {
  const name = title ? ` "${title}"` : "";
  if (decision === "proceed") {
    const head = `${APPROVED}${name}. Write the steps to the task list with the todo tool and start.`;
    return comments.length
      ? `${head}\n\nKeep these notes in mind while you work:\n${noteLines(comments)}`
      : head;
  }
  const head = `${CHANGES}${name}. Revise it and call ui_propose_plan again; do not start the work yet.`;
  return comments.length ? `${head}\n\n${noteLines(comments)}` : head;
}

/** What a user message says about the plan above it. */
export function readPlanDecisionMessage(text: string): "proceed" | "revise" {
  return text.trimStart().startsWith(APPROVED) ? "proceed" : "revise";
}
