import { create } from "zustand";

export type DesktopSurfaceTab = "browser" | "files" | "terminal";

export interface DesktopPreviewState {
  session: {
    agentId: string;
    view: "preview" | "fullscreen";
  } | null;
  activeSurface: DesktopSurfaceTab;
  position: { x: number; y: number } | null;
  width: number;
}

export interface DesktopPreviewActions {
  openPreview: (agentId: string, surface?: DesktopSurfaceTab) => void;
  openFullscreen: (agentId: string, surface?: DesktopSurfaceTab) => void;
  toggle: (agentId: string, fullscreen?: boolean) => void;
  setFullscreen: (fullscreen: boolean) => void;
  setActiveSurface: (surface: DesktopSurfaceTab) => void;
  setPosition: (position: { x: number; y: number }) => void;
  resize: (width: number, position: { x: number; y: number }) => void;
  close: () => void;
}

export const useDesktopPreviewStore = create<
  DesktopPreviewState & DesktopPreviewActions
>()((set) => ({
  session: null,
  activeSurface: "browser",
  position: null,
  width: 420,

  openPreview: (agentId, surface) =>
    set((state) => ({
      session: { agentId, view: "preview" },
      activeSurface: surface ?? state.activeSurface,
    })),

  openFullscreen: (agentId, surface) =>
    set((state) => ({
      session: { agentId, view: "fullscreen" },
      activeSurface: surface ?? state.activeSurface,
    })),

  toggle: (agentId, fullscreen = false) =>
    set((state) => ({
      session:
        state.session?.agentId === agentId
          ? null
          : {
              agentId,
              view: fullscreen ? "fullscreen" : "preview",
            },
    })),

  setFullscreen: (fullscreen) =>
    set((state) => ({
      session: state.session
        ? { ...state.session, view: fullscreen ? "fullscreen" : "preview" }
        : null,
    })),

  setActiveSurface: (activeSurface) => set({ activeSurface }),

  setPosition: (position) => set({ position }),

  resize: (width, position) => set({ width, position }),

  close: () => set({ session: null }),
}));
