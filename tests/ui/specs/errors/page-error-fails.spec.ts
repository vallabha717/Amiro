import { test, expect } from "../../support/fixtures";
import * as fs from "node:fs";
import * as path from "node:path";

// Criterion 7 is "uncaught page errors fail their test", and the only way
// to prove that is a test that does NOT use the allow-page-errors escape
// hatch, deliberately provokes a page error, and is expected to fail. It
// stays out of the default suite by design -- a deliberately-failing test
// in `amirotest run --surface ui` would break Criterion 1's "passes" -- so
// it is skipped unless AMIRO_RUN_EXPECTED_FAIL_SPECS=1 is set, which is how
// it must be invoked for verification:
//
//   cd tests && AMIRO_RUN_EXPECTED_FAIL_SPECS=1 \
//     pnpm exec playwright test ui/specs/errors/page-error-fails.spec.ts
//
// That command is expected to exit non-zero. The failure itself comes from
// the `page` fixture's teardown in fixtures.ts (it throws when
// uncaughtErrors.length > 0 and no allow-page-errors annotation is
// present) -- not from an assertion in this test body -- which is what
// proves the failure is the product's own mechanism and not a test-author
// convention.
test.describe("errors - expected-fail probe", () => {
  test("uncaught page error fails the test (expected-fail probe; run in isolation, not part of the default suite)", async ({ page, amiro }) => {
    test.skip(
      !process.env.AMIRO_RUN_EXPECTED_FAIL_SPECS,
      "deliberately-failing probe for Criterion 7 -- run with AMIRO_RUN_EXPECTED_FAIL_SPECS=1 in isolation, see file comment"
    );

    await page.goto("/sign-in");

    // Trigger an uncaught exception in the browser page context. No
    // allow-page-errors annotation here -- that is the entire point.
    await page.evaluate(() => {
      queueMicrotask(() => {
        throw new Error("Deliberate unhandled browser runtime error for Criterion 7 verification (expected to fail the test)");
      });
    });

    const pageErrorsPath = path.join(amiro.runDir, "ui", amiro.testId, "pageerrors.ndjson");

    // Wait for the fixture to have observed and logged the error before
    // the test ends, so the fixture's teardown check sees it and throws.
    await expect.poll(() => {
      if (!fs.existsSync(pageErrorsPath)) return "";
      return fs.readFileSync(pageErrorsPath, "utf-8");
    }, { timeout: 10000 }).toContain("Deliberate unhandled browser runtime error");
  });
});
