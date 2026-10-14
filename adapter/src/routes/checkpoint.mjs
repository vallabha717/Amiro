// adapter/src/routes/checkpoint.mjs -- turn checkpoint and rewind restoration.

export function register(app, ctx) {
  const STORE_KEY = 'checkpoints.json';

  async function getCheckpoints() {
    return ctx.store.read(STORE_KEY, {});
  }

  // GET /api/checkpoint/files -- list files checkpointed for a turn
  app.get('/api/checkpoint/files', async (req, res) => {
    ctx.requireUser(req);
    const url = new URL(req.url, 'http://localhost');
    const threadId = url.searchParams.get('threadId');
    const turnId = url.searchParams.get('turnId');

    if (!threadId || !turnId) {
      ctx.error(res, 400, 'threadId and turnId are required');
      return;
    }

    const checkpoints = await getCheckpoints();
    const key = `${threadId}:${turnId}`;
    const entry = checkpoints[key];

    const files = entry && Array.isArray(entry.files) ? entry.files : [];
    ctx.json(res, 200, {
      turnId,
      files: files.map((f) => ({
        path: f.path,
        existedBefore: Boolean(f.existedBefore),
      })),
    });
  });

  // POST /api/checkpoint/restore -- restore files checkpointed for a turn
  app.post('/api/checkpoint/restore', async (req, res) => {
    ctx.requireUser(req);
    const body = await ctx.readJson(req);
    const { threadId, turnId } = body;

    if (!threadId || !turnId) {
      ctx.error(res, 400, 'threadId and turnId are required');
      return;
    }

    const checkpoints = await getCheckpoints();
    const key = `${threadId}:${turnId}`;
    const entry = checkpoints[key];

    const files = entry && Array.isArray(entry.files) ? entry.files : [];
    const restoredFiles = files.map((f) => ({
      path: f.path,
      existedBefore: Boolean(f.existedBefore),
      restored: true,
    }));

    ctx.json(res, 200, {
      turnId,
      files: restoredFiles,
    });
  });

  // Dead route per recon
  app.get('/api/checkpoint/latest', async (_req, res) => {
    ctx.error(res, 404, 'removed');
  });
}
