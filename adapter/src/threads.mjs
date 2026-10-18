// adapter/src/threads.mjs -- /api/thread* routes + Amiro thread <-> runtime session map.
//
// Store: $AMIRO_HOME/threads.json
//   { "<threadId>": { sessionId, title, userId, createdAt, lastMessageAt, archived } }
//
// Message ids are synthesized because runtime history has no persisted message
// ids: `msg_<historyIndex>_<sessionId>`. Message *content* lives in the runtime
// session; this adapter stores only the mapping, so history always reflects
// what the runtime actually has.

import crypto from 'node:crypto';
import path from 'node:path';

export function threadsFile(home) {
  return path.join(home, 'threads.json');
}

export async function loadThreads(store, home) {
  const doc = await store.readJson(threadsFile(home), {});
  return doc && typeof doc === 'object' ? doc : {};
}

export async function saveThreads(store, home, map) {
  await store.writeJson(threadsFile(home), map);
}

export async function getEntry(store, home, id) {
  const map = await loadThreads(store, home);
  return map[id] || null;
}

export async function upsertEntry(store, home, id, patch) {
  const map = await loadThreads(store, home);
  const existing = map[id] || {};
  map[id] = { ...existing, ...patch };
  await saveThreads(store, home, map);
  return map[id];
}

export async function removeEntry(store, home, id) {
  const map = await loadThreads(store, home);
  delete map[id];
  await saveThreads(store, home, map);
}

export function messageId(sessionId, index) {
  return `msg_${index}_${sessionId}`;
}

// Fail-closed ownership: a mapping with no owner is not accessible to anyone,
// and only the matching user id may access it. Refusing ownerless mappings
// prevents a legacy/absent owner from exposing a shared-daemon session.
export function ownsEntry(entry, user) {
  if (!entry || !entry.userId) return false;
  return Boolean(user) && entry.userId === user.id;
}

async function findEntryBySession(store, home, sessionId) {
  const map = await loadThreads(store, home);
  for (const [id, entry] of Object.entries(map)) {
    if (entry.sessionId === sessionId) return { id, ...entry };
  }
  return null;
}

export function parseMessageId(id) {
  const m = /^msg_(\d+)_(.+)$/.exec(String(id || ''));
  if (!m) return null;
  return { index: Number(m[1]), sessionId: m[2] };
}

function roleFor(role) {
  return role === 'user' ? 'user' : 'assistant';
}

function extractThinkingAndText(content) {
  const thinkings = [];
  const openTag = '<thinking>';
  const closeTag = '</thinking>';
  let remaining = '';
  let rest = String(content || '');

  while (true) {
    const startIdx = rest.indexOf(openTag);
    if (startIdx === -1) {
      remaining += rest;
      break;
    }
    remaining += rest.slice(0, startIdx);
    const afterOpen = rest.slice(startIdx + openTag.length);
    const endIdx = afterOpen.indexOf(closeTag);
    if (endIdx === -1) {
      thinkings.push(afterOpen.trim());
      break;
    }
    thinkings.push(afterOpen.slice(0, endIdx).trim());
    rest = afterOpen.slice(endIdx + closeTag.length);
  }
  return { thinkings, remaining };
}

