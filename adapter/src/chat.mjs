// adapter/src/chat.mjs -- POST /api/chat, /api/chat/temporary, /api/chat/title,
// /api/chat/export, /api/chat/openai-realtime.
//
// All model output is the Vercel AI SDK UI Message Stream over SSE, emitted by
// ctx.sse(res) (see server.mjs; byte-shape mirrors
// backend-go/internal/ai/uimessage/stream.go).
//
// Permission policy (contract correction, verified against the live bridge):
// the bridge does NOT advertise the `permissions` capability, so
// `permission_request` events never arrive and a turn must never block waiting
// for one. When `permissionMode` is "auto" or "edit" the turn runs normally
// (jcode's own tool policy applies). For any other mode the adapter does not
// stall: it ends the stream immediately with a text part telling the user to
// use auto/edit mode.

import crypto from 'node:crypto';

import {
  createThreadForSession,
  getEntry,
  upsertEntry,
  historyToMessages,
  ownsEntry,
} from './threads.mjs';
import { assertUsableProjectDirectory } from './fsbrowse.mjs';
import { buildAgentTurnReminder, beginAgentUserTurn } from './agent-context.mjs';

const TURN_TIMEOUT_MS = 15 * 60 * 1000;

// A session is created for a specific folder. The daemon echoes the directory it
// actually used (`working_dir`); if that differs from what the user picked, the
// turn must fail loudly instead of running in another folder. Older bridges that
// omit the field are tolerated, with a warning.
function assertSessionWorkingDir(ctx, session, requested) {
  if (!requested) return;
  const applied = session && (session.working_dir || session.workingDir);
  if (!applied) {
    ctx.log('warn', 'session did not report a working directory', {
      sessionId: session && session.session_id,
      requested,
    });
    return;
  }
  const a = String(applied).replace(/\/+$/, '');
  const b = String(requested).replace(/\/+$/, '');
  if (a !== b) {
    const err = new Error(`session started in ${applied} instead of the selected folder ${requested}`);
    err.status = 500;
    err.code = 'working_dir_mismatch';
    throw err;
  }
}

// ---------------------------------------------------------------------------
// UIMessage helpers
// ---------------------------------------------------------------------------

function partsOf(message) {
  if (!message || !Array.isArray(message.parts)) return [];
  return message.parts;
}

