import { DefaultToolName, ImageToolName } from "./index";

/**
 * The coarse category a tool call belongs to, used to roll a run of similar
 * steps into one row ("Explored 3 files") instead of listing each.
 *
 * Grouping is by *what the user was told happened*, not by tool identity:
 * read_file, glob and grep are three different tools but all read as
 * "looking around", and a reader scanning a finished run does not care
 * which of them was used until they expand the row.
 */
export type StepKind =
  | "explore"
  | "orient"
  | "remember"
  | "edit"
  | "command"
  | "search"
  | "plan"
  // Separate from "plan": a walkthrough is written once, at the end, and it
  // answers "what changed" rather than "what is left". Folding it into
  // "Updated the plan" would mislabel the one row that says a turn finished.
  | "summarize"
  | "delegate"
  | "visualize"
  | "other";

const KIND_BY_TOOL: Record<string, StepKind> = {
  [DefaultToolName.ReadFile]: "explore",
  [DefaultToolName.ListDir]: "explore",
  [DefaultToolName.Glob]: "explore",
  [DefaultToolName.Grep]: "explore",

  // Orientation is its own kind rather than a kind of exploring. Both
  // answer "where is X", but one row reading "Explored 1 file" for a call
  // that summarized four hundred of them would misdescribe the turn badly
  // enough to matter -- the count is the part a reader scans.
  [DefaultToolName.RepoMap]: "orient",
  [DefaultToolName.Lsp]: "orient",

  [DefaultToolName.MemoryWrite]: "remember",
  [DefaultToolName.MemoryRead]: "remember",
  [DefaultToolName.MemoryForget]: "remember",

  [DefaultToolName.EditFile]: "edit",
  [DefaultToolName.MultiEdit]: "edit",
  [DefaultToolName.WriteFile]: "edit",

  [DefaultToolName.RunShell]: "command",
  [DefaultToolName.TerminalExecution]: "command",
  // git groups with commands, not edits: the user reads "Ran 2 commands"
  // and expects `git commit` to be one of them. Filing it under "Edited 2
  // files" would count a commit as a file change, which it is not.
  [DefaultToolName.Git]: "command",
  // Same reasoning as git push itself -- a remote operation, not a file
  // edit or a plan update.
  [DefaultToolName.CreatePR]: "command",

  [DefaultToolName.TodoWrite]: "plan",
  [DefaultToolName.TodoRead]: "plan",
  [DefaultToolName.ProposePlan]: "plan",
  [DefaultToolName.Walkthrough]: "summarize",

  // Delegation is its own kind rather than a kind of exploring: a subagent
  // row expands into a returned summary, not into a list of files, and
  // folding one into "Explored 3 files" would promise a reader something
  // the row cannot show.
  [DefaultToolName.Task]: "delegate",

  [DefaultToolName.WebSearch]: "search",
  [DefaultToolName.WebContent]: "search",
  [DefaultToolName.Http]: "search",

  [DefaultToolName.CreatePieChart]: "visualize",
  [DefaultToolName.CreateBarChart]: "visualize",
  [DefaultToolName.CreateLineChart]: "visualize",
  [DefaultToolName.CreateTable]: "visualize",
  [ImageToolName]: "visualize",
};

export function stepKindOf(toolName: string | undefined): StepKind {
  if (!toolName) return "other";
  return KIND_BY_TOOL[toolName] ?? "other";
}

/**
 * Label for a group of `count` steps of one kind.
 *
 * Present tense while the group is still running, past tense once it is
 * done -- the difference between "Exploring 3 files" and "Explored 3 files"
 * is the main signal that a long turn is still moving.
 */
