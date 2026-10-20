/** Stops what global-setup started (unless target.keepInstance) and writes the review report. */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { STATE_FILE, loadConfig, readInstance } from "./config";

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
  fs.rmSync(STATE_FILE, { force: true });
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
