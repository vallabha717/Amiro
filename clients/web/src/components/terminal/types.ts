export type TerminalStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error"
  | "closed";

export interface TerminalDimensions {
  cols: number;
  rows: number;
}

export interface TerminalSessionInfo {
  session_id: string;
  id: string;
  agent_id: string;
  isolation?: "host" | "container";
  cwd?: string;
}
