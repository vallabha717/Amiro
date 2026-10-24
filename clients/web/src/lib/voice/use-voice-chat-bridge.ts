import type { UIMessage } from "ai";
import { useEffect, useRef } from "react";
import {
  markThinking,
  onVoiceTurnCancelled,
  onVoiceUtterance,
  speakDelta,
  speakEnd,
  useVoiceStore,
} from "./voice-store";

export type BridgeStatus = "submitted" | "streaming" | "ready" | "error";

export interface BridgeDeps {
  sendMessage: (msg: {
    role: "user";
    parts: [{ type: "text"; text: string }];
  }) => unknown;
  stop: () => unknown;
  speakDelta: (turnId: string, text: string) => void;
  speakEnd: (turnId: string) => void;
  markThinking: () => void;
}

/** Text of an assistant message: `text` parts only, joined by blank lines. */
export function assistantSpeechText(message: UIMessage): string {
  return message.parts
    .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .filter((t) => t.length > 0)
    .join("\n\n");
}

const isBusy = (s: BridgeStatus) => s === "submitted" || s === "streaming";

/**
 * Pure (React-free) engine behind useVoiceChatBridge so the delta/end/cancel
 * rules are testable. All mutable tracking lives on the instance.
 */
export class VoiceBridgeController {
  private baseline: Set<string> | null = null;
  private current: { id: string; sent: number; ended: boolean } | null = null;
  private cancelled = new Set<string>();
  private awaiting: { sawBusy: boolean; msgCount: number } | null = null;
  private lastMessages: UIMessage[] = [];
  private lastStatus: BridgeStatus = "ready";
  private emptyCounter = 0;

  constructor(private deps: BridgeDeps) {}

  setDeps(deps: BridgeDeps) {
    this.deps = deps;
  }

  reset() {
    this.baseline = null;
    this.current = null;
    this.cancelled.clear();
    this.awaiting = null;
  }

  onUtterance(text: string) {
    // Close out any unfinished previous turn before starting a new one.
    if (this.current && !this.current.ended) {
      this.current.ended = true;
      this.deps.speakEnd(this.current.id);
    }
    if (isBusy(this.lastStatus)) this.deps.stop();
    this.awaiting = { sawBusy: false, msgCount: this.lastMessages.length };
    this.deps.sendMessage({ role: "user", parts: [{ type: "text", text }] });
    this.deps.markThinking();
  }

  onCancel(turnId: string | null) {
    if (isBusy(this.lastStatus)) this.deps.stop();
    if (turnId) this.cancelled.add(turnId);
    if (this.current) {
      this.cancelled.add(this.current.id);
      this.current.ended = true;
    }
    const last = this.lastMessages.at(-1);
    if (last?.role === "assistant" && !this.baseline?.has(last.id))
      this.cancelled.add(last.id);
    this.awaiting = null;
  }

  sync(messages: UIMessage[], status: BridgeStatus) {
    this.lastMessages = messages;
    this.lastStatus = status;
    if (this.baseline === null) {
      this.baseline = new Set(messages.map((m) => m.id));
      return;
    }
    const busy = isBusy(status);
    if (busy && this.awaiting && messages.length > this.awaiting.msgCount) {
      this.awaiting.sawBusy = true;
    }

    const last = messages.at(-1);
    const finishing = !busy && this.awaiting?.sawBusy === true;
    const candidate =
      last &&
      last.role === "assistant" &&
      !this.baseline.has(last.id) &&
      !this.cancelled.has(last.id) &&
      (busy ||
        finishing ||
        (this.current?.id === last.id && !this.current.ended));

    if (candidate && last) {
      if (this.current?.id !== last.id) {
        if (this.current && !this.current.ended) {
          this.current.ended = true;
          this.deps.speakEnd(this.current.id);
        }
        this.current = { id: last.id, sent: 0, ended: false };
      }
      const text = assistantSpeechText(last);
      if (text.length > this.current.sent) {
        this.deps.speakDelta(last.id, text.slice(this.current.sent));
        this.current.sent = text.length;
      }
    }

    if (!busy) {
      if (this.current && !this.current.ended) {
        this.current.ended = true;
        this.deps.speakEnd(this.current.id);
        this.awaiting = null;
      } else if (finishing) {
        // The turn produced no assistant message at all: still release the server.
        this.awaiting = null;
        this.deps.speakEnd(`empty-${++this.emptyCounter}`);
      }
    }
  }
}

export function useVoiceChatBridge({
  messages,
  status,
  sendMessage,
  stop,
}: {
  messages: UIMessage[];
  status: BridgeStatus;
  sendMessage: BridgeDeps["sendMessage"];
  stop: BridgeDeps["stop"];
}): void {
  const active = useVoiceStore((s) => s.active);
  const sendRef = useRef(sendMessage);
  const stopRef = useRef(stop);
  sendRef.current = sendMessage;
  stopRef.current = stop;

  const controllerRef = useRef<VoiceBridgeController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new VoiceBridgeController({
      sendMessage: (m) => sendRef.current(m),
      stop: () => stopRef.current(),
      speakDelta,
      speakEnd,
      markThinking,
    });
  }
  const controller = controllerRef.current;

  // Subscribe to store events only while voice is active; reset on deactivate.
  useEffect(() => {
    if (!active) return;
    const offU = onVoiceUtterance((t) => controller.onUtterance(t));
    const offC = onVoiceTurnCancelled((id) => controller.onCancel(id));
    return () => {
      offU();
      offC();
      controller.reset();
    };
  }, [active, controller]);

  // Feed chat progress to the controller. It only talks to the voice socket,
  // never writes the zustand state this effect depends on.
  useEffect(() => {
    if (!active) return;
    controller.sync(messages, status);
  }, [active, controller, messages, status]);
}
