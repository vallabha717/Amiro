/**
 * Journey 12 — Team: the onboarded agent's channel, a second agent made with
 * the New agent wizard (own folder, own persona, own channel), its page with
 * the pinned channel, profile and workspace, and removing it again.
 */
import { assistantMessages, ask, selectModel } from "../support/chat";
import { expect, test } from "../support/fixtures";

interface TeamAgent {
  id: string;
  name: string;
  isMain: boolean;
  channelThreadId: string;
  workspaceDir: string;
}

const SCOUT = "Scout";

test.describe.serial("team", () => {
  test("team: the onboarded agent's channel streams a reply and keeps it", async ({ page, step, amiro }) => {
    const { agent } = amiro.cfg;
    await step("Open Team → the main agent is listed and its channel is open", async () => {
      await page.goto("/team");
      await expect(page.getByTestId("team-heading")).toHaveText("Team");
      await expect(page.getByTestId("team-agent-main")).toContainText(agent.name);
      await expect(page.getByTestId("team-channel-title")).toHaveText(agent.name);
    });

    await step("Ask in the channel → the answer streams in", async () => {
      await selectModel(page);
      const reply = await ask(page, "Reply with exactly the word TEAMCHECK and nothing else.");
      expect.soft(reply, "the reply should echo the word").toMatch(/TEAMCHECK/);
    });

    await step("Reload → the channel still holds the conversation", async () => {
      await page.reload();
      await expect(page.getByTestId("team-channel-title")).toHaveText(agent.name);
      await expect(assistantMessages(page).first()).toBeVisible({ timeout: 30000 });
    });
  });

  test("team: create a second agent with the wizard and chat in its channel", async ({ page, step, amiro }) => {
    await step("New agent → name it Scout and pick a look", async () => {
      await page.goto("/team");
      await page.getByTestId("team-new-agent").click();
      await expect(page).toHaveURL(/\/team\/new/);
      await page.getByTestId("team-agent-name").fill(SCOUT);
      await page.getByTestId("team-shape-star").click();
      await page.getByTestId("team-colour-cobalt").click();
      await page.getByTestId("team-wizard-next").click();
    });

    await step("Give it a role and instructions → Create → Scout's channel opens", async () => {
      await page.getByTestId("team-agent-role").fill("Research assistant");
      await page
        .getByTestId("team-agent-instructions")
        .fill("When asked your name, answer only with your name.");
      await page.getByTestId("team-wizard-create").click();
      await expect(page).toHaveURL(/\/team\?agent=[a-f0-9]{32}/);
      await expect(page.getByTestId("team-channel-title")).toHaveText(SCOUT);
    });

    await step("The composer shows Scout's own folder instead of a folder picker", async () => {
      await expect(page.getByTestId("composer-agent-folder")).toHaveText(`${SCOUT}'s own folder`);
    });

    const { body } = await amiro.api<{ agents: TeamAgent[] }>("/api/agents");
    const main = body.agents.find((a) => a.isMain)!;
    const scout = body.agents.find((a) => a.name === SCOUT)!;

    await step("Scout has its own folder, outside the main agent's workspace", async () => {
      expect(scout.workspaceDir).not.toBe(main.workspaceDir);
      expect(scout.workspaceDir.startsWith(main.workspaceDir)).toBe(false);
      expect(scout.channelThreadId).not.toBe(main.channelThreadId);
    });

    await step("Ask Scout its name → it answers as Scout (its own persona)", async () => {
      await selectModel(page);
      const reply = await ask(page, "What is your name?");
      expect.soft(reply, "Scout should answer with its own name").toMatch(/Scout/i);
    });

    await step("The main sidebar does not list Scout's channel", async () => {
      const threads = await amiro.api<Array<{ id: string }>>("/api/thread");
      expect(threads.body.map((t) => t.id)).not.toContain(scout.channelThreadId);
    });

    await step("Scout's channel cannot be deleted", async () => {
      const res = await amiro.api(`/api/thread/${scout.channelThreadId}`, { method: "DELETE" });
      expect(res.status).toBe(409);
    });
  });

  test("team: the agent page pins the channel and shows profile and workspace", async ({ page, step }) => {
    await step("Open Scout → Open agent → its page", async () => {
      await page.goto("/team");
      await page.getByTestId("team-agent-main").waitFor();
      await page.getByRole("link", { name: new RegExp(SCOUT) }).first().click();
      await expect(page.getByTestId("team-channel-title")).toHaveText(SCOUT);
      await page.getByTestId("team-open-agent").click();
      await expect(page.getByTestId("agent-page-name")).toHaveText(SCOUT);
    });

    await step("Chats → the channel is pinned at the top", async () => {
      const first = page.getByTestId("agent-thread-list").getByRole("link").first();
      await expect(first).toHaveAttribute("data-testid", "agent-channel-link");
      await expect(first).toContainText("Pinned");
    });

    await step("Workspace → its own folder with IDENTITY.md and the isolation note", async () => {
      await page.getByTestId("agent-tab-workspace").click();
      await expect(page.getByTestId("agent-file-list")).toContainText("IDENTITY.md");
      await expect(page.getByText(/not a security boundary/)).toBeVisible();
    });

    await step("Profile → change the role → Save", async () => {
      await page.getByTestId("agent-tab-profile").click();
      await page.getByTestId("agent-profile-role").fill("Research and writing");
      await page.getByTestId("agent-profile-save").click();
      await expect(page.getByText("Saved", { exact: true })).toBeVisible();
      await expect(page.locator("header").getByText("Research and writing")).toBeVisible();
    });

    await step("Open channel → back to Scout's channel in Team", async () => {
      await page.getByTestId("agent-open-channel").click();
      await expect(page).toHaveURL(/\/team\?agent=/);
      await expect(page.getByTestId("team-channel-title")).toHaveText(SCOUT);
    });
  });

  test("team: delete the second agent", async ({ page, step, amiro }) => {
    await step("Open Scout's page → Delete → confirm → back to Team without Scout", async () => {
      const { body } = await amiro.api<{ agents: TeamAgent[] }>("/api/agents");
      const scout = body.agents.find((a) => a.name === SCOUT)!;
      await page.goto(`/team/agent?id=${scout.id}`);
      await page.getByTestId("agent-delete").click();
      await page.getByTestId("agent-delete-confirm").click();
      await expect(page).toHaveURL(/\/team$/);
      await expect(page.getByTestId(`team-agent-${scout.id}`)).toHaveCount(0);
    });
  });
});