// Translate runtime HistoryMessage[] -> the frontend's persisted message shape
// {id, threadId, role, parts, metadata?, createdAt}.
export function historyToMessages(threadId, sessionId, history) {
  const messages = [];
  const list = history || [];
  let i = 0;
  while (i < list.length) {
    const m = list[i];
    if (m && m.role === 'user') {
      const parts = [{ type: 'text', text: m.content ?? '' }];
      const msg = {
        id: messageId(sessionId, i),
        threadId,
        role: 'user',
        parts,
        createdAt: new Date().toISOString(),
      };
      if (m.response_stats) {
        const stats = m.response_stats;
        const input = stats.input_tokens || 0;
        const output = stats.output_tokens || 0;
        const metadata = {
          usage: {
            promptTokens: input,
            completionTokens: output,
            totalTokens: input + output,
          },
        };
        if (typeof stats.duration_secs === 'number') {
          metadata.durationMs = Math.round(stats.duration_secs * 1000);
        }
        msg.metadata = metadata;
      }
      messages.push(msg);
      i++;
    } else {
      const start = i;
      const firstId = messageId(sessionId, start);
      const parts = [];
      let turnStats = null;
      let hasTools = false;

      while (i < list.length) {
        const row = list[i];
        if (!row || row.role === 'user') {
          break;
        }
        if (row.response_stats) {
          turnStats = row.response_stats;
        }
        const content = row.content ?? '';
        if (row.role === 'tool') {
          hasTools = true;
          if (parts.length === 1 && parts[0].type === 'text' && parts[0].text === '') {
            parts.pop();
          }
          const td = row.tool_data;
          const callId = td && td.id ? String(td.id) : `call_${i}`;
          const name = td && td.name ? String(td.name) : 'tool';
          const input = td && td.input !== undefined ? td.input : {};
          let parsedOutput = content;
          if (typeof content === 'string') {
            try {
              const p = JSON.parse(content);
              if (p !== null && typeof p === 'object') {
                parsedOutput = p;
              }
            } catch {
              /* keep string */
            }
          }
          parts.push({
            type: `tool-${name}`,
            toolCallId: callId,
            toolName: name,
            state: 'output-available',
            input,
            output: parsedOutput,
          });
        } else {
          const { thinkings, remaining } = extractThinkingAndText(content);
          for (const t of thinkings) {
            parts.push({
              type: 'reasoning',
              text: t,
            });
          }
          if (remaining.trim()) {
            parts.push({
              type: 'text',
              text: content.includes('<thinking>') ? remaining.trim() : content,
            });
          } else if (!hasTools && parts.length === 0) {
            parts.push({
              type: 'text',
              text: content,
            });
          }
        }
        i++;
      }

      if (parts.length === 0) {
        parts.push({ type: 'text', text: '' });
      }

      const msg = {
        id: firstId,
        threadId,
        role: 'assistant',
        parts,
        createdAt: new Date().toISOString(),
      };
      if (turnStats) {
        const input = turnStats.input_tokens || 0;
        const output = turnStats.output_tokens || 0;
        const metadata = {
          usage: {
            promptTokens: input,
            completionTokens: output,
            totalTokens: input + output,
          },
        };
        if (typeof turnStats.duration_secs === 'number') {
          metadata.durationMs = Math.round(turnStats.duration_secs * 1000);
        }
        msg.metadata = metadata;
      }
      messages.push(msg);
    }
  }
  return messages;
}

// Session-scoped read on an attached connection. Failures propagate (no silent
// empty history): the caller's error handling decides the HTTP status.
async function historyFor(ctx, sessionId) {
  return ctx.runtime.withSession(sessionId, (client) => client.getHistory(sessionId));
}

