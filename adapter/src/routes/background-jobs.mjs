// adapter/src/routes/background-jobs.mjs -- background agent job execution.

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { buildRuntimeCliEnv, resolveRuntimeBin } from '../runtime.mjs';

export function register(app, ctx) {
  const STORE_KEY = 'background-jobs.json';

  async function getJobs() {
    return ctx.store.read(STORE_KEY, {});
  }

  // GET /api/background-jobs -- list jobs
  app.get('/api/background-jobs', async (req, res) => {
    const user = ctx.requireUser(req);
    const jobs = await getJobs();

    const list = Object.values(jobs)
      .filter((j) => user.role === 'admin' || j.userId === user.id)
      .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));

    ctx.json(res, 200, { jobs: list });
  });

  // POST /api/background-jobs -- start background job
  app.post('/api/background-jobs', async (req, res) => {
    const user = ctx.requireUser(req);
    const body = await ctx.readJson(req);

    const prompt = String(body.prompt || '').trim();
    if (!prompt) {
      ctx.error(res, 400, 'prompt is required');
      return;
    }

    const mode = body.mode;
    if (mode !== 'edit' && mode !== 'auto') {
      ctx.error(
        res,
        400,
        'mode must be "edit" or "auto" -- a background job has no one to ask, so plan and interactive are refused at creation'
      );
      return;
    }

    const workspaceRoot = body.workspaceRoot || ctx.config.workspaceDir;
    try {
      await fs.mkdir(workspaceRoot, { recursive: true });
    } catch (err) {
      ctx.error(res, 400, `workspaceRoot is not a directory this server can reach: ${err.message}`);
      return;
    }

    const id = crypto.randomUUID();
    const threadId = crypto.randomUUID();
    const now = ctx.nowIso();

    const job = {
      id,
      threadId,
      workspaceRoot,
      prompt,
      mode,
      status: 'running',
      autoPr: Boolean(body.autoPr),
      userId: user.id,
      startedAt: now,
      finishedAt: null,
    };

    await ctx.store.update(STORE_KEY, {}, (doc) => {
      const out = doc || {};
      out[id] = job;
      return out;
    });

    // Run detached child_process
    try {
      const bin = resolveRuntimeBin(ctx.config.runtimeBin);
      const env = buildRuntimeCliEnv(ctx.config);

      const proc = spawn(bin, ['run', '--json', prompt], {
        cwd: workspaceRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d) => {
        stdout += d.toString();
      });
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
      });

      proc.on('close', async (code) => {
        const finishedAt = ctx.nowIso();
        const success = code === 0;
        await ctx.store.update(STORE_KEY, {}, (doc) => {
          const out = doc || {};
          if (out[id]) {
            out[id].status = success ? 'done' : 'failed';
            out[id].finishedAt = finishedAt;
            if (!success) {
              out[id].error = (stderr || stdout || `exited with code ${code}`).trim();
            }
          }
          return out;
        });
      });

      proc.on('error', async (err) => {
        const finishedAt = ctx.nowIso();
        await ctx.store.update(STORE_KEY, {}, (doc) => {
          const out = doc || {};
          if (out[id]) {
            out[id].status = 'failed';
            out[id].finishedAt = finishedAt;
            out[id].error = String(err && err.message);
          }
          return out;
        });
      });

      proc.unref();
    } catch (err) {
      ctx.log('error', 'failed to spawn background job', { error: String(err && err.message) });
      job.status = 'failed';
      job.finishedAt = ctx.nowIso();
      job.error = String(err && err.message);
      await ctx.store.update(STORE_KEY, {}, (doc) => {
        const out = doc || {};
        out[id] = job;
        return out;
      });
    }

    ctx.json(res, 200, job);
  });

  // Dead route per recon
  app.get('/api/background-jobs/:id', async (_req, res) => {
    ctx.error(res, 404, 'removed');
  });
}
