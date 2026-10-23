import { beforeEach, describe, expect, it } from "vitest";
import { useTerminalStore } from "./terminal-store";

describe("useTerminalStore", () => {
  beforeEach(() => {
    useTerminalStore.getState().reset();
  });

  it("starts in idle state with no session", () => {
    const state = useTerminalStore.getState();
    expect(state.status).toBe("idle");
    expect(state.sessionId).toBeNull();
    expect(state.errorMessage).toBeNull();
    expect(state.reconnectAttempts).toBe(0);
    expect(state.isolation).toBeNull();
    expect(state.cwd).toBeNull();
  });

  it("transitions idle -> connecting -> connected -> closed", () => {
    useTerminalStore.getState().requestConnect();
    expect(useTerminalStore.getState().status).toBe("connecting");

    useTerminalStore.getState().connectSucceeded("sess-123", {
      isolation: "host",
      cwd: "/home/user/.amiro/workspace",
    });

    const connected = useTerminalStore.getState();
    expect(connected.status).toBe("connected");
    expect(connected.sessionId).toBe("sess-123");
    expect(connected.isolation).toBe("host");
    expect(connected.cwd).toBe("/home/user/.amiro/workspace");

    useTerminalStore.getState().closed();
    const closed = useTerminalStore.getState();
    expect(closed.status).toBe("closed");
    expect(closed.sessionId).toBeNull();
    expect(closed.isolation).toBeNull();
  });

  it("handles connect failure and reconnect flow", () => {
    useTerminalStore.getState().requestConnect();
    useTerminalStore
      .getState()
      .connectFailed("Shell access is disabled for this team agent.");

    const failed = useTerminalStore.getState();
    expect(failed.status).toBe("error");
    expect(failed.errorMessage).toBe(
      "Shell access is disabled for this team agent.",
    );

    useTerminalStore.getState().requestReconnect();
    const reconnecting = useTerminalStore.getState();
    expect(reconnecting.status).toBe("reconnecting");
    expect(reconnecting.reconnectAttempts).toBe(1);

    useTerminalStore.getState().reconnectSucceeded("sess-456", {
      isolation: "container",
      cwd: "/home/agent",
    });
    const reconnected = useTerminalStore.getState();
    expect(reconnected.status).toBe("connected");
    expect(reconnected.sessionId).toBe("sess-456");
    expect(reconnected.reconnectAttempts).toBe(0);
    expect(reconnected.isolation).toBe("container");
    expect(reconnected.cwd).toBe("/home/agent");
  });
});
