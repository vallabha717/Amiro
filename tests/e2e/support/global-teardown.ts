/** Stops what global-setup started (unless target.keepInstance) and writes the review report. */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { type InstanceState, REPO_ROOT, STATE_FILE, loadConfig, readInstance } from "./config";
import { sandboxEnv } from "./global-setup";

export default async function globalTeardown() {
  if (!fs.existsSync(STATE_FILE)) return;
  const cfg = loadConfig();
  const st = readInstance();
  if (cfg.target.keepInstance) {
    console.log(`[e2e] keeping instance at ${st.baseUrl} (target.keepInstance=true)`);
    return;
  }
  for (const pid of st.pids ?? []) {
    try {
      process.kill(-pid, "SIGTERM"); // whole process group (detached)
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
  }
  // The backend spawns the runtime bridge in its own group; kill anything still
  // running against this run's private root (never matches other instances).
  if (st.root && st.root.includes("amx-e2e-")) {
    killMatching(st.root);
    await new Promise((r) => setTimeout(r, 1500));
    fs.rmSync(st.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
  if (st.sandbox) stopSandbox(st.sandbox);
  fs.rmSync(STATE_FILE, { force: true });
}

/** Stop this run's supervisor, remove its agent containers and its home. */
function stopSandbox(sb: NonNullable<InstanceState["sandbox"]>) {
  const quiet = { stdio: "ignore" as const };
  try {
    execFileSync("bash", [path.join(REPO_ROOT, "scripts/sandbox.sh"), "down"], { ...quiet, env: sandboxEnv(sb) });
  } catch {}
  try {
    const ids = execFileSync("docker", ["ps", "-aq", "--filter", `label=amiro.sandbox.namespace=${sb.namespace}`], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    if (ids.length) execFileSync("docker", ["rm", "-f", ...ids], quiet);
  } catch {}
  if (sb.root.includes("amx-e2e-sandbox-")) fs.rmSync(sb.root, { recursive: true, force: true });
}

function killMatching(needle: string) {
  if (process.platform === "win32") return;
  let out = "";
  try {
    out = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  } catch {
    return;
  }
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || Number(m[1]) === process.pid || !m[2].includes(needle)) continue;
    try {
      process.kill(Number(m[1]), "SIGTERM");
    } catch {}
  }
}
