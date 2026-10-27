/**
 * E2E configuration: tests/e2e.config.json (gitignored) over the committed
 * tests/e2e.config.example.json, then AMIRO_E2E_* env vars on top.
 *
 * Anything a journey needs from the user (API keys, model, MCP servers) lives
 * here. A spec that needs a value that is empty calls `need()` and is skipped
 * with a reason, so a partial config still produces a useful run.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const TESTS_DIR = path.resolve(__dirname, "../..");
export const REPO_ROOT = path.resolve(TESTS_DIR, "..");

/** The onboarded agent's name: fixed, onboarding only picks its look. */
export const DEFAULT_AGENT_NAME = "Amiro";

export interface E2EConfig {
  target: {
    /** "isolated" boots a fresh backend per run; "external" uses baseUrl as-is. */
    mode: "isolated" | "external";
    baseUrl: string;
    port: number;
    backendBin: string;
    runtimeBin: string;
    outDir: string;
    keepInstance: boolean;
  };
  owner: { name: string; email: string; password: string; timezone: string };
  /** The default agent's look; its name is always DEFAULT_AGENT_NAME. */
  agent: { look: string; colour: string };
  provider: {
    label: string;
    id: string;
    apiKey: string;
    model: string;
    /** Used automatically when `model` is not offered by the provider. */
    fallbackModel: string;
  };
  voice: {
    ttsEngine: string;
    ttsApiKey: string;
    ttsVoiceId: string;
    sttEngine: string;
    sttApiKey: string;
  };
  search: { braveApiKey: string; nineRouterApiBase: string; nineRouterApiKey: string };
  composio: { apiKey: string };
  mcp: {
    fixturePort: number;
    bearerToken: string;
    apiKeyHeader: string;
    apiKey: string;
    /** Real remote MCP servers to connect too: {name, url, bearerToken?}. */
    extraRemote: { name: string; url: string; bearerToken?: string }[];
  };
  recording: {
    video: "on" | "off" | "retain-on-failure";
    headless: boolean;
    slowMoMs: number;
    viewport: { width: number; height: number };
    captions: boolean;
    stitch: boolean;
  };
  timeouts: { agentReplyMs: number; testMs: number };
  /**
   * Team-agent sandbox for the isolated instance (scripts/sandbox.sh).
   * "auto" starts it when Docker and both images (amiro-agent:local,
   * amiro-sandboxd:local) are present; "on" fails the run without them.
   */
  sandbox: { mode: "auto" | "on" | "off"; port: number };
}

/** env var → config path. Env always wins over the file. */
const ENV: Record<string, string> = {
  AMIRO_E2E_MODE: "target.mode",
  AMIRO_E2E_BASE_URL: "target.baseUrl",
  AMIRO_E2E_PORT: "target.port",
  AMIRO_E2E_BACKEND_BIN: "target.backendBin",
  AMIRO_E2E_RUNTIME_BIN: "target.runtimeBin",
  AMIRO_E2E_KEEP_INSTANCE: "target.keepInstance",
  AMIRO_E2E_OWNER_EMAIL: "owner.email",
  AMIRO_E2E_OWNER_PASSWORD: "owner.password",
  AMIRO_E2E_PROVIDER_ID: "provider.id",
  AMIRO_E2E_PROVIDER_LABEL: "provider.label",
  AMIRO_E2E_PROVIDER_API_KEY: "provider.apiKey",
  AMIRO_E2E_MODEL: "provider.model",
  AMIRO_E2E_FALLBACK_MODEL: "provider.fallbackModel",
  AMIRO_E2E_ELEVENLABS_API_KEY: "voice.ttsApiKey",
  AMIRO_E2E_TTS_API_KEY: "voice.ttsApiKey",
  AMIRO_E2E_TTS_VOICE_ID: "voice.ttsVoiceId",
  AMIRO_E2E_STT_API_KEY: "voice.sttApiKey",
  AMIRO_E2E_BRAVE_API_KEY: "search.braveApiKey",
  AMIRO_E2E_9ROUTER_API_BASE: "search.nineRouterApiBase",
  AMIRO_E2E_9ROUTER_API_KEY: "search.nineRouterApiKey",
  AMIRO_E2E_COMPOSIO_API_KEY: "composio.apiKey",
  AMIRO_E2E_HEADLESS: "recording.headless",
  AMIRO_E2E_SLOWMO: "recording.slowMoMs",
  AMIRO_E2E_VIDEO: "recording.video",
  AMIRO_E2E_SANDBOX: "sandbox.mode",
  AMIRO_E2E_SANDBOX_PORT: "sandbox.port",
};

function merge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== "object" || Array.isArray(over)) return (over ?? base) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    if (k.startsWith("$")) continue;
    out[k] = k in out && out[k] && typeof out[k] === "object" && !Array.isArray(out[k]) ? merge(out[k], v) : v;
  }
  return out as T;
}

function setPath(obj: Record<string, unknown>, dotted: string, raw: string) {
  const keys = dotted.split(".");
  let cur = obj as Record<string, unknown>;
  for (const k of keys.slice(0, -1)) cur = cur[k] as Record<string, unknown>;
  const last = keys[keys.length - 1];
  const prev = cur[last];
  cur[last] =
    typeof prev === "number" ? Number(raw) : typeof prev === "boolean" ? /^(1|true|yes|on)$/i.test(raw) : raw;
}

let cached: E2EConfig | undefined;

export function loadConfig(): E2EConfig {
  if (cached) return cached;
  const read = (f: string) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {});
  let cfg = read(path.join(TESTS_DIR, "e2e.config.example.json")) as E2EConfig;
  const userFile = process.env.AMIRO_E2E_CONFIG || path.join(TESTS_DIR, "e2e.config.json");
  cfg = merge(cfg, read(userFile));
  for (const [env, key] of Object.entries(ENV)) {
    const v = process.env[env];
    if (v !== undefined && v !== "") setPath(cfg as unknown as Record<string, unknown>, key, v);
  }
  cached = cfg;
  return cfg;
}

/** Where the current run writes videos/report. Set once by the runner/global setup. */
export function runDir(): string {
  if (!process.env.AMIRO_E2E_RUN_DIR) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    process.env.AMIRO_E2E_RUN_DIR = path.join(TESTS_DIR, "recordings", stamp);
  }
  fs.mkdirSync(process.env.AMIRO_E2E_RUN_DIR, { recursive: true });
  return process.env.AMIRO_E2E_RUN_DIR;
}

/** Audio Chrome's fake microphone plays (see global-setup `prepareFakeMic`). */
export const FAKE_MIC_WAV = path.join(TESTS_DIR, ".e2e-state", "fake-mic.wav");

/** State shared between global setup and workers (base URL, pids). */
export const STATE_FILE = path.join(TESTS_DIR, ".e2e-state", "instance.json");

export interface InstanceState {
  baseUrl: string;
  mode: "isolated" | "external";
  root?: string;
  pids?: number[];
  socket?: string;
  backendLog?: string;
  /** The run's own sandbox supervisor, when one was started. */
  sandbox?: { namespace: string; port: number; root: string; home: string };
}

export function readInstance(): InstanceState {
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}
