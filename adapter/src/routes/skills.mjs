// adapter/src/routes/skills.mjs -- skill catalog CRUD, duplicate, and LLM drafting.

export function register(app, ctx) {
  const STORE_KEY = 'skills.json';

  async function getSkills() {
    return ctx.store.read(STORE_KEY, {});
  }

  // GET /api/skills -- list all skills
  app.get('/api/skills', async (req, res) => {
    ctx.requireUser(req);
    const skills = await getSkills();
    const items = Object.values(skills).map((s) => ({
      name: s.name,
      description: s.description || '',
      scope: s.scope || 'personal',
      readonly: Boolean(s.readonly),
      path: s.path || '',
      updatedAt: s.updatedAt || ctx.nowIso(),
    }));

    ctx.json(res, 200, {
      items,
      diagnostics: [],
      truncated: false,
    });
  });

  // GET /api/skills/items/:name -- get full skill details
  app.get('/api/skills/items/:name', async (req, res, params) => {
    ctx.requireUser(req);
    const name = decodeURIComponent(params.name);
    const skills = await getSkills();
    const skill = skills[name];

    if (!skill) {
      ctx.error(res, 404, 'skill not found');
      return;
    }

    ctx.json(res, 200, {
      name: skill.name,
      description: skill.description || '',
      body: skill.body || '',
      resources: skill.resources || [],
      scope: skill.scope || 'personal',
      readonly: Boolean(skill.readonly),
      path: skill.path || '',
      updatedAt: skill.updatedAt || ctx.nowIso(),
    });
  });

  // POST /api/skills -- create skill
  app.post('/api/skills', async (req, res) => {
    ctx.requireUser(req);
    const body = await ctx.readJson(req);

    const name = String(body.name || '').trim().toLowerCase();
    if (!name) {
      ctx.error(res, 400, 'skill name is required');
      return;
    }

    const skills = await getSkills();
    if (skills[name]) {
      ctx.error(res, 409, `skill ${name} already exists`);
      return;
    }

    const now = ctx.nowIso();
    const skill = {
      name,
      description: String(body.description || '').trim(),
      body: String(body.body || '').trim(),
      resources: body.resources || [],
      scope: 'personal',
      readonly: false,
      path: `~/.amiro/skills/${name}`,
      createdAt: now,
      updatedAt: now,
    };

    await ctx.store.update(STORE_KEY, {}, (doc) => {
      const out = doc || {};
      out[name] = skill;
      return out;
    });

    ctx.json(res, 200, { skill, warnings: [] });
  });

  // PUT /api/skills/items/:name -- update skill
  app.put('/api/skills/items/:name', async (req, res, params) => {
    ctx.requireUser(req);
    const name = decodeURIComponent(params.name);
    const skills = await getSkills();
    const skill = skills[name];

    if (!skill) {
      ctx.error(res, 404, 'skill not found');
      return;
    }
    if (skill.readonly) {
      ctx.error(res, 409, 'skill is read-only');
      return;
    }

    const body = await ctx.readJson(req);
    skill.description = body.description !== undefined ? String(body.description).trim() : skill.description;
    skill.body = body.body !== undefined ? String(body.body).trim() : skill.body;
    skill.updatedAt = ctx.nowIso();

    await ctx.store.update(STORE_KEY, {}, (doc) => {
      const out = doc || {};
      out[name] = skill;
      return out;
    });

    ctx.json(res, 200, { skill, warnings: [] });
  });

  // DELETE /api/skills/items/:name -- delete skill
  app.delete('/api/skills/items/:name', async (req, res, params) => {
    ctx.requireUser(req);
    const name = decodeURIComponent(params.name);
    const skills = await getSkills();
    const skill = skills[name];

    if (!skill) {
      ctx.error(res, 404, 'skill not found');
      return;
    }
    if (skill.readonly) {
      ctx.error(res, 409, 'skill is read-only');
      return;
    }

    await ctx.store.update(STORE_KEY, {}, (doc) => {
      const out = doc || {};
      delete out[name];
      return out;
    });

    ctx.json(res, 200, { success: true });
  });

  // POST /api/skills/items/:name/duplicate -- duplicate skill
  app.post('/api/skills/items/:name/duplicate', async (req, res, params) => {
    ctx.requireUser(req);
    const name = decodeURIComponent(params.name);
    const skills = await getSkills();
    const skill = skills[name];

    if (!skill) {
      ctx.error(res, 404, 'skill not found');
      return;
    }

    let copyName = `${name}-copy`;
    let counter = 1;
    while (skills[copyName]) {
      counter += 1;
      copyName = `${name}-copy-${counter}`;
    }

    const now = ctx.nowIso();
    const duplicate = {
      ...skill,
      name: copyName,
      readonly: false,
      createdAt: now,
      updatedAt: now,
    };

    await ctx.store.update(STORE_KEY, {}, (doc) => {
      const out = doc || {};
      out[copyName] = duplicate;
      return out;
    });

    ctx.json(res, 200, { skill: duplicate, warnings: [] });
  });

  // POST /api/skills/generate -- LLM generation of a skill draft
  app.post('/api/skills/generate', async (req, res) => {
    ctx.requireUser(req);
    const body = await ctx.readJson(req);
    const message = body.message || 'a helpful skill';

    let draft = null;
    try {
      const prompt = `Generate a single JSON object with exact keys "name" (lowercase, digits, hyphens), "description", and "body" (markdown content) for a skill with this requirement: ${message}. Output only JSON.`;
      const resText = await ctx.jcode.execJson(['run', prompt]);
      if (typeof resText === 'string') {
        const jsonMatch = resText.match(/\{[\s\S]*\}/);
        if (jsonMatch) draft = JSON.parse(jsonMatch[0]);
      } else if (resText && typeof resText === 'object') {
        draft = resText;
      }
    } catch {
      // Fallback draft if execution failed
    }

    if (!draft || !draft.name) {
      const safeName = message.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'new-skill';
      draft = {
        name: safeName,
        description: `Skill for: ${message}`,
        body: `# ${safeName}\n\nInstructions for ${message}.\n`,
      };
    }

    const payload = JSON.stringify(draft);
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  });
}
