/**
 * Boots everything a run needs, once:
 *   - the offline MCP fixture server (open / bearer / api-key / OAuth endpoints)
 *   - in "isolated" mode, a brand-new Amiro backend + runtime with an empty
 *     AMIRO_HOME, so the onboarding journey really is a first run and nothing
 *     touches your own ~/.amiro.
 *
 * The runtime socket lives under a short /tmp path on purpose: Unix socket
 * paths are capped at ~108 bytes and a long path makes the runtime silently
 * fail to start (chat then never replies).
 */
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  type E2EConfig,
  FAKE_MIC_WAV,
  type InstanceState,
  REPO_ROOT,
  STATE_FILE,
  TESTS_DIR,
  loadConfig,
  runDir,
} from "./config";

function firstExisting(...candidates: string[]): string {
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return "";
}

async function waitFor(url: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function triple(): string {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  if (process.platform === "win32") return `${arch}-pc-windows-msvc`;
  return `${arch}-unknown-linux-gnu`;
}

export default async function globalSetup() {
  const cfg = loadConfig();
  const dir = runDir();
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const pids: number[] = [];
  await prepareFakeMic(cfg.voice.ttsApiKey, cfg.voice.ttsVoiceId);

  // ---- MCP fixture --------------------------------------------------------
  const mcpLog = fs.openSync(path.join(dir, "mcp-fixture.log"), "a");
  const mcp = spawn(process.execPath, [path.join(__dirname, "../fixtures/mcp-http-server.mjs"), String(cfg.mcp.fixturePort)], {
    env: {
      ...process.env,
      MCP_BEARER_TOKEN: cfg.mcp.bearerToken,
      MCP_API_KEY_HEADER: cfg.mcp.apiKeyHeader,
      MCP_API_KEY: cfg.mcp.apiKey,
    },
    stdio: ["ignore", mcpLog, mcpLog],
    detached: true,
  });
  mcp.unref();
  pids.push(mcp.pid!);
  if (!(await waitFor(`http://127.0.0.1:${cfg.mcp.fixturePort}/health`, 15000))) {
    throw new Error(`MCP fixture did not start on port ${cfg.mcp.fixturePort}; see ${dir}/mcp-fixture.log`);
  }

  if (cfg.target.mode === "external") {
    if (!cfg.target.baseUrl) throw new Error("target.mode=external needs target.baseUrl");
    const state: InstanceState = { baseUrl: cfg.target.baseUrl.replace(/\/$/, ""), mode: "external", pids };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    return;
  }

  // ---- Isolated Amiro -----------------------------------------------------
  const backendBin = firstExisting(
    cfg.target.backendBin,
    path.join(REPO_ROOT, "backend/target/release/amiro-backend"),
    path.join(REPO_ROOT, "backend/target/debug/amiro-backend"),
  );
  const runtimeBin = firstExisting(
    cfg.target.runtimeBin,
    path.join(REPO_ROOT, `src-tauri/binaries/runtime-${triple()}`),
    path.join(REPO_ROOT, "runtime/target/release/amiro-runtime"),
    path.join(REPO_ROOT, "runtime/target/debug/amiro-runtime"),
  );
  const outDir = cfg.target.outDir || path.join(REPO_ROOT, "out");
  if (!backendBin) throw new Error("No amiro-backend binary. Run: pnpm native:build (or cargo build --release --manifest-path backend/Cargo.toml)");
  if (!runtimeBin) throw new Error("No amiro-runtime binary. Run: pnpm desktop:sidecar or cargo build --manifest-path runtime/Cargo.toml");
  if (!fs.existsSync(path.join(outDir, "index.html"))) throw new Error(`${outDir}/index.html missing. Run: pnpm build`);

  // Short root on purpose (socket path limit), never under the repo.
  const tmpBase = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const root = fs.mkdtempSync(path.join(tmpBase, "amx-e2e-"));
  for (const d of ["home", "rt", "run"]) fs.mkdirSync(path.join(root, d), { recursive: true });
  const sandbox = startSandbox(cfg.sandbox, dir);
  const socket = path.join(root, "run", "api.sock");
  const backendLog = path.join(dir, "backend.log");
  const log = fs.openSync(backendLog, "a");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // With a sandbox the home lives under $HOME: snap-packaged Docker cannot
    // bind-mount /tmp, and the agents' folders are mounted into containers.
    AMIRO_HOME: sandbox?.home ?? path.join(root, "home"),
    ...(sandbox ? { AMIRO_SANDBOX_URL: `http://127.0.0.1:${sandbox.port}` } : {}),
    AMIRO_RUNTIME_HOME: path.join(root, "rt"),
    AMIRO_RUNTIME_DIR: path.join(root, "run"),
    AMIRO_API_SOCKET: socket,
    AMIRO_RUNTIME_BIN: runtimeBin,
    AMIRO_OUT_DIR: outDir,
    AMIRO_PORT: String(cfg.target.port),
    AMIRO_HOST: "127.0.0.1",
    AMIRO_NO_TELEMETRY: "1",
    AMIRO_CONFIG: path.join(root, "amiro.toml"),
    AMIRO_ENV_FILE: path.join(root, "none.env"),
  };
  // Never let the user's own provider keys or owner settings leak into a "first run".
  for (const k of ["AMIRO_SANDBOX_TOKEN", "AMIRO_SANDBOX_MASTER", "AMIRO_SANDBOX_ENV_FILE"]) delete env[k];
  for (const k of Object.keys(env)) {
    if (/^(AMIRO_OWNER_|AMIRO_SKIP_ONBOARDING|AMIRO_CRED_|AMIRO_DEFAULT_MODEL)/.test(k)) delete env[k];
    if (/^(ANTHROPIC|OPENAI|OPENROUTER|GEMINI|COMPOSIO|ELEVENLABS)_API_KEY$/.test(k)) delete env[k];
  }
  fs.writeFileSync(env.AMIRO_CONFIG!, "# empty: E2E isolated instance\n");

  const backend = spawn(backendBin, [], { env, stdio: ["ignore", log, log], detached: true });
  backend.unref();
  pids.push(backend.pid!);

  const baseUrl = `http://127.0.0.1:${cfg.target.port}`;
  if (!(await waitFor(`${baseUrl}/health`, 90000))) {
    throw new Error(`Amiro backend did not become healthy at ${baseUrl}; see ${backendLog}`);
  }
  // The runtime must accept on its socket, or chat silently never answers.
  const sockDeadline = Date.now() + 60000;
  while (!fs.existsSync(socket) && Date.now() < sockDeadline) await new Promise((r) => setTimeout(r, 500));
  if (!fs.existsSync(socket)) throw new Error(`Amiro runtime never opened ${socket}; see ${backendLog}`);

  const state: InstanceState = { baseUrl, mode: "isolated", root, pids, socket, backendLog, sandbox: sandbox ?? undefined };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ ...state, backendBin, runtimeBin, outDir }, null, 2));
  console.log(`[e2e] isolated Amiro at ${baseUrl} (home ${root}); recordings → ${path.relative(TESTS_DIR, dir)}`);
}