function extractText(message) {
  return partsOf(message)
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

// Tool-result parts arriving on a re-POST after a tool card was answered. The
// AI SDK writes them as `tool-<name>` parts in state "output-available" with a
// `toolCallId` and an `output`.
function extractToolResults(message) {
  return partsOf(message)
    .filter(
      (p) =>
        p &&
        typeof p.type === 'string' &&
        (p.type.startsWith('tool-') || p.type === 'dynamic-tool') &&
        p.state === 'output-available' &&
        p.toolCallId,
    )
    .map((p) => ({ toolCallId: p.toolCallId, output: serializeOutput(p.output) }));
}

function serializeOutput(output) {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

// Convert attachment entries to jcode ImageAttachment [mediaType, base64] when
// they carry an inline data URL; anything else is appended to the prompt text
// as a URL reference.
function splitAttachments(attachments) {
  const images = [];
  const extraText = [];
  for (const att of attachments || []) {
    const url = att && att.url;
    if (!url) continue;
    const dataMatch = /^data:([^;,]+);base64,(.+)$/.exec(url);
    if (dataMatch) {
      images.push([att.mediaType || dataMatch[1], dataMatch[2]]);
    } else {
      extraText.push(`[attachment: ${url}]`);
    }
  }
  return { images, extraText };
}

function deriveTitle(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return 'New Chat';
  return t.length > 60 ? `${t.slice(0, 57)}...` : t;
}

// Session tool policy. The dedicated preview bridge does not apply
// `--tool-profile` to sessions it creates, so EVERY session this adapter makes
// is configured explicitly here -- at creation and again before every turn.
//
// Default is NO tools (text assistant only) for the public preview: `read`/`ls`
// can expose credential files and web fetch/search are out of scope, so no tool
// is safe until sandbox-aware handlers exist. The only escape is a trusted
// local operator setting BOTH AMIRO_TRUSTED_OPERATOR=1 and AMIRO_TOOL_PROFILE=full
// (deployment never sets these).
export function toolProfile() {
  const trusted = process.env.AMIRO_TRUSTED_OPERATOR === '1';
  if (trusted && process.env.AMIRO_TOOL_PROFILE === 'full') return null; // inherit daemon defaults
  return [];
}

// Value to pass as createSession({ tools }) / configureTools({enabled}).
export function toolsOption() {
  return { enabled: toolProfile() };
}

// Whether the current profile actually exposes tools: null = inherit (yes),
// [] = none (no), non-empty allow-list = yes.
export function toolsEnabled() {
  const profile = toolProfile();
  return profile === null || profile.length > 0;
}

// Explicitly (re)apply the tool policy. configureTools requires an idle
// session; callers do this before sending the turn. FAIL-CLOSED: a failure
// propagates so the turn is aborted rather than sent with unknown tools.
export async function applyToolProfile(client, sessionId) {
  await client.configureTools(sessionId, toolsOption());
  return true;
}

// Enforce the tool policy on a session and record the profile on the thread
// mapping (observability only). Tool control from the chat payload (mentions,
// allowedMcpServers, allowedAppDefaultToolkit) is deliberately ignored: a
// client may not widen its own tool access. Throws on failure (fail-closed).
async function enforceToolPolicy(ctx, client, threadId, sessionId, entry) {
  const profile = toolProfile();
  await applyToolProfile(client, sessionId);
  if (threadId) {
    await upsertEntry(ctx.store, ctx.config.home, threadId, {
      toolsProfile: profile === null ? 'inherit' : profile.length ? 'safe' : 'none',
    });
  }
}

// ---------------------------------------------------------------------------
// Turn streaming
// ---------------------------------------------------------------------------

// Stream one jcode turn into the SSE response until `turn_done`/`turn_stopped`
// or timeout. Returns the collected usage (if any).
async function streamTurn({ ctx, sse, client, sessionId, allowTools, iterator }) {
  const textId = crypto.randomUUID();
  const reasoningId = crypto.randomUUID();
  let textOpen = false;
  let reasoningOpen = false;
  let usage = null;

  const iter = iterator || await client.events(sessionId);
  const closeText = () => {
    if (textOpen) {
      sse.textEnd(textId);
      textOpen = false;
    }
  };
  const closeReasoning = () => {
    if (reasoningOpen) {
      sse.reasoningEnd(reasoningId);
      reasoningOpen = false;
    }
  };

  let timedOut = false;
  const consume = (async () => {
    for await (const ev of iter) {
      if (ev && ev.session_id && ev.session_id !== sessionId) continue;
      switch (ev.ev) {
        case 'text_delta':
          if (!textOpen) {
            sse.textStart(textId);
            textOpen = true;
          }
          sse.textDelta(textId, ev.text || '');
          break;
        case 'text_replace':
          if (!textOpen) {
            sse.textStart(textId);
            textOpen = true;
          }
          sse.textDelta(textId, ev.text || '');
          break;
        case 'text_done':
          closeText();
          break;
        case 'reasoning_delta':
          if (!reasoningOpen) {
            sse.reasoningStart(reasoningId);
            reasoningOpen = true;
          }
          sse.reasoningDelta(reasoningId, ev.text || '');
          break;
        case 'reasoning_done':
          closeReasoning();
          break;
        case 'tool_start':
          sse.toolInputStart(ev.call_id, ev.name);
          break;
        case 'tool_input_delta':
          sse.toolInputDelta(ev.call_id, ev.delta || '');
          break;
        case 'tool_call':
          sse.toolInputAvailable(ev.call_id, ev.name, ev.input);
          break;
        case 'tool_done':
          if (ev.error) sse.toolOutputError(ev.call_id, ev.error);
          else sse.toolOutputAvailable(ev.call_id, ev.output);
          break;
        case 'token_usage':
          usage = {
            promptTokens: ev.input,
            completionTokens: ev.output,
            totalTokens: (ev.input || 0) + (ev.output || 0),
          };
          break;
        case 'permission_request':
          // The live bridge does not advertise `permissions`, so this should
          // never arrive. If it somehow does, never stall: allow it when tools
          // are permitted, otherwise just ignore it.
          if (allowTools) {
            try {
              await client.respondToPermission(sessionId, ev.request_id, 'allow');
            } catch {
              /* ignore */
            }
          }
          break;
        case 'turn_stopped':
          if (ev.message) sse.error(ev.message);
          return;
        case 'turn_done':
          return;
        case 'error':
          sse.error(ev.message || 'jcode error');
          break;
        default:
          break;
      }
    }
  })();

  const timeout = new Promise((resolve) => {
    const id = setTimeout(() => {
      timedOut = true;
      resolve();
    }, TURN_TIMEOUT_MS);
    consume.then(
      () => clearTimeout(id),
      () => clearTimeout(id),
    );
  });

  await Promise.race([consume.catch((err) => sse.error(String(err && err.message))), timeout]);
  if (timedOut) {
    try {
      await iter.return?.();
    } catch {
      /* ignore */
    }
  }
  closeReasoning();
  closeText();
  return usage;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function register(app, ctx) {
  const home = ctx.config.home;

  app.post('/api/chat', async (req, res) => {
    const body = await ctx.readJson(req);
    const user = ctx.requireUser(req);
    const threadId = body.id || body.threadId;
    if (!threadId) return ctx.error(res, 400, 'id is required');

    // Resolve requested working directory (frontend may send workingDir or projectDirectory).
    // When present, validate explicitly; on failure return error (never silently fall back).
    const rawWorkingDir = body.workingDir || body.projectDirectory || body.workspaceRoot || null;
    let validatedWorkingDir = null;
    if (rawWorkingDir) {
      try {
        const v = await assertUsableProjectDirectory(String(rawWorkingDir));
        validatedWorkingDir = v.resolvedPath;
      } catch (err) {
        return ctx.error(res, err.status || 400, err.message || 'invalid working directory');
      }
    }

    const hasTools = toolsEnabled();
    const permissionMode = body.permissionMode ?? 'auto';
    // With no tools (the public preview default) there is nothing to approve, so
    // every permission mode is accepted and the turn runs as plain text. Only
    // when tools are enabled do we require auto/edit (never stall on a
    // permission event the bridge does not emit).
    const modeOk = !hasTools || permissionMode === 'auto' || permissionMode === 'edit';

    const responseId = crypto.randomUUID();
    const sse = ctx.sse(res);
    sse.start(responseId);

    if (!modeOk) {
      sse.startStep();
      sse.textStart(responseId);
      sse.textDelta(
        responseId,
        'This backend runs tools automatically. Switch the permission mode to "auto" (or "edit") to start the turn.',
      );
      sse.textEnd(responseId);
      sse.finishStep();
      sse.finish(null);
      sse.done();
      return;
    }

    const message = body.message || {};
    const userText = extractText(message);
    const toolResults = extractToolResults(message);
    const { images, extraText } = splitAttachments(body.attachments);
    const prompt = [userText, ...extraText].filter(Boolean).join('\n');

    // A selected skill contributes instructions only. Client tool/MCP lists
    // still cannot widen access. Native Jcode system assembly stays intact.
    // The default model is provider-qualified, never a legacy daemon fallback.
    const cm = body.chatModel || {};
    const requestedModel = ctx.jcode.resolveChatModel(cm.provider, cm.model);

    // Fail fast (and without creating a session) for a model outside the
    // pinned allow-list. No fallback to another model is attempted.
    if (requestedModel) {
      try {
        ctx.jcode.assertModelAllowed(requestedModel);
      } catch (err) {
        sse.error(String(err && err.message ? err.message : err));
        sse.finish(null);
        sse.done();
        return;
      }
    }

    try {
      await ctx.jcode.withIsolated(async (client) => {
        // Resolve (or create) the jcode session backing this thread.
        let entry = await getEntry(ctx.store, home, threadId);
        if (entry && !ownsEntry(entry, user)) {
          const err = new Error('thread not found');
          err.status = 404;
          throw err;
        }
        let created = false;
        if (!entry || !entry.sessionId) {
          const wd = validatedWorkingDir || ctx.config.workspaceDir;
          const session = await ctx.jcode.createSession(client, {
            workingDir: wd,
            tools: toolsOption(),
          });
          // The daemon echoes the directory it actually used. Refuse to continue
          // in a different folder than the user picked rather than silently
          // running somewhere else.
          assertSessionWorkingDir(ctx, session, wd);
          entry = await createThreadForSession(ctx, {
            threadId,
            sessionId: session.session_id,
            userId: user.id,
            title: deriveTitle(userText),
            ...(validatedWorkingDir ? { workingDir: validatedWorkingDir } : {}),
          });
          created = true;
        }
        // If the validated directory differs from the stored one and the thread
        // already has a session, the existing session was created with the old
        // workingDir and cannot be moved. Start a NEW jcode session pinned to
        // the new directory for the same thread (keep threadId/ownership, replace
        // sessionId). Archive the previous session rather than deleting its history
        // so it stays reachable but is no longer the active root.
        if (validatedWorkingDir && entry && entry.sessionId && entry.workingDir !== validatedWorkingDir) {
          // For threads that had no workingDir stored (legacy, defaults to
          // ctx.config.workspaceDir), entry.workingDir will be undefined; we
          // still need to rotate if the requested dir differs from the effective
          // previous one. Normalize previous effective dir for that case.
          const prevEffective = entry.workingDir || ctx.config.workspaceDir;
          if (prevEffective !== validatedWorkingDir) {
            const prevSessionId = entry.sessionId;
            const newSession = await ctx.jcode.createSession(client, {
              workingDir: validatedWorkingDir,
              tools: toolsOption(),
            });
            assertSessionWorkingDir(ctx, newSession, validatedWorkingDir);
            // Persist new mapping before archiving old, so we never lose the thread
            // if archiving fails. Keep previousSessionId for traceability.
            await upsertEntry(ctx.store, home, threadId, {
              sessionId: newSession.session_id,
              workingDir: validatedWorkingDir,
              previousSessionId: prevSessionId,
            });
            entry = { ...entry, sessionId: newSession.session_id, workingDir: validatedWorkingDir, previousSessionId: prevSessionId };
            created = true;
            // Best-effort: archive previous session so its history is not lost but
            // it is no longer attached to the thread. Never fail the turn on this.
            try {
              await client.detachSession(prevSessionId);
            } catch {}
            try {
              await client.archiveSession(prevSessionId);
            } catch (err) {
              ctx.log('warn', 'archive previous session after workingDir change failed', { error: String(err && err.message) });
            }
          } else {
            // Validated equals effective previous -- just ensure workingDir persisted
            if (entry.workingDir !== validatedWorkingDir) {
              await upsertEntry(ctx.store, home, threadId, { workingDir: validatedWorkingDir });
              entry = { ...entry, workingDir: validatedWorkingDir };
            }
          }
        } else if (validatedWorkingDir && entry && entry.workingDir !== validatedWorkingDir) {
          // Edge: entry has no sessionId (should have been handled above) but still persist
          await upsertEntry(ctx.store, home, threadId, { workingDir: validatedWorkingDir });
          entry = { ...entry, workingDir: validatedWorkingDir };
        }
        const sessionId = entry.sessionId;

        // Attach ONLY an existing session: a just-created, not-yet-persisted
        // session is dropped by a redundant attach ("Failed to restore session").
        if (!created) {
          await ctx.jcode.attach(client, sessionId);
        }

        await enforceToolPolicy(ctx, client, threadId, sessionId, entry);

        if (requestedModel) {
          // No fallback: a refused model or a failed route pin aborts the turn
          // rather than silently continuing on the session default.
          await ctx.jcode.setModelPinned(client, sessionId, requestedModel);
        }

        let iterator;
        if (toolResults.length) {
          for (const tr of toolResults) {
            try {
              await client.submitToolResult(sessionId, tr.toolCallId, tr.output);
            } catch (err) {
              ctx.log('warn', 'submitToolResult failed', { error: String(err && err.message) });
            }
          }
        } else {
          const reminder = await buildAgentTurnReminder(ctx, user, {
            mentions: body.mentions,
            workingDir: entry.workingDir || ctx.config.workspaceDir,
          });
          iterator = await beginAgentUserTurn(client, sessionId, prompt, images, reminder);
        }

        sse.startStep();
        const usage = await streamTurn({ ctx, sse, client, sessionId, allowTools: hasTools, iterator });
        sse.finishStep();

        await upsertEntry(ctx.store, home, threadId, {
          lastMessageAt: ctx.nowIso(),
          title: entry.title && entry.title !== 'New Chat' ? entry.title : deriveTitle(userText),
        });

        sse.finish(usage ? { usage, chatModel: cm, model: requestedModel } : { chatModel: cm, model: requestedModel });
        sse.done();
      });
    } catch (err) {
      ctx.log('error', 'chat turn failed', { error: String(err && err.message) });
      if (sse.open) {
        sse.error(String(err && err.message ? err.message : err));
        sse.finish(null);
        sse.done();
      }
    }
  });

  app.post('/api/chat/temporary', async (req, res) => {
    const body = await ctx.readJson(req);
    const user = ctx.requireUser(req);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const last = [...messages].reverse().find((m) => m && m.role === 'user');
    const userText = extractText(last) || extractText(messages[messages.length - 1]);

    const responseId = crypto.randomUUID();
    const sse = ctx.sse(res);
    sse.start(responseId);

    try {
      await ctx.jcode.withIsolated(async (client) => {
        const session = await ctx.jcode.createSession(client, {
          workingDir: ctx.config.workspaceDir,
          tools: toolsOption(),
        });
        const sessionId = session.session_id;
        try {
          await enforceToolPolicy(ctx, client, null, sessionId, null);
          const cm = body.chatModel || {};
          const requestedModel = ctx.jcode.resolveChatModel(cm.provider, cm.model);
          if (requestedModel) {
            await ctx.jcode.setModelPinned(client, sessionId, requestedModel);
          }
          const baseReminder = await buildAgentTurnReminder(ctx, user, { workingDir: ctx.config.workspaceDir });
          const instructions = typeof body.instructions === 'string' ? body.instructions.slice(0, 8000) : '';
          const iterator = await beginAgentUserTurn(client, sessionId, userText || '', [], [baseReminder, instructions].filter(Boolean).join('\n\n'));
          sse.startStep();
          await streamTurn({ ctx, sse, client, sessionId, allowTools: toolsEnabled(), iterator });
          sse.finishStep();
          sse.finish(null);
          sse.done();
        } finally {
          try {
            await client.detachSession(sessionId);
          } catch {
            /* ignore */
          }
          try {
            await client.archiveSession(sessionId);
          } catch {
            /* ignore */
          }
        }
      });
    } catch (err) {
      ctx.log('error', 'temporary turn failed', { error: String(err && err.message) });
      if (sse.open) {
        sse.error(String(err && err.message ? err.message : err));
        sse.finish(null);
        sse.done();
      }
    }
  });

  app.post('/api/chat/title', async (req, res) => {
    const body = await ctx.readJson(req);
    const user = ctx.requireUser(req);
    const threadId = body.threadId;
    const message = body.message || 'hello';

    const entry = threadId ? await getEntry(ctx.store, home, threadId) : null;
    if (entry && !ownsEntry(entry, user)) return ctx.error(res, 404, 'thread not found');

    const responseId = crypto.randomUUID();
    const sse = ctx.sse(res);
    sse.start(responseId);
    sse.startStep();
    sse.textStart(responseId);

    let title = '';
    try {
      title = await ctx.jcode.withIsolated(async (client) => {
        // Generate in a throwaway session so the title prompt never enters the
        // user's conversation transcript.
        const session = await ctx.jcode.createSession(client, {
          workingDir: ctx.config.workspaceDir,
          tools: toolsOption(),
        });
        try {
          await enforceToolPolicy(ctx, client, null, session.session_id, null);
          const cm = body.chatModel || {};
          const requestedModel = ctx.jcode.resolveChatModel(cm.provider, cm.model);
          if (requestedModel) {
            await ctx.jcode.setModelPinned(client, session.session_id, requestedModel);
          }
          const result = await client.run(
            session.session_id,
            `Write a concise title (at most 6 words, no quotes, no trailing punctuation) for a conversation that begins with this message:\n\n${message}`,
          );
          return String(result.text || '').trim();
        } finally {
          try {
            await client.detachSession(session.session_id);
          } catch {
            /* ignore */
          }
          try {
            await client.archiveSession(session.session_id);
          } catch {
            /* ignore */
          }
        }
      });
    } catch (err) {
      ctx.log('warn', 'title generation failed', { error: String(err && err.message) });
    }

    if (title) {
      sse.textDelta(responseId, title);
      if (entry) {
        try {
          await ctx.jcode.withSession(entry.sessionId, (client) =>
            client.renameSession(entry.sessionId, title),
          );
        } catch (err) {
          ctx.log('warn', 'renameSession failed', { error: String(err && err.message) });
        }
        await upsertEntry(ctx.store, home, threadId, { title });
      }
    }
    sse.textEnd(responseId);
    sse.finishStep();
    sse.finish(null);
    sse.done();
  });

  // Bare JSON string id, not an object -- the export popup uses the body
  // directly as the id (see _recon-frontend-api.md). Stored in
  // $AMIRO_HOME/store/exports.json; worker 2's GET /api/export reads the same
  // file. Entry shape:
  //   { id, title, exporterId, originalThreadId, threadId, createdAt,
  //     expiresAt?, messages, commentCount }
  app.post('/api/chat/export', async (req, res) => {
    const body = await ctx.readJson(req);
    const user = ctx.requireUser(req);
    const threadId = body.threadId;
    const entry = threadId ? await getEntry(ctx.store, home, threadId) : null;
    if (entry && !ownsEntry(entry, user)) return ctx.error(res, 404, 'thread not found');

    let messages = [];
    if (entry) {
      try {
        const history = await ctx.jcode.withSession(entry.sessionId, (client) =>
          client.getHistory(entry.sessionId),
        );
        messages = historyToMessages(threadId, entry.sessionId, history);
      } catch (err) {
        ctx.log('warn', 'export history failed', { error: String(err && err.message) });
        return ctx.error(res, 500, 'unable to read thread history');
      }
    }

    const id = crypto.randomUUID();
    const record = {
      id,
      title: (entry && entry.title) || 'Chat Export',
      exporterId: user.id,
      originalThreadId: threadId || null,
      threadId: threadId || null,
      createdAt: ctx.nowIso(),
      expiresAt: body.expiresAt || null,
      messages,
      commentCount: 0,
    };
    await ctx.store.update('exports.json', {}, (doc) => {
      const out = doc && typeof doc === 'object' ? doc : {};
      out[id] = record;
      return out;
    });

    const payload = JSON.stringify(id);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  });

  app.post('/api/chat/openai-realtime', async (req, res) => {
    ctx.requireUser(req);
    ctx.error(res, 501, 'not supported on jcode backend');
  });
}
