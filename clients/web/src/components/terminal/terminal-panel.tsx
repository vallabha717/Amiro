"use client";

import { useCallback, useRef } from "react";
import { cn } from "lib/utils";
import { TerminalConsole } from "./terminal-console";
import { useTerminalStore } from "./terminal-store";
import { TerminalToolbar } from "./terminal-toolbar";
import { useTerminalSession } from "./use-terminal-session";

export interface TerminalPanelProps {
  agentId: string;
  agentLabel?: string;
  className?: string;
}

export function TerminalPanel({
  agentId,
  agentLabel,
  className,
}: TerminalPanelProps) {
  const writeToTerminalRef = useRef<((data: string) => void) | null>(null);

  const handleData = useCallback((data: string) => {
    try {
      const binary = atob(data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const decoded = new TextDecoder().decode(bytes);
      writeToTerminalRef.current?.(decoded);
    } catch {
      writeToTerminalRef.current?.(data);
    }
  }, []);

  const { connect, close, sendInput, sendResize, reconnect } =
    useTerminalSession({ agentId, onData: handleData });

  const status = useTerminalStore((s) => s.status);
  const errorMessage = useTerminalStore((s) => s.errorMessage);
  const reconnectAttempts = useTerminalStore((s) => s.reconnectAttempts);
  const isolation = useTerminalStore((s) => s.isolation);
  const cwd = useTerminalStore((s) => s.cwd);

  const handleConnect = useCallback(() => {
    if (
      status === "error" ||
      status === "reconnecting" ||
      reconnectAttempts > 0
    ) {
      reconnect();
    } else {
      connect();
    }
  }, [status, reconnectAttempts, connect, reconnect]);

  const handleConsoleData = useCallback(
    (data: string) => {
      sendInput(data);
    },
    [sendInput],
  );

  const handleConsoleResize = useCallback(
    ({ cols, rows }: { cols: number; rows: number }) => {
      sendResize(cols, rows);
    },
    [sendResize],
  );

  const handleClear = useCallback(() => {
    writeToTerminalRef.current?.("\x1b[2J\x1b[H");
  }, []);

  const isReadOnly = status !== "connected";

  return (
    <div
      data-testid="terminal-panel"
      className={cn(
        "flex flex-col overflow-hidden rounded-xl border border-border/70 bg-[#0f1117]",
        className,
      )}
    >
      <TerminalToolbar
        status={status}
        onConnect={handleConnect}
        onDisconnect={close}
        onClear={handleClear}
        agentLabel={agentLabel}
        isolation={isolation}
        cwd={cwd}
      />

      {status === "error" && errorMessage && (
        <div
          role="alert"
          data-testid="terminal-error-banner"
          className="border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {errorMessage}
        </div>
      )}

      <div className="relative min-h-[380px] flex-1">
        <div className="absolute inset-0 p-1.5">
          <TerminalConsole
            onData={handleConsoleData}
            onResize={handleConsoleResize}
            readOnly={isReadOnly}
            writeRef={writeToTerminalRef}
            className="h-full w-full"
          />
        </div>
      </div>
    </div>
  );
}