/**
 * Start this run's own sandbox supervisor (scripts/sandbox.sh, namespace
 * `amiroe2e`) so team agents' tools run in real containers. Returns null, with
 * the reason printed, when it is off or (in "auto") Docker or an image is
 * missing; the team journey then checks the "unavailable" state instead.
 */
function startSandbox(sandbox: E2EConfig["sandbox"], dir: string) {
  if (sandbox.mode === "off" || process.platform === "win32") return null;
  const why = (() => {
    try {
      execFileSync("docker", ["image", "inspect", "amiro-agent:local", "amiro-sandboxd:local"], { stdio: "ignore" });
      return "";
    } catch {
      return "Docker or the images amiro-agent:local / amiro-sandboxd:local are missing (bash scripts/sandbox.sh up builds them)";
    }
  })();
  if (why) {
    if (sandbox.mode === "on") throw new Error(`sandbox.mode=on but ${why}`);
    console.log(`[e2e] no team-agent sandbox: ${why}`);
    return null;
  }
  const sandboxRoot = fs.mkdtempSync(path.join(os.homedir(), ".cache", "amx-e2e-sandbox-"));
  const home = path.join(sandboxRoot, "home");
  fs.mkdirSync(home, { recursive: true });
  const env = sandboxEnv({ namespace: "amiroe2e", port: sandbox.port, root: sandboxRoot, home });
  const out = fs.openSync(path.join(dir, "sandbox.log"), "a");
  execFileSync("bash", [path.join(REPO_ROOT, "scripts/sandbox.sh"), "up"], { env, stdio: ["ignore", out, out] });
  console.log(`[e2e] team-agent sandbox on 127.0.0.1:${sandbox.port} (home ${home})`);
  return { namespace: "amiroe2e", port: sandbox.port, root: sandboxRoot, home };
}

/** Environment for scripts/sandbox.sh for this run's sandbox. */
export function sandboxEnv(sb: NonNullable<InstanceState["sandbox"]>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AMIRO_HOME: sb.home,
    AMIRO_SANDBOX_PORT: String(sb.port),
    AMIRO_SANDBOX_NAMESPACE: sb.namespace,
    AMIRO_SANDBOX_SKIP_BUILD: "1",
  };
}

/**
 * Chrome's fake microphone plays FAKE_MIC_WAV. With an ElevenLabs key we speak
 * a real question (so STT and live voice can be asserted on content);
 * otherwise a short tone keeps the audio pipeline exercised.
 */
async function prepareFakeMic(elevenKey: string, voiceId: string) {
  fs.rmSync(`${FAKE_MIC_WAV}.spoken`, { force: true });
  const tmp = `${FAKE_MIC_WAV}.mp3`;
  try {
    if (elevenKey) {
      const voice = voiceId || "21m00Tcm4TlvDq8ikWAM";
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
        method: "POST",
        headers: { "xi-api-key": elevenKey, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text: "What is two plus two?", model_id: "eleven_multilingual_v2" }),
      });
      if (r.ok) {
        fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
        execFileSync("ffmpeg", ["-y", "-v", "error", "-i", tmp, "-af", "apad=pad_dur=3", "-ar", "48000", "-ac", "1", FAKE_MIC_WAV]);
        fs.writeFileSync(`${FAKE_MIC_WAV}.spoken`, "What is two plus two?");
        return;
      }
      console.warn(`[e2e] ElevenLabs TTS for the fake mic failed (${r.status}); using a tone`);
    }
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-ar", "48000", "-ac", "1", FAKE_MIC_WAV]);
  } catch (e) {
    console.warn(`[e2e] could not prepare fake mic audio: ${(e as Error).message}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
