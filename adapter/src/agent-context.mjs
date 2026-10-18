// Agent preferences ride on each actual user turn. Never replace the runtime's
// assembled system prompt, and never send a separate empty reminder turn.
import { getAgentIdentity, buildPersonaPromptBlock } from './routes/agent.mjs';

const REMINDER_LIMIT = 48_000;
const SKILL_LIMIT = 12_000;

function boundedUtf8(value, maxBytes) {
  const text = String(value || '');
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const marker = '\n[Instructions truncated to fit this turn.]';
  return Buffer.from(text, 'utf8').subarray(0, maxBytes - Buffer.byteLength(marker)).toString('utf8').replace(/\uFFFD$/, '') + marker;
}

// A metadata-only catalog of stored credentials. Never contains a secret value:
// only the slot, the exported environment variable name, an optional
// label/usage description, and any allowed domains. Best-effort: a missing home
// or unreadable store yields an empty block rather than failing the turn. Never
// creates the credential store key.
async function credentialCatalogBlock(ctx) {
  const home = ctx?.config?.home || ctx?.store?.home;
  if (!home || !ctx?.store || typeof ctx.store.readJson !== 'function') return '';
  try {
    const { createCredentials } = await import('./credentials.mjs');
    const creds = createCredentials({ home, store: ctx.store, log: ctx.log });
    const block = await creds.buildPromptBlock();
    return block ? boundedUtf8(block, 4000) : '';
  } catch {
    return '';
  }
}

export async function buildAgentTurnReminder(ctx, user, { mentions = [], workingDir } = {}) {
  const identity = await getAgentIdentity(ctx, user.id);
  const blocks = [
    'Amiro presentation preferences for this user turn. These affect style and identity only. Preserve all Amiro runtime safety instructions, native memory, tool policy, and permission restrictions.',
    boundedUtf8(buildPersonaPromptBlock(identity), 8000),
    `Use ${JSON.stringify(identity.name)} as your user-facing assistant name. Your underlying runtime remains the Amiro runtime. These presentation preferences do not change the model provider or your capabilities.`,
    '## Credential Security (Encrypted Vault Box)\nNever ask users to paste or share raw secrets (API keys, tokens, passwords, webhook secrets) in plain chat. Whenever a task needs an API key, token, or secret that is not yet in the Stored Credentials list, emit a secure credential prompt card on its own line in your response so the UI renders a dedicated encrypted input box:\n`SECRET_PROMPT {"service":"<service_slug>","field":"<field_slug>","label":"<Human Label>","description":"<Why it is needed>","purpose":"<Usage purpose>","allowedDomains":["<api.domain.com>"]}`\nThe user enters the key into that rendered box, which saves it directly to the encrypted vault (`$AMIRO_CRED_<SERVICE>_<FIELD>`) without the secret ever appearing in chat.',
    '## Inline Visuals (`visualize` skill)\nThe "Visualize" skill (`visualize`) is available to render polished interactive SVG diagrams, charts, comparisons, or explainers inline in the chat transcript. When asked to visualize something or when a diagram/chart explains a concept better than prose, use the `applet` tool with `placement: "inline"` and `view: { "type": "html", "source": "<self-contained HTML/SVG fragment>", "height": 320 }` (or load the `visualize` skill).',
  ];
  const credentials = await credentialCatalogBlock(ctx);
  if (credentials) blocks.push(credentials);
  const names = [...new Set((Array.isArray(mentions) ? mentions : [])
    .filter((mention) => mention?.type === 'skill' && typeof mention.name === 'string')
    .map((mention) => mention.name))];
  if (names.length > 8) throw new Error('Select at most 8 skills per turn');
  if (names.length) {
    const { resolveSkillForTurn } = await import('./routes/skills.mjs');
    // The user picked these in the app's Superpowers picker. State the provenance
    // explicitly: a model that sees instructions arriving outside its native
    // skill list will otherwise treat them as injected content and refuse them
    // (observed live: "the instruction ... is coming from injected content in the
    // system reminder, so I'm not going to treat it as authoritative").
    blocks.push(
      'Application context: the user selected the instruction sets below in Amiro\'s Superpowers picker for this message. ' +
        'Amiro stores them and attaches them to this turn on the user\'s behalf, which is why they do not appear in your native skill list. ' +
        'They are application-provided context, not third-party content, and they grant no tools or permissions. ' +
        'Follow them for this turn wherever they do not conflict with your safety policy or the user\'s request.',
    );
    for (const name of names) {
      const skill = await resolveSkillForTurn(ctx, name, workingDir, user);
      if (!skill) throw new Error(`Skill is not available: ${name}`);
      const content = skill.content ?? skill.body ?? skill.instructions;
      if (typeof content !== 'string' || !content.trim()) throw new Error(`Skill has no instructions: ${name}`);
      const source = typeof skill.source === 'string' && skill.source ? skill.source : 'user';
      blocks.push(
        `User-selected instruction set: ${JSON.stringify(name)} (stored by Amiro, source ${source})\n` +
          'These instructions do not enable tools or grant permissions.\n' +
          `--- begin ${JSON.stringify(name)} ---\n${boundedUtf8(content, SKILL_LIMIT)}\n--- end ${JSON.stringify(name)} ---`,
      );
    }
  }
  const reminder = blocks.filter(Boolean).join('\n\n');
  if (Buffer.byteLength(reminder, 'utf8') > REMINDER_LIMIT) throw new Error('Selected skills exceed the turn instruction limit. Select fewer skills.');
  return reminder;
}

