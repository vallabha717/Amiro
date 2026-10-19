// adapter/src/routes/system.mjs -- `GET /api/system`: version, deployment
// topology and host resource usage for the General page.
//
// Mirrors backend/src/routes/system.rs in response shape so the frontend
// (src/components/general/general-settings.tsx) can use one type against
// either server. Reads /proc and `df` only; values a host cannot report come
// back as null and the UI shows "Unavailable".

import os from 'node:os';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import {
  checkForUpdate,
  clearUpdateCache,
  parseVersion,
  startUpdate,
} from '../updates.mjs';

const execFileAsync = promisify(execFile);

const MB = 1024 * 1024;

function cpuTimes() {
  try {
    const stat = readFileSync('/proc/stat', 'utf8');
    const n = stat
      .split('\n')[0]
      .split(/\s+/)
      .slice(1)
      .map((v) => parseInt(v, 10))
      .filter((v) => Number.isFinite(v));
    if (n.length < 5) return null;
    const idle = n[3] + n[4];
    return { total: n.reduce((a, b) => a + b, 0), idle };
  } catch {
    return null;
  }
}

async function cpuPercent() {
  const t1 = cpuTimes();
  if (!t1) return null;
  await new Promise((resolve) => setTimeout(resolve, 250));
  const t2 = cpuTimes();
  if (!t2) return null;
  const total = t2.total - t1.total;
  if (total <= 0) return null;
  const busy = total - (t2.idle - t1.idle);
  return Math.round((busy / total) * 1000) / 10;
}

function memory() {
  try {
    const info = readFileSync('/proc/meminfo', 'utf8');
    const kb = (key) => {
      const line = info.split('\n').find((l) => l.startsWith(key));
      if (!line) return null;
      const value = parseInt(line.split(/\s+/)[1], 10);
      return Number.isFinite(value) ? value : null;
    };
    const total = kb('MemTotal:');
    const avail = kb('MemAvailable:');
    if (total == null || avail == null) return null;
    return {
      totalMb: Math.round((total * 1024) / MB),
      usedMb: Math.round(((total - avail) * 1024) / MB),
    };
  } catch {
    return null;
  }
}

async function disk(targetPath) {
  try {
    const { stdout } = await execFileAsync('df', ['-Pk', targetPath]);
    const cols = stdout.split('\n')[1].split(/\s+/);
    const total = parseFloat(cols[1]);
    const used = parseFloat(cols[2]);
    if (!Number.isFinite(total) || !Number.isFinite(used)) return null;
    return {
      totalMb: Math.round((total * 1024) / MB),
      usedMb: Math.round((used * 1024) / MB),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Deployment topology (mirrors backend/src/routes/system.rs)
// ---------------------------------------------------------------------------

function bindHost() {
  // Late-bound so the value tracks the server's own AMIRO_HOST resolution.
  return process.env.AMIRO_HOST || '127.0.0.1';
}

function bindPort() {
  const parsed = parseInt(process.env.AMIRO_PORT || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8787;
}

function isRemoteBind(host) {
  if (/^localhost$/i.test(host)) return false;
  const kind = isIP(host);
  if (kind === 4 || kind === 6) {
    // 127.0.0.0/8 and ::1 are loopback; anything else is off-box reachable.
    if (host === '::1' || /^127\./.test(host)) return false;
    return true;
  }
  // A hostname we cannot resolve here is treated as remote-facing so a VM
  // install behind a DNS name still reports vm-remote.
  return true;
}

function lanIPv4Addresses() {
  const found = [];
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const info of list || []) {
        if (info.family === 'IPv4' && !info.internal && !found.includes(info.address)) {
          found.push(info.address);
        }
      }
    }
  } catch {
    /* best effort */
  }
  return found;
}

function deploymentInfo() {
  const host = bindHost();
  const port = bindPort();
  const desktopFlag = process.env.AMIRO_DESKTOP;
  const isDesktop = desktopFlag === '1' || /^true$/i.test(desktopFlag || '');
  const mode = isDesktop ? 'desktop' : isRemoteBind(host) ? 'vm-remote' : 'local-server';

  const accessUrls = [`http://localhost:${port}`];
  for (const ip of lanIPv4Addresses()) {
    const url = `http://${ip}:${port}`;
    if (!accessUrls.includes(url)) accessUrls.push(url);
  }

  // desktopBundled: true only when a real Tauri desktop bundle runs this app.
  // The Node adapter has no runtime sidecar layout of its own.
  return {
    mode,
    bindHost: host,
    port,
    accessUrls,
    desktopBundled: isDesktop,
  };
}

const PKG_VERSION = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version || '0.0.0';

function requireAdmin(req, res, ctx) {
  const user = ctx.requireUser(req);
  if (!user || user.role !== 'admin') {
    ctx.error(res, 403, 'Forbidden');
    return null;
  }
  return user;
}

export function register(app, ctx) {
  // GET /api/system -- version, deployment, CPU, memory, disk
  app.get('/api/system', async (req, res) => {
    ctx.requireUser(req);
    const [cpu, mem, dsk] = await Promise.all([cpuPercent(), memory(), disk(ctx.config.home)]);
    ctx.json(res, 200, {
      version: PKG_VERSION,
      deployment: deploymentInfo(),
      cpu: { percent: cpu, cores: os.cpus().length },
      memory: mem,
      disk: dsk,
    });
  });

  // GET /api/system/update -- is there a newer release? (admin only)
  // Never 500s on network trouble: failures come back as checkFailed so
  // the General page keeps working offline.
  app.get('/api/system/update', async (req, res) => {
    if (!requireAdmin(req, res, ctx)) return;
    const url = new URL(req.url, 'http://localhost');
    if (url.searchParams.get('refresh') === '1') clearUpdateCache();
    try {
      const result = await checkForUpdate(PKG_VERSION);
      ctx.json(res, 200, result);
    } catch (err) {
      ctx.json(res, 200, {
        current: PKG_VERSION,
        latest: null,
        updateAvailable: false,
        releaseUrl: 'https://github.com/vallabha717/Amiro/releases',
        publishedAt: null,
        checkFailed: true,
        noReleases: false,
      });
    }
  });

  // POST /api/system/update -- run the release installer detached, exactly
  // like `amiro update` (admin only). The installer restarts the server, so
  // it must outlive this response. Optional JSON body: { "version": "vX.Y.Z" }
  // to install a specific release instead of latest. The version is strictly
  // validated and only ever passed as a single argv element -- never a shell.
  app.post('/api/system/update', async (req, res) => {
    if (!requireAdmin(req, res, ctx)) return;
    let version;
    try {
      const body = await ctx.readJson(req);
      if (body && body.version != null) {
        version = String(body.version).trim();
        if (!parseVersion(version)) {
          ctx.error(res, 400, `refusing to update to unparseable version: ${version}`);
          return;
        }
      }
    } catch {
      // No (or unreadable) body means latest -- same as `amiro update`.
      version = undefined;
    }
    try {
      const result = await startUpdate({ version });
      ctx.json(res, 200, result);
    } catch (err) {
      ctx.error(res, err.status === 404 || err.message?.includes('HTTP 404') ? 404 : 502, err.message || 'could not start update');
    }
  });
}
