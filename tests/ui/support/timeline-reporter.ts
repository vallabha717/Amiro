import * as fs from "node:fs";
import * as path from "node:path";
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestError,
  TestResult,
  TestStep,
} from "@playwright/test/reporter";

interface TimelineReporterOptions {
  runDir?: string;
}

// slug mirrors tests/harness/run/summary.go's Slug(): keep
// [a-zA-Z0-9_-], replace everything else with '-', collapse repeats, trim.
// The two must agree because both are candidate directory names for the
// same test's artifacts.
function slug(address: string): string {
  const replaced = address.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-");
  return replaced.replace(/^-+|-+$/g, "");
}

export default class TimelineReporter implements Reporter {
  private runDir: string;
  private eventsPath: string;
  private resultsPath: string;
  private secrets: string[] = [];

  constructor(options?: TimelineReporterOptions) {
    this.runDir = options?.runDir || process.env.AMIRO_TEST_RUN_DIR || "";
    this.eventsPath = this.runDir ? path.join(this.runDir, "events.ndjson") : "";
    this.resultsPath = this.runDir ? path.join(this.runDir, "results.ndjson") : "";
    this.loadSecrets();
  }

  private loadSecrets() {
    if (!this.runDir) return;
    const manifestPath = path.join(this.runDir, "run.json");
    if (fs.existsSync(manifestPath)) {
      try {
        const raw = fs.readFileSync(manifestPath, "utf-8");
        const data = JSON.parse(raw);
        const accs = data.config?.accounts;
        if (accs) {
          for (const acc of Object.values(accs) as any[]) {
            if (acc.password) this.secrets.push(acc.password);
          }
        }
      } catch {
        // ignore
      }
    }
  }

  private redact(str: string): string {
    let out = str;
    for (const s of this.secrets) {
      if (s && s.length > 0) {
        out = out.split(s).join("[REDACTED]");
      }
    }
    return out;
  }

  private emit(event: {
    surface: string;
    test?: string;
    kind: string;
    msg: string;
    detail?: Record<string, any>;
  }) {
    if (!this.eventsPath) return;

    const entry = {
      surface: "ui",
      test: event.test,
      ts: new Date().toISOString(),
      kind: event.kind,
      msg: event.msg,
      detail: event.detail || {},
    };

    const line = this.redact(JSON.stringify(entry)) + "\n";
    try {
      fs.appendFileSync(this.eventsPath, line, "utf-8");
    } catch {
      // ignore write errors
    }
  }

  private testAddress(test: TestCase): string {
    // Derive feature from spec file path relative to ui/specs/
    const feature = path.basename(path.dirname(test.location.file));
    return `ui/${feature}/${test.title}`;
  }

  onBegin(_config: FullConfig, suite: Suite): void {
    if (!this.runDir && process.env.AMIRO_TEST_RUN_DIR) {
      this.runDir = process.env.AMIRO_TEST_RUN_DIR;
      this.eventsPath = path.join(this.runDir, "events.ndjson");
      this.resultsPath = path.join(this.runDir, "results.ndjson");
      this.loadSecrets();
    }
    this.emit({
      surface: "ui",
      kind: "run",
      msg: "suite started",
      detail: { total: suite.allTests().length },
    });
  }

  onTestBegin(test: TestCase, result: TestResult): void {
    this.emit({
      surface: "ui",
      test: this.testAddress(test),
      kind: "test",
      msg: "started",
      detail: {
        file: path.basename(test.location.file),
        line: test.location.line,
        retry: result.retry,
      },
    });
  }

  onStepBegin(test: TestCase, _result: TestResult, step: TestStep): void {
    if (step.category === "test.step" || step.category === "pw:api" || step.title.startsWith("page.")) {
      this.emit({
        surface: "ui",
        test: this.testAddress(test),
        kind: "action",
        msg: step.title,
        detail: { category: step.category },
      });
    }
  }

  onStepEnd(test: TestCase, _result: TestResult, step: TestStep): void {
    if (step.error) {
      this.emit({
        surface: "ui",
        test: this.testAddress(test),
        kind: "error",
        msg: `step failed: ${step.title}`,
        detail: { error: step.error.message },
      });
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const status = result.status === "passed" ? "passed" : result.status === "skipped" ? "skipped" : "failed";
    const detail: Record<string, any> = {
      durationMs: result.duration,
      status: result.status,
    };
    if (result.errors && result.errors.length > 0) {
      detail.errors = result.errors.map((e: TestError) => e.message);
    }
    this.emit({
      surface: "ui",
      test: this.testAddress(test),
      kind: "test",
      msg: status,
      detail,
    });
    this.recordResult(test, result, status);
  }

  // recordResult appends one line to results.ndjson in the exact shape
  // tests/harness/run/summary.go's TestResult decodes -- address, id,
  // surface, feature, name, status, durationMs, attempt, reason, artifacts.
  // Go's LoadResults() merges this file with whatever `go test` shards
  // wrote to the same path, which is what lets `amirotest run --surface
  // ui` render a real per-surface row instead of "0 passed" while
  // Playwright's own reporter shows tests running.
  private recordResult(test: TestCase, result: TestResult, status: "passed" | "skipped" | "failed") {
    if (!this.resultsPath) return;

    const feature = path.basename(path.dirname(test.location.file));
    const address = `ui/${feature}/${test.title}`;

    let reason = "";
    if (status === "failed" && result.errors && result.errors.length > 0) {
      reason = result.errors.map((e: TestError) => e.message || String(e)).join("\n");
    } else if (status === "skipped") {
      const skip = test.annotations.find((a) => a.type === "skip" || a.type === "fixme");
      reason = skip?.description || "no reason recorded -- this is a bug in whatever skipped it";
    }

    const artifacts = (result.attachments || [])
      .filter((a) => !!a.path)
      .map((a) => path.relative(this.runDir, a.path as string).split(path.sep).join("/"));

    const record = {
      address,
      id: slug(address),
      surface: "ui",
      feature,
      name: test.title,
      status,
      durationMs: result.duration,
      attempt: result.retry || undefined,
      reason: reason ? this.redact(reason) : undefined,
      artifacts: artifacts.length > 0 ? artifacts : undefined,
    };

    try {
      fs.appendFileSync(this.resultsPath, JSON.stringify(record) + "\n", "utf-8");
    } catch {
      // A dropped result line must not crash the run -- see summary.go's
      // ResultsFile doc comment on why this file tolerates partial writes.
    }
  }

  onEnd(result: FullResult): void {
    this.emit({
      surface: "ui",
      kind: "run",
      msg: "suite finished",
      detail: { status: result.status },
    });
  }
}
