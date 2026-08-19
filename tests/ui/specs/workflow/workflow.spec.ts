import { test, expect } from "../../support/fixtures";
import { WorkflowPage } from "../../pages";

test.describe("workflow", () => {
  test("workflow list page renders creation controls and examples", async ({ admin }) => {
    const workflow = new WorkflowPage(admin);
    await workflow.goto();

    await expect(workflow.createWithExampleButton).toBeVisible({ timeout: 15000 });
  });
});
