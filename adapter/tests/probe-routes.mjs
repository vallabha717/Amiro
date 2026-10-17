// Probe: discover how to pin a model to a specific provider route.
import { JcodeClient as AmiroRuntimeClient } from '@1jehuang/jcode-sdk';

const SOCKET = process.env.AMIRO_API_SOCKET || process.env.JCODE_API_SOCKET || '/root/.jcode/scratch/amiro-api.sock';
const candidates = [
  'deepseek-v4.1-flash',
  'opencode-go/deepseek-v4.1-flash',
  'ocg/deepseek-v4.1-flash',
  'openai-compatible:opencode-go/deepseek-v4.1-flash',
  'gemini-3.8-flash-tiered',
  'antigravity/gemini-3.8-flash-tiered',
  'ag/gemini-3.8-flash',
];

const c = await AmiroRuntimeClient.connect({ socketPath: SOCKET, clientName: 'route-probe/1' });
for (const model of candidates) {
  const s = await c.createSession({ workingDir: '/tmp/amiro-probe-ws' });
  const row = { model, setModel: 'ok', provider: null, runtimeModel: null, run: null, endpoint: null };
  try {
    await c.setModel(s.session_id, model);
  } catch (e) {
    row.setModel = String(e.code || e.message);
    console.log(JSON.stringify(row));
    continue;
  }
  try {
    const info = await c.getRuntimeInfo(s.session_id);
    row.provider = info.provider;
    row.runtimeModel = info.model;
  } catch (e) {
    row.provider = `ERR ${e.message}`;
  }
  try {
    const turn = await c.run(s.session_id, 'Reply with exactly OK');
    row.run = JSON.stringify(turn.text);
  } catch (e) {
    row.run = 'ERROR';
    const m = /endpoint:\s*(\S+)/.exec(String(e.message));
    row.endpoint = m ? m[1] : String(e.message).slice(0, 120);
  }
  console.log(JSON.stringify(row));
}
await c.close();
