import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  color: undefined as string | undefined,
  ref: { current: undefined as string | undefined },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: () => state.ref,
  useEffect: (effect: () => void) => effect(),
}));
vi.mock("@/hooks/queries/use-agent-identity", () => ({
  useAgentIdentity: () => ({
    data: state.color ? { traits: { color: state.color } } : undefined,
  }),
}));
vi.mock("@/hooks/use-theme-style", () => ({ useThemeStyle: vi.fn() }));
import { IdentityThemeSync } from "./theme-provider";

describe("identity theme hydration", () => {
  beforeEach(() => {
    state.color = undefined;
    state.ref.current = undefined;
  });

  it("hydrates a late saved identity then leaves explicit local changes alone", () => {
    const apply = vi.fn();
    IdentityThemeSync({ current: "default", apply });
    expect(apply).not.toHaveBeenCalled();
    state.color = "green";
    IdentityThemeSync({ current: "default", apply });
    expect(apply).toHaveBeenCalledExactlyOnceWith("zen-garden");
    IdentityThemeSync({ current: "orange", apply });
    IdentityThemeSync({ current: "cyberpunk-neon", apply });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("adopts a subsequent customizer color once, including across repeated effects", () => {
    const apply = vi.fn();
    state.color = "green";
    IdentityThemeSync({ current: "zen-garden", apply });
    state.color = "pink";
    IdentityThemeSync({ current: "zen-garden", apply });
    IdentityThemeSync({ current: "zen-garden", apply });
    expect(apply).toHaveBeenCalledExactlyOnceWith("pink");
  });

  it("does not reset an unknown legacy color", () => {
    const apply = vi.fn();
    state.color = "legacy";
    IdentityThemeSync({ current: "midnight", apply });
    expect(apply).not.toHaveBeenCalled();
  });
});
