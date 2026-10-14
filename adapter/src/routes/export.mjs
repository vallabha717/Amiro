// adapter/src/routes/export.mjs -- shared chat exports and comment threads.

import crypto from 'node:crypto';
import path from 'node:path';

export function register(app, ctx) {
  const EXPORTS_KEY = 'exports.json';
  const COMMENTS_KEY = 'export-comments.json';
  const usersFile = path.join(ctx.config.home, 'users.json');

  async function getExports() {
    return ctx.store.read(EXPORTS_KEY, {});
  }

  async function getComments() {
    return ctx.store.read(COMMENTS_KEY, {});
  }

  async function getUser(id) {
    const doc = await ctx.store.readJson(usersFile, { users: [] });
    const users = Array.isArray(doc.users) ? doc.users : [];
    return users.find((u) => u.id === id) || null;
  }

  // GET /api/export -- list caller's exports
  app.get('/api/export', async (req, res) => {
    const user = ctx.requireUser(req);
    const exportsDoc = await getExports();
    const commentsDoc = await getComments();

    const list = Object.values(exportsDoc)
      .filter((e) => e.exporterId === user.id)
      .map((e) => {
        const commentCount = Object.values(commentsDoc).filter((c) => c.exportId === e.id).length;
        return {
          id: e.id,
          title: e.title || 'Chat Export',
          exporterId: e.exporterId,
          originalThreadId: e.originalThreadId || e.threadId || null,
          commentCount: e.commentCount !== undefined ? e.commentCount : commentCount,
          exportedAt: e.createdAt || e.exportedAt || ctx.nowIso(),
          expiresAt: e.expiresAt || null,
        };
      });

    ctx.json(res, 200, list);
  });

  // GET /api/export/:id -- view a single export (public / optional session)
  app.get('/api/export/:id', async (req, res, params) => {
    const exportsDoc = await getExports();
    const exp = exportsDoc[params.id];
    if (!exp) {
      ctx.error(res, 404, 'Export not found');
      return;
    }

    const exporter = await getUser(exp.exporterId);
    const now = new Date();
    const isExpired = exp.expiresAt ? new Date(exp.expiresAt) < now : false;

    ctx.json(res, 200, {
      id: exp.id,
      title: exp.title || 'Chat Export',
      exporterId: exp.exporterId,
      originalThreadId: exp.originalThreadId || exp.threadId || null,
      messages: isExpired ? [] : (exp.messages || []),
      exportedAt: exp.createdAt || exp.exportedAt || ctx.nowIso(),
      expiresAt: exp.expiresAt || null,
      exporterName: exporter ? exporter.name : null,
      exporterImage: exporter ? exporter.image || null : null,
      isExpired,
    });
  });

  // DELETE /api/export/:id -- delete an export
  app.delete('/api/export/:id', async (req, res, params) => {
    const user = ctx.requireUser(req);
    const exportsDoc = await getExports();
    const exp = exportsDoc[params.id];
    if (!exp) {
      ctx.error(res, 404, 'Export not found');
      return;
    }
    if (exp.exporterId !== user.id && user.role !== 'admin') {
      ctx.error(res, 403, 'Forbidden');
      return;
    }

    await ctx.store.update(EXPORTS_KEY, {}, (doc) => {
      const out = doc || {};
      delete out[params.id];
      return out;
    });

    await ctx.store.update(COMMENTS_KEY, {}, (doc) => {
      const out = doc || {};
      for (const [k, v] of Object.entries(out)) {
        if (v.exportId === params.id) delete out[k];
      }
      return out;
    });

    ctx.json(res, 200, { success: true });
  });

  // GET /api/export/:id/comments -- list comments on an export
  app.get('/api/export/:id/comments', async (req, res, params) => {
    const user = req.user || null;
    const commentsDoc = await getComments();
    const allComments = Object.values(commentsDoc).filter((c) => c.exportId === params.id);

    const doc = await ctx.store.readJson(usersFile, { users: [] });
    const users = Array.isArray(doc.users) ? doc.users : [];
    const userMap = new Map(users.map((u) => [u.id, u]));

    function buildCommentTree(parentId = null) {
      return allComments
        .filter((c) => (c.parentId || null) === parentId)
        .map((c) => {
          const author = userMap.get(c.authorId);
          return {
            id: c.id,
            exportId: c.exportId,
            authorId: c.authorId,
            parentId: c.parentId || null,
            content: c.content,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
            authorName: author ? author.name : null,
            authorImage: author ? author.image || null : null,
            isOwner: user ? c.authorId === user.id : false,
            replies: buildCommentTree(c.id),
          };
        });
    }

    ctx.json(res, 200, buildCommentTree(null));
  });

  // POST /api/export/:id/comments -- add a comment
  app.post('/api/export/:id/comments', async (req, res, params) => {
    const user = ctx.requireUser(req);
    const exportsDoc = await getExports();
    const exp = exportsDoc[params.id];
    if (!exp) {
      ctx.error(res, 404, 'Export not found');
      return;
    }

    const body = await ctx.readJson(req);
    if (!body.content) {
      ctx.error(res, 400, 'content is required');
      return;
    }

    const id = crypto.randomUUID();
    const now = ctx.nowIso();
    const comment = {
      id,
      exportId: params.id,
      authorId: user.id,
      parentId: body.parentId || null,
      content: body.content,
      createdAt: now,
      updatedAt: now,
    };

    await ctx.store.update(COMMENTS_KEY, {}, (doc) => {
      const out = doc || {};
      out[id] = comment;
      return out;
    });

    await ctx.store.update(EXPORTS_KEY, {}, (doc) => {
      const out = doc || {};
      if (out[params.id]) {
        out[params.id].commentCount = (out[params.id].commentCount || 0) + 1;
      }
      return out;
    });

    ctx.json(res, 200, {
      ...comment,
      authorName: user.name,
      authorImage: user.image || null,
      isOwner: true,
      replies: [],
    });
  });

  // DELETE /api/export/:id/comments/:commentId -- delete a comment
  app.delete('/api/export/:id/comments/:commentId', async (req, res, params) => {
    const user = ctx.requireUser(req);
    const commentsDoc = await getComments();
    const comment = commentsDoc[params.commentId];
    if (!comment) {
      ctx.error(res, 404, 'Comment not found');
      return;
    }
    if (comment.authorId !== user.id && user.role !== 'admin') {
      ctx.error(res, 403, 'Forbidden');
      return;
    }

    await ctx.store.update(COMMENTS_KEY, {}, (doc) => {
      const out = doc || {};
      delete out[params.commentId];
      return out;
    });

    await ctx.store.update(EXPORTS_KEY, {}, (doc) => {
      const out = doc || {};
      if (out[params.id] && out[params.id].commentCount > 0) {
        out[params.id].commentCount -= 1;
      }
      return out;
    });

    ctx.json(res, 200, { success: true });
  });
}
