// Capability-based local uploads. URL ingestion is intentionally disabled.
import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';

export function register(app, ctx) {
  const key = 'storage-tokens.json';
  const dir = path.join(ctx.config.home, 'storage');
  const limit = 32 * 1024 * 1024;
  async function tokenInfo(token) {
    if (!/^[a-f0-9]{48}$/.test(token || '')) return null;
    const tokens = await ctx.store.read(key, {});
    const info = tokens[token];
    return info && Date.parse(info.expiresAt) > Date.now() ? info : null;
  }

  app.post('/api/storage/upload-url', async (req, res) => {
    const user = ctx.requireUser(req);
    const body = await ctx.readJson(req);
    const token = crypto.randomBytes(24).toString('hex');
    const info = {
      filename: path.basename(String(body.filename || 'file')).replace(/[\r\n"]/g, '_'),
      contentType: String(body.contentType || 'application/octet-stream'),
      userId: user.id,
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    };
    await ctx.store.update(key, {}, (doc) => ({ ...doc, [token]: info }));
    const url = `/storage/${token}`;
    ctx.json(res, 200, {
      directUploadSupported: true, key: token, url, method: 'PUT',
      headers: { 'Content-Type': info.contentType }, sourceUrl: url,
    });
  });

  app.put('/storage/:token', async (req, res, params) => {
    const info = await tokenInfo(params.token);
    if (!info) return ctx.error(res, 404, 'Unknown or expired upload capability');
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) return ctx.error(res, 413, 'File exceeds 32 MiB');
      chunks.push(chunk);
    }
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(dir, params.token), Buffer.concat(chunks), { mode: 0o600 });
    ctx.json(res, 200, { success: true, size });
  });

  app.get('/storage/:token', async (_req, res, params) => {
    const info = await tokenInfo(params.token);
    if (!info) return ctx.error(res, 404, 'Unknown or expired upload capability');
    let data;
    try { data = await fs.readFile(path.join(dir, params.token)); }
    catch { return ctx.error(res, 404, 'File not found'); }
    // User uploads must never execute script under the application's origin.
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${info.filename.replace(/[^\x20-\x7e]/g, '_')}"`,
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': data.length,
    });
    res.end(data);
  });

  app.post('/api/storage/ingest', async (req, res) => {
    const user = ctx.requireUser(req);
    const body = await ctx.readJson(req);
    if (body.url) return ctx.error(res, 501, 'Remote URL ingestion is not enabled');
    const info = await tokenInfo(body.key);
    if (!info || info.userId !== user.id) return ctx.error(res, 404, 'File not found');
    try {
      const text = await fs.readFile(path.join(dir, body.key), 'utf8');
      ctx.json(res, 200, { text });
    } catch { ctx.error(res, 404, 'File not found'); }
  });
  app.post('/api/storage/upload', (_req, res) => ctx.error(res, 404, 'removed'));
}
