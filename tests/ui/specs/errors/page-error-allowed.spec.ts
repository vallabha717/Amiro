import { test, expect } from "../../support/fixtures";
import * as fs from "node:fs";
import * as path from "node:path";

// This is the annotation escape hatch: a page error CAN be allowed and
// still logged, for the rare test that deliberately provokes one and wants
// to assert on the log rather than fail. It does not exercise the default
// behavior -- that a page error fails the test -- which is
// page-error-fails.spec.ts.
test.describe("errors - allow-page-errors escape hatch", () => {
  test("allow-page-errors annotation logs an uncaught error to pageerrors.ndjson without failing the test", async ({ page, amiro }, testInfo) => {
    // Annotate to allow the deliberate error in this test
    testInfo.annotations.push({ type: "allow-page-errors" });

    await page.goto("/sign-in");

    // Trigger an uncaught exception in the browser page context
    await page.evaluate(() => {
      queueMicrotask(() => {
        throw new Error("Deliberate unhandled browser runtime error for Criterion 7 verification");
      });
    });

    const pageErrorsPath = path.join(amiro.runDir, "ui", amiro.testId, "pageerrors.ndjson");

    // Poll until the fixture captures and writes the pageerror to disk
    await expect.poll(() => {
      if (!fs.existsSync(pageErrorsPath)) return "";
      return fs.readFileSync(pageErrorsPath, "utf-8");
    }, { timeout: 10000 }).toContain("Deliberate unhandled browser runtime error");
  });
});
