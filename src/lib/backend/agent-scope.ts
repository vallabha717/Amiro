"use client";

import { useSyncExternalStore } from "react";
import { mutate } from "swr";

/**
 * Which team agent the provider, model, connector, key, search and skill
 * pages currently act on. `null` is the main agent (Amiro). Every API call
 * sends it as `X-Amiro-Agent` (client.ts), and the backend resolves it to that
 * agent's own runtime and vault (backend/src/routes/agents.rs `AgentState`).
 *
 * It lives for the browser tab (sessionStorage) so moving between the
 * existing settings pages keeps it; the scope banner always shows it and
 * offers the way out. See docs/multi-agent-team/03-per-agent-config.md.
 */
const STORAGE_KEY = "amiro.agentScope";
const HEADER = "X-Amiro-Agent";

let scope: string | null = readStored();
const listeners = new Set<() => void>();

function readStored(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function getAgentScope(): string | null {
  return scope;
}

/**
 * Set (or with `null` clear) the scope. Safe to call during render: it is
 * idempotent, and a change revalidates every cached request so no page keeps
 * showing the previous agent's data.
 */
export function setAgentScope(next: string | null) {
  const value = next && next !== "main" ? next : null;
  if (value === scope) return;
  scope = value;
  try {
    if (value) window.sessionStorage.setItem(STORAGE_KEY, value);
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private windows can refuse storage; the in-memory scope still applies.
  }
  queueMicrotask(() => {
    for (const listener of listeners) listener();
    void mutate(() => true);
  });
}

export function agentScopeHeaders(): Record<string, string> {
  return scope ? { [HEADER]: scope } : {};
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAgentScope(): string | null {
  return useSyncExternalStore(subscribe, getAgentScope, () => null);
}
