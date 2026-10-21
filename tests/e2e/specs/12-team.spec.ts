/**
 * Journey 12 — Team. After onboarding the owner lands on Team, a full-page
 * app: every agent in a list, and clicking one opens its fixed Team thread
 * beside it. "Open <name>" goes to that agent's own space — the full Amiro
 * app acting as that agent (its chats, identity, models, connectors, keys and
 * schedules), with the agent's id in every URL of its space. A second agent
 * is created in Team, configured in its space — keys, connectors (remote
 * only), schedules — none of which Amiro sees, and it is deleted.
 */
import { assistantMessages, ask, selectModel, send, waitForReply } from "../support/chat";
import { DEFAULT_AGENT_NAME } from "../support/config";
import { expect, test } from "../support/fixtures";
import { openTurn, replyOf } from "../support/setup-chat";

interface TeamAgent {
  id: string;
  name: string;
  isMain: boolean;
  channelThreadId: string;
  workspaceDir: string;
}

const SCOUT = "Scout";

test.describe.serial("team", () => {
  test("team: the onboarded agent is listed and opens its fixed Team thread", async ({ page, step }) => {
    const agent = { name: DEFAULT_AGENT_NAME };
    await step("Open Team → a full page of its own listing the onboarded agent", async () => {
      await page.goto("/team");
      await expect(page.getByTestId("team-heading")).toHaveText("Team");
      await expect(page.getByTestId("team-window")).toBeVisible();
      await expect(page.getByTestId("sidebar-team-link")).toHaveCount(0);
      await expect(page.getByTestId("team-agent-main")).toContainText(agent.name);
      await expect(page.getByTestId("team-pick-agent")).toBeVisible();
    });

    await step("Click the agent → its fixed Team thread opens beside the list", async () => {
      await page.getByTestId("team-agent-main").click();
      await expect(page).toHaveURL(/\/team\?agent=main$/);
      await expect(page.getByTestId("team-channel-title")).toHaveText(agent.name);
      await expect(page.getByTestId("team-channel")).toBeVisible();
    });

    await step("Ask in the Team thread → the answer streams in", async () => {
      await selectModel(page);
      const reply = await ask(page, "Reply with exactly the word TEAMCHECK and nothing else.");
      expect.soft(reply, "the reply should echo the word").toMatch(/TEAMCHECK/);
    });

    await step("Reload → the Team thread still holds the conversation", async () => {
      await page.reload();
      await expect(page.getByTestId("team-channel-title")).toHaveText(agent.name);
      await expect(assistantMessages(page).first()).toBeVisible({ timeout: 30000 });
    });

    await step(`Open ${agent.name} → the agent's main space: Amiro as it always was`, async () => {
      await expect(page.getByTestId("team-open-in-amiro")).toContainText(`Open ${agent.name}`);
      await page.getByTestId("team-open-in-amiro").click();
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByTestId("sidebar-team-link")).toBeVisible();
      await expect(page.getByTestId("agent-scope-banner")).toHaveCount(0);
    });
  });

  test("team: create an agent in Team through the setup chat and chat in its Team thread", async ({ page, step, amiro }) => {
    await step("New agent → the same setup chat as onboarding, in team mode", async () => {
      await page.goto("/team");
      await page.getByTestId("team-new-agent").click();
      await expect(page).toHaveURL(/\/team\/new/);
      await expect(page.getByTestId("setup-chat")).toHaveAttribute("data-mode", "team");
      await expect(page.getByTestId("setup-story-title")).toHaveText("Let's bring your agent to life");
      await (await openTurn(page, "greet")).getByTestId("setup-start").click();
    });

    await step("Name Scout, give it a role, instructions and a look → Create agent", async () => {
      const turn = await openTurn(page, "look");
      await turn.getByTestId("setup-agent-name").fill(SCOUT);
      await turn.getByTestId("setup-agent-role").fill("Research assistant");
      await turn
        .getByTestId("setup-agent-instructions")
        .fill("When asked your name, answer only with your name.");
      await turn.getByTestId("team-shape-star").click();
      await turn.getByTestId("team-colour-cobalt").click();
      await expect(turn.getByTestId("setup-brain-copy")).toBeChecked();
      await turn.getByTestId("setup-look-continue").click();
      await expect(replyOf(page, "look")).toContainText(SCOUT);
      await expect(page.getByTestId("setup-agent-title")).toHaveText(SCOUT);
    });

    const { body: created } = await amiro.api<{ agents: TeamAgent[] }>("/api/agents");
    const scoutId = created.agents.find((a) => a.name === SCOUT)!.id;
    const asScout = { "X-Amiro-Agent": scoutId };

    await step("Scout's default prompt is its own: its name and its instructions", async () => {
      const turn = await openTurn(page, "prompt");
      await expect(turn.getByTestId("setup-prompt-text")).toContainText(`**Name:** ${SCOUT}`);
      await expect(turn.getByTestId("setup-prompt-text")).toContainText("answer only with your name");
      await turn.getByTestId("setup-prompt-continue").click();
    });

    await step("Personality: Sharp Operator → saved for Scout only", async () => {
      const turn = await openTurn(page, "personality");
      await turn.getByTestId("setup-preset-operator").click();
      await turn.getByTestId("setup-personality-save").click();
      await expect(replyOf(page, "personality")).toHaveText("Sharp Operator");
      const scout = await amiro.api<{ sliders: Record<string, number> }>("/api/agent/identity", { headers: asScout });
      expect(scout.body.sliders.companionCoworker).toBe(82);
      const main = await amiro.api<{ sliders: Record<string, number> }>("/api/agent/identity");
      expect(main.body.sliders.companionCoworker).not.toBe(82);
    });

    await step(`Provider: Scout's brain was copied from Amiro → keep ${amiro.cfg.provider.label}`, async () => {
      const turn = await openTurn(page, "provider");
      await expect(turn.getByTestId(`setup-provider-${amiro.cfg.provider.id}`)).toContainText("Connected");
      await turn.getByTestId("setup-provider-keep").click();
      await expect(replyOf(page, "provider")).toHaveText(amiro.cfg.provider.label);
    });

    await step("Web search: Bing for Scout; Amiro keeps DuckDuckGo", async () => {
      const turn = await openTurn(page, "search");
      await turn.getByTestId("setup-search-bing").click();
      await expect(replyOf(page, "search")).toHaveText("Bing Search");
      const scout = await amiro.api<Array<{ provider: string; isActive: boolean }>>("/api/search/providers", {
        headers: asScout,
      });
      expect(scout.body.find((p) => p.isActive)?.provider).toBe("bing");
      const main = await amiro.api<Array<{ provider: string; isActive: boolean }>>("/api/search/providers");
      expect(main.body.find((p) => p.isActive)?.provider).toBe("duckduckgo");
    });

    await step("Connectors: a team agent gets remote MCP servers only, no Composio", async () => {
      const turn = await openTurn(page, "connectors");
      await expect(turn.getByTestId("setup-composio-key")).toHaveCount(0);
      await expect(turn).toContainText("Remote MCP servers");
      await turn.getByTestId("setup-skip").click();
    });

    await step("Voice is shared by the team: pick the browser's own voice (no key)", async () => {
      const turn = await openTurn(page, "voice");
      await expect(turn.locator("[data-streaming]").first()).toHaveAttribute("aria-label", /shared by everyone/);
      await turn.getByTestId("setup-voice-browser-native").click();
      await expect(replyOf(page, "voice")).toContainText("Browser");
    });

    await step("Listening: the browser's own speech recognition (no key); live voice still needs ElevenLabs", async () => {
      const turn = await openTurn(page, "listen");
      await expect(turn.getByTestId("setup-live-voice")).toHaveAttribute("data-state", "needs-elevenlabs");
      await turn.getByTestId("setup-listen-browser-native").click();
      await expect(replyOf(page, "listen")).toContainText("Browser");
      const voice = await amiro.api<{ settings: { ttsProvider: string; sttProvider: string } }>("/api/voice/settings");
      expect(voice.body.settings.ttsProvider).toBe("browser-native");
      expect(voice.body.settings.sttProvider).toBe("browser-native");
    });

    await step("Summary → Open Scout's thread → Scout's Team thread opens", async () => {
      const turn = await openTurn(page, "done");
      await expect(turn.getByTestId("setup-summary-connectors")).toHaveAttribute("data-state", "later");
      await expect(turn.getByTestId("setup-summary-search")).toHaveAttribute("data-state", "done");
      await turn.getByTestId("setup-finish").click();
      await expect(page).toHaveURL(/\/team\?agent=[a-f0-9]{32}$/);
      await expect(page.getByTestId("team-channel-title")).toHaveText(SCOUT);
    });

    await step("The composer shows Scout's workspace instead of a folder picker", async () => {
      await expect(page.getByTestId("composer-agent-folder")).toHaveText(`${SCOUT}'s workspace`);
    });

    const { body } = await amiro.api<{ agents: TeamAgent[] }>("/api/agents");
    const main = body.agents.find((a) => a.isMain)!;
    const scout = body.agents.find((a) => a.name === SCOUT)!;

    await step("Scout has its own folder, outside the main agent's workspace", async () => {
      expect(scout.workspaceDir).not.toBe(main.workspaceDir);
      expect(scout.workspaceDir.startsWith(main.workspaceDir)).toBe(false);
    });

    await step("Ask Scout its name → it answers as Scout (its own persona)", async () => {
      await selectModel(page);
      const reply = await ask(page, "What is your name?");
      expect.soft(reply, "Scout should answer with its own name").toMatch(/Scout/i);
    });

    await step("Amiro's chat list does not show Scout's Team thread, and it cannot be deleted", async () => {
      const threads = await amiro.api<Array<{ id: string }>>("/api/thread");
      expect(threads.body.map((t) => t.id)).not.toContain(scout.channelThreadId);
      const res = await amiro.api(`/api/thread/${scout.channelThreadId}`, { method: "DELETE" });
      expect(res.status).toBe(409);
    });
  });

  test("team: Open Scout opens Scout's own space, configured on the usual pages", async ({ page, step, amiro }) => {
    const { body } = await amiro.api<{ agents: TeamAgent[] }>("/api/agents");
    const scout = body.agents.find((a) => a.name === SCOUT)!;
    const asScout = { "X-Amiro-Agent": scout.id };
    const services = (list: { items: Array<{ service: string }> }) => list.items.map((i) => i.service);

    await step("Scout's Team thread → Open Scout → Amiro, in Scout's space", async () => {
      await page.goto(`/team?agent=${scout.id}`);
      await page.getByTestId("team-open-in-amiro").click();
      await expect(page).toHaveURL(new RegExp(`/\\?agent=${scout.id}`));
      await expect(page.getByTestId("agent-scope-banner")).toContainText(`${SCOUT}'s space`);
    });

    await step("A new chat here is a chat with Scout", async () => {
      await selectModel(page);
      const before = await assistantMessages(page).count();
      await send(page, "In one word: what is your name?");
      const reply = await waitForReply(page, { before });
      expect.soft(reply, "the reply comes from Scout").toMatch(/Scout/i);
      const threads = await amiro.api<{ threads: Array<{ id: string; channel: boolean }> }>(
        `/api/agents/${scout.id}/threads`,
      );
      expect(threads.body.threads.filter((t) => !t.channel).length).toBeGreaterThan(0);
    });

    await step("Scout's Personality page shows Scout, not Amiro's agent", async () => {
      const identity = await amiro.api<{ name: string }>("/api/agent/identity", { headers: asScout });
      expect(identity.body.name).toBe(SCOUT);
      await page.goto("/agent/personality");
      await expect(page.getByTestId("agent-scope-banner")).toBeVisible();
      await expect(page.locator("main").getByText(SCOUT).first()).toBeVisible();
    });

    await step("A key saved in Scout's space is Scout's only — Amiro does not see it", async () => {
      const saved = await amiro.api("/api/credentials", {
        method: "PUT",
        headers: asScout,
        body: JSON.stringify({ service: "scout-e2e", field: "token", value: "scout-e2e-secret" }),
      });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      const mainKeys = await amiro.api<{ items: Array<{ service: string }> }>("/api/credentials");
      expect(services(mainKeys.body)).not.toContain("scout-e2e");
      await page.goto("/admin/credentials");
      await expect(page.getByTestId("agent-scope-banner")).toBeVisible();
      await expect(page.locator("main").getByText("scout-e2e").first()).toBeVisible();
    });

    await step("Switch to Amiro → the banner goes and Scout's key is not in Amiro's keys", async () => {
      await page.getByTestId("agent-scope-clear").click();
      await expect(page.getByTestId("agent-scope-banner")).toHaveCount(0);
      await page.goto("/admin/credentials");
      await expect(page.locator("main").getByText("scout-e2e")).toHaveCount(0);
    });
  });


  test("team: Scout's space has its own connectors and schedules, with Scout's id in every URL", async ({ page, step, amiro }) => {
    const { body } = await amiro.api<{ agents: TeamAgent[] }>("/api/agents");
    const scout = body.agents.find((a) => a.name === SCOUT)!;
    const asScout = { "X-Amiro-Agent": scout.id };
    const inScoutsUrl = new RegExp(`[?&]agent=${scout.id}(&|$)`);
    await fetch(`${amiro.mcpBase}/__reset`);

    await step("Open Scout's space from Team → the URL names Scout", async () => {
      await page.goto(`/team?agent=${scout.id}`);
      await page.getByTestId("team-open-in-amiro").click();
      await expect(page).toHaveURL(inScoutsUrl);
      await expect(page.getByTestId("agent-scope-banner")).toContainText(`${SCOUT}'s space`);
    });

    await step("Sidebar → Connectors → still Scout's space, and the URL still names Scout", async () => {
      await page.getByTestId("sidebar-connectors-link").click();
      await expect(page).toHaveURL(/\/connectors/);
      await expect(page).toHaveURL(inScoutsUrl);
      await expect(page.getByTestId("agent-scope-banner")).toBeVisible();
      await expect(page.getByText("Nothing connected yet")).toBeVisible();
    });

    await step("Add custom → a remote MCP connector for Scout (scout-tools)", async () => {
      await page.getByRole("button", { name: "Add custom" }).click();
      const d = page.getByRole("dialog", { name: "Add a custom connector" });
      await expect(d).toBeVisible();
      await d.getByLabel("Name").fill("scout-tools");
      await d.getByLabel("Server URL").fill(`${amiro.mcpBase}/open/mcp`);
      await d.getByRole("button", { name: "None" }).click();
      await d.getByRole("button", { name: "Connect" }).click();
      await expect(d).toBeHidden({ timeout: 30000 });
      await expect(page.locator("main").getByText("scout-tools", { exact: true }).first()).toBeVisible();
    });

    await step("scout-tools is Scout's connector only — Amiro's connectors do not have it", async () => {
      const scouts = await amiro.api("/api/connectors", { headers: asScout });
      const mains = await amiro.api("/api/connectors");
      expect(JSON.stringify(scouts.body)).toContain("scout-tools");
      expect(JSON.stringify(mains.body)).not.toContain("scout-tools");
    });

    await step("A local command (stdio) connector is refused for Scout", async () => {
      const res = await amiro.api<{ error?: string }>("/api/connectors/custom", {
        method: "POST",
        headers: asScout,
        body: JSON.stringify({ name: "scout-local", transport: "stdio", command: "npx", args: ["-y", "anything"] }),
      });
      expect(res.status).toBe(400);
      expect(res.body.error ?? "").toContain("remote (URL) connectors");
    });

    await step("Scout uses its own connector: echo through scout-tools reaches the server", async () => {
      await page.goto(`/team?agent=${scout.id}`);
      await expect(page.getByTestId("team-channel-title")).toHaveText(SCOUT);
      await selectModel(page);
      const reply = await ask(
        page,
        "Use the scout-tools connector's echo tool with message 'hello-from-scout' and tell me exactly what it returned.",
      );
      const log = (await (await fetch(`${amiro.mcpBase}/__calls`)).json()) as Array<{ name: string; args: Record<string, unknown> }>;
      expect.soft(
        log.some((c) => c.name === "echo" && JSON.stringify(c.args).includes("hello-from-scout")),
        "the fixture logged Scout's echo call",
      ).toBe(true);
      expect.soft(reply, "the reply quotes the tool result").toMatch(/hello-from-scout/);
    });

    await step("Scout's space → Schedules → New schedule → it is listed for Scout", async () => {
      await page.goto(`/?agent=${scout.id}`);
      await page.getByTestId("sidebar-schedules-link").click();
      await expect(page).toHaveURL(/\/schedules/);
      await expect(page).toHaveURL(inScoutsUrl);
      await page.getByRole("button", { name: "New schedule" }).first().click();
      const d = page.getByRole("dialog");
      await expect(d).toBeVisible();
      await d.getByRole("textbox").nth(0).fill("Scout weekly digest");
      await d.getByRole("textbox").nth(1).fill("Summarise new sources from this week in 3 bullets.");
      await d.getByRole("button", { name: /create|save|add/i }).last().click();
      await expect(d).toBeHidden();
      await expect(page.getByText("Scout weekly digest").first()).toBeVisible();
    });

    await step("Switch to Amiro → Amiro's Connectors and Schedules show none of Scout's", async () => {
      await page.getByTestId("agent-scope-clear").click();
      await expect(page.getByTestId("agent-scope-banner")).toHaveCount(0);
      await expect(page).not.toHaveURL(/agent=/);
      await page.goto("/connectors");
      await expect(page.locator("main").getByText("scout-tools", { exact: true })).toHaveCount(0);
      await page.goto("/schedules");
      await expect(page.getByRole("heading", { name: "Schedules", level: 1 })).toBeVisible();
      await expect(page.getByText("Scout weekly digest")).toHaveCount(0);
    });
  });

  test("team: delete the second agent", async ({ page, step, amiro }) => {
    await step("Scout's Team thread → Delete → confirm → Team without Scout", async () => {
      const { body } = await amiro.api<{ agents: TeamAgent[] }>("/api/agents");
      const scout = body.agents.find((a) => a.name === SCOUT)!;
      await page.goto(`/team?agent=${scout.id}`);
      await page.getByTestId("agent-delete").click();
      await page.getByTestId("agent-delete-confirm").click();
      await expect(page).toHaveURL(/\/team$/);
      await expect(page.getByTestId(`team-agent-${scout.id}`)).toHaveCount(0);
    });
  });
});
