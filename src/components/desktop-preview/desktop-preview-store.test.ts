import { beforeEach, describe, expect, it } from "vitest";
import { useDesktopPreviewStore } from "./desktop-preview-store";

describe("useDesktopPreviewStore", () => {
  beforeEach(() => {
    useDesktopPreviewStore.setState({
      session: null,
      activeSurface: "browser",
      position: null,
      width: 420,
    });
  });

  it("toggles floating TV preview and fullscreen modal per agent", () => {
    useDesktopPreviewStore.getState().toggle("main");
    expect(useDesktopPreviewStore.getState().session).toEqual({
      agentId: "main",
      view: "preview",
    });

    useDesktopPreviewStore.getState().setFullscreen(true);
    expect(useDesktopPreviewStore.getState().session).toEqual({
      agentId: "main",
      view: "fullscreen",
    });

    useDesktopPreviewStore.getState().setActiveSurface("files");
    expect(useDesktopPreviewStore.getState().activeSurface).toBe("files");

    useDesktopPreviewStore.getState().toggle("main");
    expect(useDesktopPreviewStore.getState().session).toBeNull();
  });
});
