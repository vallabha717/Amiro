"use client";

import { type ReactNode, createContext, useContext } from "react";

/**
 * Where a presenter is being rendered.
 *
 * "chat" is the message stream, which is a *log*: it says what happened and
 * how much, and stays scannable across a hundred steps. "detail" is the
 * Workflow View's panel, which is a *record*: one node at a time, opened
 * deliberately, with room for the whole thing.
 *
 * The distinction exists so the two surfaces can share one presenter instead
 * of drifting into two implementations of the same tool. A presenter that
 * needs to differ reads this; most do not and never mention it.
 */
export type PresenterSurfaceKind = "chat" | "detail";

// Defaults to "detail" so a surface that has not thought about this gets
// everything. Losing content is the failure that is hard to notice; showing
// too much is the one the next reader will report.
const PresenterSurfaceContext = createContext<PresenterSurfaceKind>("detail");

export function PresenterSurface({
  value,
  children,
}: {
  value: PresenterSurfaceKind;
  children: ReactNode;
}) {
  return (
    <PresenterSurfaceContext.Provider value={value}>
      {children}
    </PresenterSurfaceContext.Provider>
  );
}

export function usePresenterSurface(): PresenterSurfaceKind {
  return useContext(PresenterSurfaceContext);
}
