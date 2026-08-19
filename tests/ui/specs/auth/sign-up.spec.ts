import { test, expect } from "../../support/fixtures";
import { SignUpPage } from "../../pages";

// The (auth)/sign-up route group had no spec touching it at all before this
// -- auth.spec.ts only exercises sign-in -- which is exactly the gap
// Criterion 9 exists to catch. See docs/testing/progress/phase-05-ui-playwright.md's
// route-group table.
test.describe("auth - sign-up", () => {
  test("sign up with a new account completes registration and leaves /sign-up", async ({ amiro, page }) => {
    const signUp = new SignUpPage(page);
    await signUp.goto();

    const email = `signup-${amiro.testId}@amiro.test`;
    // 8-20 characters, at least one letter, at least one number.
    await signUp.signUp(email, "New Amiro User", "Signup1Test");

    await page.waitForURL((url) => !url.pathname.includes("/sign-up"), { timeout: 15000 });
    expect(page.url()).not.toContain("/sign-up");
  });
});
