import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";

const root = await mkdtemp(
  path.join(
    process.env.JCODE_SCRATCH_DIR || path.join(os.homedir(), ".cache"),
    "amiro-search-runtime-",
  ),
);
const home = path.join(root, "home");
const run = path.join(root, "run");
await mkdir(home);
await mkdir(run);
const registryFile = path.join(home, "search-providers-runtime.json");
const requests = [];
const server = http.createServer((req, res) => {
  requests.push(req.url);
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/selected") {
    res.writeHead(503);
    res.end("credential-sentinel");
  } else {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        results: [
          {
            title: "Configured alternative result",
            url: "https://result.test",
            snippet: "Verified fallback",
          },
        ],
      }),
    );
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
const provider = (id, route) => ({
  id,
  label: id,
  engine: "custom",
  custom: { endpoint: endpoint + route },
});
const registry = {
  default_provider: "selected",
  providers: [
    provider("alternative", "/alternative"),
    provider("selected", "/selected"),
  ],
};
await writeFile(registryFile, JSON.stringify(registry), { mode: 0o600 });
await writeFile(
  path.join(home, "config.toml"),
  `[display]\ndebug_socket = true\n[websearch]\nconfigured_providers_file = ${JSON.stringify(registryFile)}\nengine = "native"\nprefer_native = true\n[features]\nembeddings = false\n`,
  { mode: 0o600 },
);
const bin = path.resolve(
  process.env.AMIRO_RUNTIME_BIN || "runtime/target/debug/amiro-runtime",
);
const child = spawn(
  bin,
  ["--no-update", "--no-selfdev", "--provider", "openai-compatible", "serve"],
  {
    env: {
      ...process.env,
      AMIRO_HOME: home,
      AMIRO_RUNTIME_DIR: run,
      AMIRO_SOCKET: path.join(run, "amiro.sock"),
      AMIRO_DEBUG_SOCKET: "1",
      AMIRO_NO_TELEMETRY: "1",
      AMIRO_WAKE_MODE: "external",
      OPENAI_COMPAT_API_KEY: "fixture-not-real",
      OPENAI_COMPAT_BASE_URL: `${endpoint}/v1`,
      OPENAI_COMPAT_MODEL: "fixture-model",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let logs = "";
child.stdout.on("data", (x) => {
  logs += x;
});
child.stderr.on("data", (x) => {
  logs += x;
});
const socket = path.join(run, "amiro-debug.sock");
const debug = (command, session_id) =>
  new Promise((resolve, reject) => {
    const client = net.createConnection(socket);
    client.setTimeout(60000, () =>
      client.destroy(new Error("Debug response timeout")),
    );
    let text = "";
    client.on("connect", () =>
      client.write(
        JSON.stringify({ type: "debug_command", id: 1, command, session_id }) +
          "\n",
      ),
    );
    client.on("data", (data) => {
      text += data;
      if (text.includes("\n")) {
        client.end();
        const response = JSON.parse(text.split("\n")[0]);
        if (!response.ok) reject(new Error(response.output));
        else resolve(response.output);
      }
    });
    client.on("error", reject);
  });
try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null)
      throw new Error(`Runtime exited ${child.exitCode}: ${logs.slice(-4000)}`);
    try {
      await debug("help");
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  assert(ready, `Debug socket ready: ${logs.slice(-4000)}`);
  const created = JSON.parse(await debug(`create_session:${root}`));
  const session = created.session_id || created.id;
  assert(session, "Created headless session has ID");
  const definitions = JSON.parse(await debug("tools:full", session));
  const websearch = definitions.find((t) => t.name === "websearch");
  assert(websearch, "websearch is exposed");
  assert.deepEqual(websearch.input_schema.properties.provider.enum, [
    "alternative",
    "selected",
  ]);
  assert(!JSON.stringify(websearch).includes(endpoint));
  assert(!websearch.input_schema.properties.engine);
  const searched = JSON.parse(
    await debug(
      'tool:websearch {"query":"rust","intent":"Verify configured search fallback"}',
      session,
    ),
  );
  assert.match(searched.output, /Configured alternative result/);
  assert.match(searched.output, /Fallback after: selected/);
  assert.equal(requests.length, 2);
  assert(requests[0].startsWith("/selected?"));
  assert(requests[1].startsWith("/alternative?"));
  await assert.rejects(
    debug('tool:websearch {"query":"rust","provider":"unconfigured"}', session),
    /not configured/,
  );
  assert.equal(requests.length, 2);
  await writeFile(
    registryFile,
    JSON.stringify({
      default_provider: "alternative",
      providers: [provider("alternative", "/alternative")],
    }),
  );
  const changed = JSON.parse(await debug("tools:full", session)).find(
    (t) => t.name === "websearch",
  );
  assert.deepEqual(changed.input_schema.properties.provider.enum, [
    "alternative",
  ]);
  await writeFile(
    registryFile,
    JSON.stringify({ default_provider: null, providers: [] }),
  );
  await assert.rejects(
    debug('tool:websearch {"query":"rust"}', session),
    /No search providers/,
  );
  assert.equal(requests.length, 2);
  console.log(
    JSON.stringify({
      checks: [
        "binary exposes configured IDs only",
        "default-first HTTP request",
        "503 fallback to configured alternative",
        "unconfigured ID rejected without network",
        "registry changes reflected without restart",
        "empty registry does not escape to free search",
      ],
      artifactRoot: root,
    }),
  );
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    if (child.exitCode !== null) resolve();
    else {
      child.once("exit", resolve);
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000).unref();
    }
  });
  await new Promise((resolve) => server.close(resolve));
  await writeFile(path.join(root, "runtime.log"), logs);
}
