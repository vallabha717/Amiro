import { create } from "zustand";
import type { TerminalStatus } from "./types";

export interface TerminalState {
  status: TerminalStatus;
  errorMessage: string | null;
  reconnectAttempts: number;
  sessionId: string | null;
  isolation: "host" | "container" | null;
  cwd: string | null;
}

export interface TerminalActions {
  requestConnect: () => void;
  connectSucceeded: (
    sessionId: string,
    meta?: { isolation?: "host" | "container"; cwd?: string },
  ) => void;
  connectFailed: (message: string) => void;
  disconnected: () => void;
  requestReconnect: () => void;
  reconnectSucceeded: (
    sessionId: string,
    meta?: { isolation?: "host" | "container"; cwd?: string },
  ) => void;
  reconnectFailed: (message: string) => void;
  errorOccurred: (message: string) => void;
  closed: () => void;
  reset: () => void;
}

export type TerminalStore = TerminalState & TerminalActions;

export const useTerminalStore = create<TerminalStore>()((set, get) => ({
  status: "idle",
  errorMessage: null,
  reconnectAttempts: 0,
  sessionId: null,
  isolation: null,
  cwd: null,

  requestConnect: () => {
    const { status } = get();
    if (status === "idle" || status === "closed" || status === "error") {
      set({ status: "connecting", errorMessage: null, reconnectAttempts: 0 });
    }
  },

  connectSucceeded: (sessionId, meta) => {
    if (get().status === "connecting") {
      set({
        status: "connected",
        sessionId,
        errorMessage: null,
        reconnectAttempts: 0,
        isolation: meta?.isolation ?? null,
        cwd: meta?.cwd ?? null,
      });
    }
  },

  connectFailed: (message) => {
    if (get().status === "connecting") {
      set({ status: "error", errorMessage: message, sessionId: null });
    }
  },

  disconnected: () => {
    if (get().status === "connected") {
      set({
        status: "error",
        errorMessage: "Connection lost.",
        sessionId: null,
      });
    }
  },

  requestReconnect: () => {
    const { status, reconnectAttempts } = get();
    if (status === "error" || status === "connected") {
      set({
        status: "reconnecting",
        errorMessage: null,
        reconnectAttempts: reconnectAttempts + 1,
        sessionId: null,
      });
    }
  },

  reconnectSucceeded: (sessionId, meta) => {
    if (get().status === "reconnecting") {
      set({
        status: "connected",
        sessionId,
        errorMessage: null,
        reconnectAttempts: 0,
        isolation: meta?.isolation ?? null,
        cwd: meta?.cwd ?? null,
      });
    }
  },

  reconnectFailed: (message) => {
    if (get().status === "reconnecting") {
      set({ status: "error", errorMessage: message, sessionId: null });
    }
  },

  errorOccurred: (message) => {
    set({ status: "error", errorMessage: message, sessionId: null });
  },

  closed: () => {
    set({
      status: "closed",
      errorMessage: null,
      sessionId: null,
      isolation: null,
      cwd: null,
    });
  },

  reset: () => {
    set({
      status: "idle",
      errorMessage: null,
      reconnectAttempts: 0,
      sessionId: null,
      isolation: null,
      cwd: null,
    });
  },
}));
