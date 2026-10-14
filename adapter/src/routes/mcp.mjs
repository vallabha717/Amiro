// adapter/src/routes/mcp.mjs -- MCP server CRUD, customizations, tool execution, and OAuth.

import crypto from 'node:crypto';

export function register(app, ctx) {
  const SERVERS_KEY = 'mcp-servers.json';
  const SERVER_CUSTOM_KEY = 'mcp-server-customizations.json';
  const TOOL_CUSTOM_KEY = 'mcp-tool-customizations.json';

  async function getServers() {
    return ctx.store.read(SERVERS_KEY, {});
  }

  async function getServerCustoms() {
    return ctx.store.read(SERVER_CUSTOM_KEY, {});
  }

  async function getToolCustoms() {
    return ctx.store.read(TOOL_CUSTOM_KEY, {});
  }

  // GET /api/mcp/list -- list servers for caller
  app.get('/api/mcp/list', async (req, res) => {
    const user = ctx.requireUser(req);
    const servers = await getServers();

    const list = Object.values(servers)
      .filter((s) => s.userId === user.id || s.visibility === 'public')
      .map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status || 'connected',
        toolInfo: s.toolInfo || [],
        error: s.error || null,
        visibility: s.visibility || 'private',
        userId: s.userId,
        config: s.userId === user.id ? s.config : undefined,
      }));

    ctx.json(res, 200, list);
  });

  // POST /api/mcp -- create or update MCP server
  app.post('/api/mcp', async (req, res) => {
    const user = ctx.requireUser(req);
    const body = await ctx.readJson(req);

    const name = String(body.name || '').trim();
    if (!name) {
      ctx.error(res, 400, 'name is required');
      return;
    }

    const id = body.id || crypto.randomUUID();
    const now = ctx.nowIso();

    const server = {
      id,
      name,
      config: body.config || {},
      visibility: body.visibility || 'private',
      userId: user.id,
      status: 'connected',
      toolInfo: [],
      createdAt: now,
      updatedAt: now,
    };

    await ctx.store.update(SERVERS_KEY, {}, (doc) => {
      const out = doc || {};
      out[id] = server;
      return out;
    });

    ctx.json(res, 200, { success: true, id });
  });

  // GET /api/mcp/servers/:id -- get one server
  app.get('/api/mcp/servers/:id', async (req, res, params) => {
    const user = ctx.requireUser(req);
    const servers = await getServers();
    const server = servers[params.id];
    if (!server) {
      ctx.error(res, 404, 'MCP server not found');
      return;
    }
    if (server.userId !== user.id && server.visibility !== 'public') {
      ctx.error(res, 403, 'Unauthorized');
      return;
    }

    ctx.json(res, 200, {
      ...server,
      config: server.userId === user.id ? server.config : undefined,
    });
  });

  // DELETE /api/mcp/servers/:id -- remove server
  app.delete('/api/mcp/servers/:id', async (req, res, params) => {
    const user = ctx.requireUser(req);
    const servers = await getServers();
    const server = servers[params.id];
    if (!server) {
      ctx.error(res, 404, 'MCP server not found');
      return;
    }
    if (server.userId !== user.id && user.role !== 'admin') {
      ctx.error(res, 403, 'Unauthorized');
      return;
    }

    await ctx.store.update(SERVERS_KEY, {}, (doc) => {
      const out = doc || {};
      delete out[params.id];
      return out;
    });

    ctx.json(res, 200, { success: true });
  });

  // POST /api/mcp/servers/:id/refresh -- refresh server
  app.post('/api/mcp/servers/:id/refresh', async (req, res, params) => {
    ctx.requireUser(req);
    const servers = await getServers();
    if (!servers[params.id]) {
      ctx.error(res, 404, 'MCP server not found');
      return;
    }
    ctx.json(res, 200, { success: true });
  });

  // POST /api/mcp/servers/:id/share -- change visibility
  app.post('/api/mcp/servers/:id/share', async (req, res, params) => {
    const user = ctx.requireUser(req);
    const body = await ctx.readJson(req);
    const servers = await getServers();
    const server = servers[params.id];
    if (!server) {
      ctx.error(res, 404, 'MCP server not found');
      return;
    }
    if (server.userId !== user.id && user.role !== 'admin') {
      ctx.error(res, 403, 'Unauthorized');
      return;
    }

    const visibility = body.visibility === 'public' ? 'public' : 'private';
    await ctx.store.update(SERVERS_KEY, {}, (doc) => {
      const out = doc || {};
      if (out[params.id]) out[params.id].visibility = visibility;
      return out;
    });

    ctx.json(res, 200, { success: true });
  });

  // POST /api/mcp/servers/:id/tools/:tool/call -- execute tool
  app.post('/api/mcp/servers/:id/tools/:tool/call', async (req, res, params) => {
    ctx.requireUser(req);
    const body = await ctx.readJson(req);
    ctx.json(res, 200, {
      tool: params.tool,
      server: params.id,
      result: `Tool ${params.tool} called on ${params.id}`,
      input: body,
    });
  });

  // POST /api/mcp/servers/:id/oauth/authorize -- start oauth flow
  app.post('/api/mcp/servers/:id/oauth/authorize', async (req, res, params) => {
    ctx.requireUser(req);
    const authorizationUrl = `http://127.0.0.1:${ctx.config.port}/api/mcp/oauth/callback?server=${encodeURIComponent(params.id)}`;
    ctx.json(res, 200, { authorizationUrl });
  });

  // GET /api/mcp/oauth/callback -- public oauth callback
  app.get('/api/mcp/oauth/callback', async (_req, res) => {
    const html = `<!DOCTYPE html>
<html>
<head><title>MCP OAuth Connected</title></head>
<body>
  <h2>Authentication Successful</h2>
  <p>You can close this window now.</p>
  <script>
    if (window.opener) {
      window.opener.postMessage({ type: 'mcp-oauth-success' }, '*');
    }
    setTimeout(function() { window.close(); }, 1500);
  </script>
</body>
</html>`;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
    });
    res.end(html);
  });

  // GET /api/mcp/server-customizations/:server -- get customization
  app.get('/api/mcp/server-customizations/:server', async (req, res, params) => {
    const user = ctx.requireUser(req);
    const customs = await getServerCustoms();
    const key = `${user.id}:${params.server}`;
    const cust = customs[key];
    if (!cust) {
      ctx.json(res, 200, null);
      return;
    }
    ctx.json(res, 200, cust);
  });

  // POST /api/mcp/server-customizations/:server -- save customization
  app.post('/api/mcp/server-customizations/:server', async (req, res, params) => {
    const user = ctx.requireUser(req);
    const body = await ctx.readJson(req);
    const prompt = body.prompt !== undefined ? String(body.prompt) : '';

    const key = `${user.id}:${params.server}`;
    const now = ctx.nowIso();
    const entry = {
      id: crypto.randomUUID(),
      userId: user.id,
      mcpServerId: params.server,
      prompt: prompt || null,
      createdAt: now,
      updatedAt: now,
    };

    await ctx.store.update(SERVER_CUSTOM_KEY, {}, (doc) => {
      const out = doc || {};
      out[key] = entry;
      return out;
    });

    ctx.json(res, 200, entry);
  });

  // DELETE /api/mcp/server-customizations/:server -- delete customization
  app.delete('/api/mcp/server-customizations/:server', async (req, res, params) => {
    const user = ctx.requireUser(req);
    const key = `${user.id}:${params.server}`;
    await ctx.store.update(SERVER_CUSTOM_KEY, {}, (doc) => {
      const out = doc || {};
      delete out[key];
      return out;
    });
    ctx.json(res, 200, { success: true });
  });

  // GET /api/mcp/tool-customizations/:server -- list tool customizations for server
  app.get('/api/mcp/tool-customizations/:server', async (req, res, params) => {
    const user = ctx.requireUser(req);
    const customs = await getToolCustoms();
    const list = Object.values(customs).filter(
      (c) => c.userId === user.id && c.server === params.server
    );
    ctx.json(res, 200, list);
  });

  // GET /api/mcp/tool-customizations/:server/:tool -- get tool customization
  app.get('/api/mcp/tool-customizations/:server/:tool', async (req, res, params) => {
    const user = ctx.requireUser(req);
    const customs = await getToolCustoms();
    const key = `${user.id}:${params.server}:${params.tool}`;
    const cust = customs[key];
    if (!cust) {
      ctx.json(res, 200, null);
      return;
    }
    ctx.json(res, 200, cust);
  });

  // POST /api/mcp/tool-customizations/:server/:tool -- save tool customization
  app.post('/api/mcp/tool-customizations/:server/:tool', async (req, res, params) => {
    const user = ctx.requireUser(req);
    const body = await ctx.readJson(req);
    const prompt = body.prompt !== undefined ? String(body.prompt) : '';

    const key = `${user.id}:${params.server}:${params.tool}`;
    const now = ctx.nowIso();
    const entry = {
      id: crypto.randomUUID(),
      userId: user.id,
      server: params.server,
      tool: params.tool,
      prompt: prompt || null,
      createdAt: now,
      updatedAt: now,
    };

    await ctx.store.update(TOOL_CUSTOM_KEY, {}, (doc) => {
      const out = doc || {};
      out[key] = entry;
      return out;
    });

    ctx.json(res, 200, entry);
  });

  // DELETE /api/mcp/tool-customizations/:server/:tool -- delete tool customization
  app.delete('/api/mcp/tool-customizations/:server/:tool', async (req, res, params) => {
    const user = ctx.requireUser(req);
    const key = `${user.id}:${params.server}:${params.tool}`;
    await ctx.store.update(TOOL_CUSTOM_KEY, {}, (doc) => {
      const out = doc || {};
      delete out[key];
      return out;
    });
    ctx.json(res, 200, { success: true });
  });
}
