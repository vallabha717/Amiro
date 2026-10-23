import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillSummary } from "@/types/skill";

const mocks = vi.hoisted(() => ({
  items: [] as SkillSummary[],
  isLoading: false,
  error: undefined as Error | undefined,
  push: vi.fn(),
  mutate: vi.fn(),
  duplicateSkill: vi.fn(),
  projectDirectory: null as string | null,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("next/dynamic", () => ({ default: () => () => null }));

vi.mock("@/hooks/use-agent-theme", () => ({
  useAgentTheme: () => ({ accentHex: "#E9642F" }),
}));

vi.mock("@/hooks/queries/use-agent-identity", () => ({
  useAgentIdentity: () => ({ data: { name: "Amiro" } }),
}));

vi.mock("@/hooks/queries/use-skills", () => ({
  useSkills: () => ({
    data: { items: mocks.items, diagnostics: [], truncated: false },
    isLoading: mocks.isLoading,
    error: mocks.error,
  }),
  useMutateSkills: () => mocks.mutate,
}));

vi.mock("@/lib/backend/skills-api", () => ({
  duplicateSkill: mocks.duplicateSkill,
}));

vi.mock("@/app/store", () => ({
  appStore: Object.assign(
    (selector: (s: unknown) => unknown) =>
      selector({
        projectDirectory: mocks.projectDirectory,
        currentThreadId: null,
        threadMentions: {},
      }),
    {
      getState: () => ({
        currentThreadId: null,
        threadMentions: {},
        projectDirectory: mocks.projectDirectory,
      }),
      setState: vi.fn(),
    }
  ),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { SkillsList } from "./skills-list";

function makeSkill(overrides: Partial<SkillSummary> & { name: string }): SkillSummary {
  return {
    description: "Does something useful.",
    scope: "user",
    source: ".amiro",
    path: `/skills/${overrides.name}`,
    writable: false,
    deliverable: true,
    ...overrides,
  };
}

const builtinSkill = makeSkill({
  name: "summarize",
  description: "Summarize any text quickly.",
  source: "bundled",
  scope: "user",
  writable: false,
  bundled: true,
  emoji: "📝",
  displayName: "Summarize",
  category: "content",
});

const customSkill = makeSkill({
  name: "my-helper",
  description: "My personal helper.",
  source: ".agents",
  scope: "user",
  writable: true,
});

const projectSkill = makeSkill({
  name: "project-tool",
  description: "Project scoped tool.",
  source: ".agents",
  scope: "project",
  writable: true,
});

const disabledSkill = makeSkill({
  name: "archived-skill",
  description: "Not deliverable.",
  source: ".amiro",
  writable: false,
  deliverable: false,
  invokableReason: "Skill is archived",
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.items = [];
  mocks.isLoading = false;
  mocks.error = undefined;
  mocks.projectDirectory = null;
});

describe("SkillsList — polished superpowers", () => {
  it("renders header, count, search and filters", () => {
    mocks.items = [builtinSkill, customSkill];
    const html = renderToStaticMarkup(createElement(SkillsList));
    expect(html).toContain("Superpowers");
    expect(html).toContain("2 total");
    expect(html).toContain('data-testid="superpowers-search-input"');
    expect(html).toContain('data-testid="superpowers-filter-all"');
    expect(html).toContain('data-testid="superpowers-filter-builtin"');
    expect(html).toContain('data-testid="superpowers-filter-custom"');
    // Project only appears once a project's skills are in the list.
    expect(html).not.toContain('data-testid="superpowers-filter-project"');
    expect(html).toContain('data-testid="create-skill-button"');
    expect(html).toContain('data-testid="superpowers-back-link"');
  });

  it("removes decorative constellation and giant create card", () => {
    mocks.items = [builtinSkill];
    const html = renderToStaticMarkup(createElement(SkillsList));
    expect(html).not.toContain("superpowers-constellation-canvas");
    expect(html).not.toContain("Constellation");
    expect(html).not.toContain("Orbit");
    expect(html).not.toContain("create-skill-card");
    expect(html).not.toContain("My Custom (");
    expect(html).not.toContain("Runtime &amp; Workspace Superpowers");
  });

  it("shows calm empty state when runtime has 0 skills", () => {
    mocks.items = [];
    const html = renderToStaticMarkup(createElement(SkillsList));
    expect(html).toContain("No superpowers yet");
    expect(html).toContain("Create skill");
    expect(html).not.toContain('data-testid="skill-card"');
    expect(html).not.toContain("Couldn&#x27;t load");
  });

  it("shows loading skeletons while fetching", () => {
    mocks.isLoading = true;
    const html = renderToStaticMarkup(createElement(SkillsList));
    // skeletons render as divs with class skeleton; check no empty or error and no skill cards
    expect(html).not.toContain("No superpowers yet");
    expect(html).not.toContain('data-testid="skill-card"');
    expect(html).not.toContain('role="alert"');
  });

  it("shows error state with retry", () => {
    mocks.error = new Error("offline");
    const html = renderToStaticMarkup(createElement(SkillsList));
    expect(html).toContain('role="alert"');
    expect(html).toContain("offline");
    expect(html).toContain("Retry");
    expect(html).not.toContain('data-testid="skill-card"');
  });

  it("renders compact readable skill cards with name, description and primary actions", () => {
    mocks.items = [builtinSkill, customSkill, projectSkill];
    const html = renderToStaticMarkup(createElement(SkillsList));
    expect(html).toContain("/summarize");
    expect(html).toContain("Summarize any text");
    expect(html).toContain("/my-helper");
    expect(html).toContain("/project-tool");
    expect(html).toContain('data-testid="skill-card"');
    expect(html).toContain('data-item-name="summarize"');
    // primary action Use and secondary Open on every card
    expect(html).toContain(">Use<");
    expect(html).toContain(">Open<");
    // where it comes from, in the user's terms
    expect(html).toContain('data-testid="skill-card-kind-builtin"');
    expect(html).toContain('data-testid="skill-card-kind-custom"');
    expect(html).toContain('data-testid="skill-card-kind-project"');
    expect(html).toContain('data-testid="superpowers-filter-project"');
    // display name and emoji from the skill's metadata
    expect(html).toContain(">Summarize<");
    expect(html).toContain("📝");
    // never the raw source folders
    expect(html).not.toContain(".agents");
  });

  it("offers an editable copy only for read-only skills", () => {
    mocks.items = [builtinSkill];
    const builtinOnly = renderToStaticMarkup(createElement(SkillsList));
    expect(builtinOnly).toContain('aria-label="Duplicate summarize"');
    mocks.items = [customSkill];
    const customOnly = renderToStaticMarkup(createElement(SkillsList));
    expect(customOnly).not.toContain("Duplicate");
  });

  it("disables Use when deliverable is false", () => {
    mocks.items = [disabledSkill];
    const html = renderToStaticMarkup(createElement(SkillsList));
    expect(html).toContain("/archived-skill");
    // disabled Use button should be present but disabled
    expect(html).toContain("disabled");
    // still has Open
    expect(html).toContain(">Open<");
  });

  it("has searchable compact input with placeholder", () => {
    const html = renderToStaticMarkup(createElement(SkillsList));
    expect(html).toContain("Search by name or description");
    expect(html).toContain('aria-label="Search superpowers"');
  });

  it("uses single unified grid without redundant count bars", () => {
    mocks.items = [builtinSkill, customSkill, projectSkill];
    const html = renderToStaticMarkup(createElement(SkillsList));
    expect(html).toContain('data-testid="superpowers-grid"');
    // old segmented headers with counts like My Skills (2) and duplicate section counts are gone
    expect(html).not.toContain("My Skills");
    expect(html).not.toContain("(2)");
  });

  it("keeps browse filters as accessible pressed buttons", () => {
    const html = renderToStaticMarkup(createElement(SkillsList));
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('aria-selected');
  });

  it("gives card Open link an accessible name per skill", () => {
    mocks.items = [builtinSkill];
    const html = renderToStaticMarkup(createElement(SkillsList));
    expect(html).toContain('aria-label="Open summarize"');
  });
});