export function stepGroupLabel(
  kind: StepKind,
  count: number,
  running: boolean,
): string {
  const plural = (singular: string, pluralForm: string) =>
    count === 1 ? singular : pluralForm;

  switch (kind) {
    case "explore":
      return running
        ? `Exploring ${count} ${plural("file", "files")}`
        : `Explored ${count} ${plural("file", "files")}`;
    case "edit":
      return running
        ? `Editing ${count} ${plural("file", "files")}`
        : `Edited ${count} ${plural("file", "files")}`;
    case "command":
      return running
        ? `Running ${count} ${plural("command", "commands")}`
        : `Ran ${count} ${plural("command", "commands")}`;
    case "search":
      return running
        ? `Searching (${count})`
        : `Searched ${count} ${plural("source", "sources")}`;
    case "orient":
      // "Got oriented" once, not per call: two repo_map calls with
      // different focus terms are one act of orienting, and a count here
      // would invite reading it as a number of files.
      return running ? "Getting oriented" : "Got oriented";
    case "remember":
      return running
        ? "Updating notes"
        : `Updated ${count} ${plural("note", "notes")}`;
    case "plan":
      // Singular either way: consecutive plan writes are revisions of one
      // plan, and "Updated 4 plans" would be actively wrong.
      return running ? "Planning" : "Updated the plan";
    case "summarize":
      // Also singular, and also on purpose: a turn writes one walkthrough.
      // A second call is a rewrite of the first, not a second summary.
      return running ? "Writing the walkthrough" : "Wrote the walkthrough";
    case "delegate":
      return running
        ? `Delegating ${count} ${plural("task", "tasks")}`
        : `Delegated ${count} ${plural("task", "tasks")}`;
    case "visualize":
      return running
        ? `Building ${count} ${plural("view", "views")}`
        : `Built ${count} ${plural("view", "views")}`;
    default:
      return running
        ? `Running ${count} ${plural("tool", "tools")}`
        : `Ran ${count} ${plural("tool", "tools")}`;
  }
}

/** Human duration for the work-log header: "1m 12s", "42s". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/**
 * The work log's header line.
 *
 * `elapsedMs` is undefined when nothing measured the turn: a thread reopened
 * from before the server started reporting a duration. The fallback there is
 * a step count rather than a zero, because "Worked for 0s" on a turn that
 * took four minutes is a worse answer than declining to give one. A measured
 * zero is different and is shown as such -- some turns really are that fast.
 */
export function workLogHeader({
  isRunning,
  elapsedMs,
  stepCount,
}: {
  isRunning: boolean;
  elapsedMs?: number | null;
  stepCount: number;
}): string {
  if (isRunning) return `Working… ${formatDuration(elapsedMs ?? 0)}`;
  if (elapsedMs !== null && elapsedMs !== undefined) {
    return `Worked for ${formatDuration(elapsedMs)}`;
  }
  return `Worked · ${stepCount} ${stepCount === 1 ? "step" : "steps"}`;
}

/** What an edit row says about the file it touched. */
export type EditRowSummary = {
  /** "Edited", "Created", "Rewrote" -- present tense while running. */
  verb: string;
  /** Full workspace-relative path, for the row's tooltip. */
  path: string;
  /** Just the filename, which is what the row shows. */
  name: string;
  added?: number;
  removed?: number;
};

/**
 * The per-file heading for a write in the work log.
 *
 * Writes get a row each, named, while reads stay folded into a count. The
 * asymmetry is the point: "Explored 6 files" is a complete description of a
 * read, because a read changed nothing and the reader only needs to know the
 * agent looked around. A write is the opposite -- *which* file and *how much*
 * is the entire question, and "Edited 6 files" hides exactly the thing
 * someone scanning a run is scanning for.
 *
 * Returns null for a tool this does not describe, so the caller falls back to
 * the counted group label.
 */
export function editRowSummary(
  toolName: string,
  props: { input?: any; output?: any; status?: string },
): EditRowSummary | null {
  const { input, output, status } = props;
  const path: string = output?.path ?? input?.path ?? "";
  if (!path) return null;
  const running = status === "pending";
  const name = path.split("/").pop() || path;

  switch (toolName) {
    case DefaultToolName.EditFile:
    case DefaultToolName.MultiEdit:
      return {
        verb: running ? "Editing" : "Edited",
        path,
        name,
        // Undefined rather than zero while the edit is still running: a
        // row reading "+0 −0" mid-flight looks like an edit that did
        // nothing, which is a different and much more alarming thing.
        added: running ? undefined : (output?.added ?? 0),
        removed: running ? undefined : (output?.removed ?? 0),
      };
    case DefaultToolName.WriteFile: {
      if (running) return { verb: "Writing", path, name };
      // An overwrite reports no removed count -- write_file replaces a file
      // wholesale and never computed one. Showing "−0" would claim nothing
      // was lost, so the count is simply left off.
      const created = output?.created ?? true;
      return {
        verb: created ? "Created" : "Rewrote",
        path,
        name,
        added: output?.lines,
        removed: created ? 0 : undefined,
      };
    }
    default:
      return null;
  }
}
