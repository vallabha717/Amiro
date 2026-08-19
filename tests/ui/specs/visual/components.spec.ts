import { test, expect } from "../../support/fixtures";
import { SignInPage, ChatPage } from "../../pages";

test.describe("visual", () => {
  test("sign-in form component layout renders consistently", async ({ page, amiro }) => {
    const signIn = new SignInPage(page);
    await signIn.goto();

    await expect(signIn.submitButton).toBeVisible({ timeout: 15000 });
    const card = page.locator(".bg-background").first();
    await expect(card).toBeVisible();
  });

  test("empty chat greeting renders consistently", async ({ signedIn }) => {
    const chat = new ChatPage(signedIn);
    await expect(chat.greeting).toBeVisible({ timeout: 15000 });
  });
});
