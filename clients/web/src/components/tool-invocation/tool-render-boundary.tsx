"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";

import { JsonViewPopup } from "../json-view-popup";

interface Props {
  children: ReactNode;
  /** Tool name, shown so the user can tell which tool misbehaved. */
  toolName: string;
  /** The tool's input, offered for inspection when rendering fails. */
  input?: unknown;
}

interface State {
  error: Error | null;
}

/**
 * Catches render errors thrown by a tool's custom UI component.
 *
 * Tool inputs are model output: a model can emit arguments that satisfy no
 * schema we control -- a chart with `data` missing or null, a table whose
 * columns aren't an array. The visualization components index into those
 * fields directly, so one bad call used to throw during render and, with no
 * boundary anywhere in the app, unmount the entire chat: the whole
 * conversation vanished and the only way back was a page reload.
 *
 * A tool that can't render is a bad tool call, not a bad session. This scopes
 * the failure to the one tool card and keeps the input visible so the user can
 * see what the model actually sent.
 */
export class ToolRenderBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      `Tool "${this.props.toolName}" failed to render`,
      error,
      info.componentStack,
    );
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex flex-col gap-2 p-4 text-sm border rounded-lg border-destructive/30 bg-destructive/5">
        <div className="flex gap-2 items-center text-destructive">
          <TriangleAlert className="size-3.5 shrink-0" />
          <span className="font-medium">
            {this.props.toolName} could not be displayed
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          The tool was called with data this view can&apos;t render.
        </p>
        {this.props.input != null && (
          <div className="text-xs">
            <JsonViewPopup data={this.props.input} />
          </div>
        )}
      </div>
    );
  }
}
