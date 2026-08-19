import { test, expect } from "../../support/fixtures";
import { AdminPage } from "../../pages";

test.describe("admin", () => {
  test("admin user can access admin dashboard tabs", async ({ admin }) => {
    const adminPage = new AdminPage(admin);

    await adminPage.goto("providers");
    await expect(admin.locator("h1, [data-slot='card']").first()).toBeVisible({ timeout: 15000 });

    await adminPage.goto("search");
    await expect(admin.locator("h1, [data-slot='card']").first()).toBeVisible({ timeout: 15000 });
  });

  test("regular non-admin user is blocked from admin views", async ({ signedIn }) => {
    await signedIn.goto("/admin/providers");
    // Should redirect away from /admin or show restricted view
    await signedIn.waitForURL((url) => !url.pathname.startsWith("/admin/providers") || url.pathname === "/", { timeout: 15000 });
  });
});
