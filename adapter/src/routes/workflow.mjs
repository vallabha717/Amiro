// adapter/src/routes/workflow.mjs -- workflow CRUD, structure, and execution (501).

import crypto from 'node:crypto';

export function register(app, ctx) {
  const WORKFLOWS_KEY = 'workflows.json';
  const STRUCTURES_KEY = 'workflow-structures.json';

  async function getWorkflows() {
    return ctx.store.read(WORKFLOWS_KEY, {});
  }

  async function getStructures() {
    return ctx.store.read(STRUCTURES_KEY, {});
  }

  // GET /api/workflow -- list caller's workflows
  app.get('/api/workflow', async (req, res) => {
    const user = ctx.requireUser(req);
    const workflows = await getWorkflows();
    const list = Object.values(workflows).filter(
      (w) => w.userId === user.id || w.visibility === 'public'
    );
    ctx.json(res, 200, list);
  });

  // POST /api/workflow -- create a new workflow
  app.post('/api/workflow', async (req, res) => {
    const user = ctx.requireUser(req);
    const body = await ctx.readJson(req);

    const name = String(body.name || '').trim();
    if (!name) {
      ctx.error(res, 400, 'name is required');
      return;
    }

    const id = body.id || crypto.randomUUID();
    const now = ctx.nowIso();

    const workflow = {
      id,
      name,
      description: body.description || null,
      userId: user.id,
      visibility: body.visibility || 'private',
      isPublished: Boolean(body.isPublished),
      createdAt: now,
      updatedAt: now,
    };

    await ctx.store.update(WORKFLOWS_KEY, {}, (doc) => {
      const out = doc || {};
      out[id] = workflow;
      return out;
    });

    ctx.json(res, 200, workflow);
  });

  // GET /api/workflow/tools -- available tools for workflow nodes
  app.get('/api/workflow/tools', async (req, res) => {
    ctx.requireUser(req);
    ctx.json(res, 200, [
      { id: 'bash', name: 'Bash', description: 'Run bash commands' },
      { id: 'web_search', name: 'Web Search', description: 'Search the web' },
      { id: 'read', name: 'Read File', description: 'Read a file' },
      { id: 'write', name: 'Write File', description: 'Write a file' },
    ]);
  });

  // GET /api/workflow/:id -- get workflow details
  app.get('/api/workflow/:id', async (req, res, params) => {
    const user = ctx.requireUser(req);
    const workflows = await getWorkflows();
    const wf = workflows[params.id];
    if (!wf) {
      ctx.error(res, 404, 'workflow not found');
      return;
    }
    if (wf.userId !== user.id && wf.visibility !== 'public') {
      ctx.error(res, 403, 'Unauthorized');
      return;
    }
    ctx.json(res, 200, wf);
  });

  // PUT /api/workflow/:id -- update workflow
  app.put('/api/workflow/:id', async (req, res, params) => {
    const user = ctx.requireUser(req);
    const workflows = await getWorkflows();
    const wf = workflows[params.id];
    if (!wf) {
      ctx.error(res, 404, 'workflow not found');
      return;
    }
    if (wf.userId !== user.id && user.role !== 'admin') {
      ctx.error(res, 403, 'Unauthorized');
      return;
    }

    const body = await ctx.readJson(req);
    if (body.name !== undefined) wf.name = String(body.name).trim();
    if (body.description !== undefined) wf.description = body.description;
    if (body.visibility !== undefined) wf.visibility = body.visibility;
    if (body.isPublished !== undefined) wf.isPublished = Boolean(body.isPublished);
    wf.updatedAt = ctx.nowIso();

    await ctx.store.update(WORKFLOWS_KEY, {}, (doc) => {
      const out = doc || {};
      out[params.id] = wf;
      return out;
    });

    ctx.json(res, 200, wf);
  });

  // DELETE /api/workflow/:id -- delete workflow
  app.delete('/api/workflow/:id', async (req, res, params) => {
    const user = ctx.requireUser(req);
    const workflows = await getWorkflows();
    const wf = workflows[params.id];
    if (!wf) {
      ctx.error(res, 404, 'workflow not found');
      return;
    }
    if (wf.userId !== user.id && user.role !== 'admin') {
      ctx.error(res, 403, 'Unauthorized');
      return;
    }

    await ctx.store.update(WORKFLOWS_KEY, {}, (doc) => {
      const out = doc || {};
      delete out[params.id];
      return out;
    });

    await ctx.store.update(STRUCTURES_KEY, {}, (doc) => {
      const out = doc || {};
      delete out[params.id];
      return out;
    });

    ctx.json(res, 200, { success: true });
  });

  // GET /api/workflow/:id/structure -- get graph nodes & edges
  app.get('/api/workflow/:id/structure', async (req, res, params) => {
    const user = ctx.requireUser(req);
    const workflows = await getWorkflows();
    const wf = workflows[params.id];
    if (!wf) {
      ctx.error(res, 404, 'workflow not found');
      return;
    }
    if (wf.userId !== user.id && wf.visibility !== 'public') {
      ctx.error(res, 403, 'Unauthorized');
      return;
    }

    const structures = await getStructures();
    const struct = structures[params.id] || { nodes: [], edges: [] };

    ctx.json(res, 200, {
      nodes: struct.nodes || [],
      edges: struct.edges || [],
      userId: wf.userId,
      visibility: wf.visibility,
    });
  });

  // POST /api/workflow/:id/structure -- save graph nodes & edges
  app.post('/api/workflow/:id/structure', async (req, res, params) => {
    const user = ctx.requireUser(req);
    const workflows = await getWorkflows();
    const wf = workflows[params.id];
    if (!wf) {
      ctx.error(res, 404, 'workflow not found');
      return;
    }
    if (wf.userId !== user.id && user.role !== 'admin') {
      ctx.error(res, 403, 'Unauthorized');
      return;
    }

    const body = await ctx.readJson(req);
    const nodes = body.nodes || [];
    const edges = body.edges || [];

    await ctx.store.update(STRUCTURES_KEY, {}, (doc) => {
      const out = doc || {};
      out[params.id] = { nodes, edges, updatedAt: ctx.nowIso() };
      return out;
    });

    ctx.json(res, 200, { success: true });
  });

  // POST /api/workflow/:id/execute -- honest 501 per adapter contract
  app.post('/api/workflow/:id/execute', async (_req, res) => {
    ctx.error(res, 501, 'not supported on jcode backend');
  });
}
