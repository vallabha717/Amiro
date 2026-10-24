/**
 * Ambient types for `@novnc/novnc`.
 */
declare module "@novnc/novnc" {
  export interface RFBEventMap {
    connect: CustomEvent<Record<string, never>>;
    disconnect: CustomEvent<{ clean: boolean }>;
    securityfailure: CustomEvent<{ status: number; reason?: string }>;
    clipboard: CustomEvent<{ text: string }>;
  }

  export default class RFB {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket);
    background: string;
    scaleViewport: boolean;
    viewOnly: boolean;
    focusOnClick: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    dragViewport: boolean;
    clipboardPasteFrom(text: string): void;
    disconnect(): void;
    addEventListener<K extends keyof RFBEventMap>(
      type: K,
      listener: (event: RFBEventMap[K]) => void,
    ): void;
  }
}