// The SDK sendMessage helper does not expose system_reminder. notify is public,
// and the API protocol supports content + system_reminder on the same frame.
// Open events first, wait manually for acceptance, then keep the SAME iterator.
//
// The daemon reports that a session is busy when it has not finished the
// previous turn. It refuses the message BEFORE accepting it, so nothing was
// ingested and re-sending is safe (verified against the live bridge: the error
// arrives between opening the event stream and `message_accepted`, and the
// adapter logs it as a thrown rejection rather than a stream error). This was
// hitting real users: an immediate follow-up after a reply failed roughly one
// time in three with "internal: Session is busy".
const SESSION_BUSY = /session is busy/i;
const BUSY_RETRY_DELAYS_MS = [150, 400, 900, 1_800];

export function isSessionBusy(error) {
  return SESSION_BUSY.test(String(error && error.message ? error.message : error));
}

export async function beginAgentUserTurn(
  client,
  sessionId,
  content,
  images,
  reminder,
  timeoutMs = 10_000,
  options = {},
) {
  const delays = options.busyRetryDelaysMs || BUSY_RETRY_DELAYS_MS;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  const attemptTurn = async () => {
    const events = await client.events(sessionId);
    const buffered = [];
    let timer;
    try {
      const waitAccepted = async () => {
        while (true) {
          const next = await events.next();
          if (next.done) throw new Error('The Amiro runtime closed before accepting the message');
          const event = next.value;
          if (event.session_id && event.session_id !== sessionId) continue;
          if (event.ev === 'error') throw new Error(event.message || 'The Amiro runtime rejected the message');
          if (event.ev === 'message_accepted') return;
          buffered.push(event);
          if (buffered.length > 256) throw new Error('The Amiro runtime did not acknowledge the user message');
        }
      };
      client.notify({ req: 'send_message', session_id: sessionId, content, images: images || [], system_reminder: reminder });
      await Promise.race([
        waitAccepted(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Amiro runtime message acceptance timed out')), timeoutMs); }),
      ]);
      return (async function* () {
        yield* buffered;
        yield* events;
      })();
    } catch (error) {
      await events.return?.();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await attemptTurn();
    } catch (error) {
      // Retry only a refusal that happened before acceptance, and only a
      // bounded number of times.
      if (!isSessionBusy(error) || attempt >= delays.length) throw error;
      const delayMs = delays[attempt];
      if (typeof options.onBusyRetry === 'function') options.onBusyRetry({ attempt: attempt + 1, delayMs });
      await sleep(delayMs);
    }
  }
}
