import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { COLOR_TO_SIDEBAR_THEME } from "@/lib/agent/character-catalog";

const mocks = vi.hoisted(() => ({
  identity: {
    traits: { color: "green", bodyShape: "star", eyeStyle: "curious" },
  } as any,
  update: vi.fn(),
  mutate: vi.fn(),
  apply: vi.fn(),
  error: vi.fn(),
  state: vi.fn(),
}));
vi.mock("react", () => ({
  useRef: () => ({ current: false }),
  useState: () => [false, mocks.state],
}));
vi.mock("swr", () => ({ useSWRConfig: () => ({ mutate: mocks.mutate }) }));
vi.mock("sonner", () => ({ toast: { error: mocks.error } }));
vi.mock("./queries/use-agent-identity", () => ({
  AGENT_IDENTITY_KEY: "/api/agent/identity",
  useAgentIdentity: () => ({ data: mocks.identity }),
  updateAgentIdentity: mocks.update,
}));
vi.mock("./use-theme-style", () => ({
  useThemeStyle: () => ({
    themeStyle: "zen-garden",
    setThemeStyle: mocks.apply,
  }),
}));
import { useSelectAgentTheme } from "./use-select-agent-theme";

describe("sidebar agent color selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.identity = {
      traits: { color: "green", bodyShape: "star", eyeStyle: "curious" },
    };
    mocks.mutate.mockResolvedValue(undefined);
    mocks.update.mockImplementation(async (patch) => ({
      ...mocks.identity,
      ...patch,
    }));
  });

  it.each(Object.entries(COLOR_TO_SIDEBAR_THEME))(
    "persists %s before applying %s",
    async (color, theme) => {
      await useSelectAgentTheme().selectTheme(theme);
      expect(mocks.update).toHaveBeenCalledWith({
        traits: { color, bodyShape: "star", eyeStyle: "curious" },
      });
      expect(mocks.mutate).toHaveBeenNthCalledWith(
        1,
        "/api/agent/identity",
        { traits: { color, bodyShape: "star", eyeStyle: "curious" } },
        { revalidate: false },
      );
      expect(mocks.apply).toHaveBeenCalledWith(theme);
      expect(mocks.mutate).toHaveBeenNthCalledWith(2, "/api/agent/identity");
      expect(mocks.update.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.apply.mock.invocationCallOrder[0],
      );
    },
  );

  it("does not change theme on save failure and releases pending guard", async () => {
    mocks.update.mockRejectedValueOnce(new Error("offline"));
    const hook = useSelectAgentTheme();
    await hook.selectTheme("orange");
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith("offline");
    await hook.selectTheme("pink");
    expect(mocks.apply).toHaveBeenCalledWith("pink");
  });

  it("blocks overlapping requests and waits for identity", async () => {
    let finish!: (value: any) => void;
    mocks.update.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const hook = useSelectAgentTheme();
    const first = hook.selectTheme("orange");
    await hook.selectTheme("pink");
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.apply).not.toHaveBeenCalled();
    finish(mocks.identity);
    await first;
    mocks.identity = undefined;
    expect(useSelectAgentTheme().disabled).toBe(true);
    await useSelectAgentTheme().selectTheme("blue");
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it("rejects unmapped themes and keeps the chooser to canonical colors", async () => {
    await useSelectAgentTheme().selectTheme("cyberpunk-neon");
    expect(mocks.update).not.toHaveBeenCalled();
    const source = readFileSync(
      "src/components/layouts/app-sidebar-user.tsx",
      "utf8",
    );
    expect(source).toContain("Object.entries(COLOR_TO_SIDEBAR_THEME)");
    expect(source).toContain("capitalizeFirstLetter(color)");
    expect(source).toContain("disabled={disabled}");
    expect(source).not.toContain("BASE_THEMES");
  });
});
