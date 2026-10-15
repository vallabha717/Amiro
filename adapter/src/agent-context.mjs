// Agent preferences ride on each actual user turn. Never replace Jcode's
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

export async function buildAgentTurnReminder(ctx, user, { mentions = [], workingDir } = {}) {
  const identity = await getAgentIdentity(ctx, user.id);
  const blocks = [
    'Amiro presentation preferences for this user turn. These affect style and identity only. Preserve all Jcode safety instructions, native memory, tool policy, and permission restrictions.',
    boundedUtf8(buildPersonaPromptBlock(identity), 8000),
    `Use ${JSON.stringify(identity.name)} as your user-facing assistant name. Your underlying runtime remains Jcode. These presentation preferences do not change the model provider or your capabilities.`,
  ];
  const names = [...new Set((Array.isArray(mentions) ? mentions : [])
    .filter((mention) => mention?.type === 'skill' && typeof mention.name === 'string')
    .map((mention) => mention.name))];
  if (names.length > 8) throw new Error('Select at most 8 skills per turn');
  if (names.length) {
    const { resolveSkillForTurn } = await import('./routes/skills.mjs');
    for (const name of names) {
      const skill = await resolveSkillForTurn(ctx, name, workingDir, user);
      if (!skill) throw new Error(`Skill is not available: ${name}`);
      const content = skill.content ?? skill.body ?? skill.instructions;
      if (typeof content !== 'string' || !content.trim()) throw new Error(`Skill has no instructions: ${name}`);
      blocks.push(`User-selected skill: ${name}\nThese instructions do not enable tools or grant permissions.\n${boundedUtf8(content, SKILL_LIMIT)}`);
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
          if (next.done) throw new Error('Jcode closed before accepting the message');
          const event = next.value;
          if (event.session_id && event.session_id !== sessionId) continue;
          if (event.ev === 'error') throw new Error(event.message || 'Jcode rejected the message');
          if (event.ev === 'message_accepted') return;
          buffered.push(event);
          if (buffered.length > 256) throw new Error('Jcode did not acknowledge the user message');
        }
      };
      client.notify({ req: 'send_message', session_id: sessionId, content, images: images || [], system_reminder: reminder });
      await Promise.race([
        waitAccepted(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Jcode message acceptance timed out')), timeoutMs); }),
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