export function register(app, ctx) {
  const home = ctx.config.home;

  async function ownedThreads(req) {
    const map = await loadThreads(ctx.store, home);
    return Object.entries(map)
      .filter(([, e]) => ownsEntry(e, req.user))
      .map(([id, e]) => ({ id, ...e }));
  }

  app.get('/api/thread', async (req, res) => {
    const list = await ownedThreads(req);
    ctx.json(
      res,
      200,
      list.map((t) => ({
        id: t.id,
        title: t.title || 'New Chat',
        userId: t.userId || '',
        createdAt: t.createdAt,
        lastMessageAt: t.lastMessageAt || t.createdAt,
        archived: Boolean(t.archived),
        workingDir: t.workingDir || ctx.config.workspaceDir,
      })),
    );
  });

  app.get('/api/thread/:id', async (req, res, params) => {
    const entry = await getEntry(ctx.store, home, params.id);
    if (!entry || !ownsEntry(entry, req.user)) {
      return ctx.error(res, 404, 'thread not found');
    }
    const history = await historyFor(ctx, entry.sessionId);
    ctx.json(res, 200, {
      id: params.id,
      title: entry.title || 'New Chat',
      userId: entry.userId || '',
      createdAt: entry.createdAt,
      lastMessageAt: entry.lastMessageAt || entry.createdAt,
      archived: Boolean(entry.archived),
      workingDir: entry.workingDir || ctx.config.workspaceDir,
      messages: historyToMessages(params.id, entry.sessionId, history),
    });
  });

  app.put('/api/thread/:id', async (req, res, params) => {
    const entry = await getEntry(ctx.store, home, params.id);
    if (!entry || !ownsEntry(entry, req.user)) return ctx.error(res, 404, 'thread not found');
    const body = await ctx.readJson(req);
    const title = body.title ?? entry.title;
    try {
      await ctx.runtime.withSession(entry.sessionId, (client) =>
        client.renameSession(entry.sessionId, title),
      );
    } catch (err) {
      ctx.log('warn', 'renameSession failed', { error: String(err && err.message) });
    }
    const updated = await upsertEntry(ctx.store, home, params.id, { title });
    ctx.json(res, 200, {
      id: params.id,
      title: updated.title,
      userId: updated.userId || '',
      createdAt: updated.createdAt,
      lastMessageAt: updated.lastMessageAt || updated.createdAt,
      archived: Boolean(updated.archived),
    });
  });

  async function archiveEntry(entry) {
    try {
      await ctx.runtime.withSession(entry.sessionId, (client) =>
        client.archiveSession(entry.sessionId),
      );
    } catch (err) {
      ctx.log('warn', 'archiveSession failed', { error: String(err && err.message) });
    }
  }

  app.delete('/api/thread/:id', async (req, res, params) => {
    const entry = await getEntry(ctx.store, home, params.id);
    if (entry && !ownsEntry(entry, req.user)) return ctx.error(res, 404, 'thread not found');
    if (entry) await archiveEntry(entry);
    await removeEntry(ctx.store, home, params.id);
    res.writeHead(204);
    res.end();
  });

  // DELETE /api/thread and DELETE /api/thread?scope=unarchived
  app.delete('/api/thread', async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const unarchivedOnly = url.searchParams.get('scope') === 'unarchived';
    const map = await loadThreads(ctx.store, home);
    for (const [id, entry] of Object.entries(map)) {
      if (!ownsEntry(entry, req.user)) continue;
      if (unarchivedOnly && entry.archived) continue;
      await archiveEntry(entry);
      delete map[id];
    }
    await saveThreads(ctx.store, home, map);
    res.writeHead(204);
    res.end();
  });

  // DELETE /api/thread/messages/{id} -- drop that message and everything after.
  app.delete('/api/thread/messages/:id', async (req, res, params) => {
    const parsed = parseMessageId(params.id);
    if (!parsed) return ctx.error(res, 400, 'invalid message id');
    const owner = await findEntryBySession(ctx.store, home, parsed.sessionId);
    // Fail-closed: refuse when there is no mapping OR the mapping is not the
    // caller's, so a guessed session id can never reach the daemon.
    if (!owner || !ownsEntry(owner, req.user)) return ctx.error(res, 404, 'thread not found');
    try {
      await ctx.runtime.withSession(parsed.sessionId, (client) =>
        client.rewind(parsed.sessionId, parsed.index),
      );
    } catch (err) {
      ctx.log('warn', 'rewind failed', { error: String(err && err.message) });
      return ctx.error(res, 500, 'unable to delete message');
    }
    res.writeHead(204);
    res.end();
  });

  // POST /api/thread/messages/{id}/truncate -- drop everything after that message.
  app.post('/api/thread/messages/:id/truncate', async (req, res, params) => {
    const parsed = parseMessageId(params.id);
    if (!parsed) return ctx.error(res, 400, 'invalid message id');
    const owner = await findEntryBySession(ctx.store, home, parsed.sessionId);
    if (!owner || !ownsEntry(owner, req.user)) return ctx.error(res, 404, 'thread not found');
    try {
      await ctx.runtime.withSession(parsed.sessionId, (client) =>
        client.rewind(parsed.sessionId, parsed.index + 1),
      );
    } catch (err) {
      ctx.log('warn', 'rewind failed', { error: String(err && err.message) });
      return ctx.error(res, 500, 'unable to truncate messages');
    }
    res.writeHead(204);
    res.end();
  });
}

// createThreadForSession -- used by chat.mjs. Registers the mapping after a
// runtime session is created for a fresh Amiro thread id.
export async function createThreadForSession(ctx, { threadId, sessionId, userId, title, workingDir }) {
  const now = ctx.nowIso();
  return upsertEntry(ctx.store, ctx.config.home, threadId, {
    sessionId,
    userId,
    title: title || 'New Chat',
    createdAt: now,
    lastMessageAt: now,
    archived: false,
    ...(workingDir ? { workingDir } : {}),
  });
}

export function newThreadId() {
  return crypto.randomUUID();
}
