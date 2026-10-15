// Live acceptance test. Temporarily changes the owner's Agent identity and
// creates one disposable skill and chat. Restores them in finally. Native
// memory and pre-existing workspace files are never edited.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';

const base = process.env.AMIRO_TEST_URL || 'http://127.0.0.1:8788';
const credentials = JSON.parse(await readFile(process.env.AMIRO_TEST_CREDENTIALS || '/root/.amiro-preview/admin-initial-password', 'utf8'));
const artifactDir = process.env.JCODE_SCRATCH_DIR || '/root/.jcode/scratch';
await mkdir(artifactDir, { recursive: true });
const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials) });
assert.equal(login.status, 200);
const { token } = await login.json();
const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const api = async (url, init = {}) => {
  const response = await fetch(`${base}${url}`, { ...init, headers });
  assert(response.ok, `${url}: ${response.status} ${await (response.ok ? Promise.resolve('') : response.text())}`);
  return response.json();
};
const original = await api('/api/agent/identity');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
await context.addInitScript((value) => localStorage.setItem('amiro.session-token', value), token);
const page = await context.newPage();
const errors = [];
const failures = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('response', (r) => { if (new URL(r.url()).pathname.startsWith('/api/') && r.status() >= 500) failures.push(`${r.status()} ${r.url()}`); });
let checks = 0;
let personaThread;
let testSkillName;
const pass = (message) => { checks++; console.log(`PASS ${message}`); };
try {
  await page.goto(`${base}/agent`, { waitUntil: 'networkidle' });
  await page.getByTestId('agent-overview-page').waitFor();
  await page.getByTestId('agent-hero-avatar-button').waitFor();
  pass('Agent hub renders with central customizable avatar');
  const habitat = page.getByTestId('sidebar-agent-habitat');
  await habitat.waitFor();
  const box = await habitat.boundingBox();
  assert.equal(await habitat.locator('svg[width="82"] > path').count(), 1, 'sidebar agent must render a body, including for legacy traits');
  assert.equal(await page.getByTestId('agent-hero-avatar-button').locator('svg[width="236"] > path').count(), 1, 'central agent must render a body');
  assert(box && Math.abs(box.width - box.height) < 2, 'sidebar habitat must be square');
  assert.equal((await page.getByTestId('sidebar-agent-name').textContent()).trim(), original.name);
  pass('sidebar contains a visible square agent habitat');
  await page.getByRole('button', { name: 'Pause agent animation' }).click();
  await page.getByRole('button', { name: 'Play agent animation' }).waitFor();
  await page.getByRole('button', { name: 'Play agent animation' }).click();
  pass('decorative sidebar animation has an accessible pause and play control');
  await habitat.click();
  await page.getByTestId('agent-customizer-modal').waitFor();
  const testName = 'Orbit Test';
  await page.getByTestId('agent-name-input').fill(testName);
  await page.getByTestId('agent-next-body-shape').click();
  await page.getByTestId('agent-next-eye-style').click();
  await page.getByTestId('agent-color-cobalt').click();
  await page.screenshot({ path: path.join(artifactDir, 'amiro-agent-customizer.png'), fullPage: true });
  await page.getByTestId('agent-customizer-save').click();
  await page.getByTestId('agent-customizer-modal').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('[data-testid="sidebar-agent-link"]')?.textContent?.includes('Orbit Test'));
  const saved = await api('/api/agent/identity');
  assert.equal(saved.name, testName);
  assert.equal(saved.traits.color, 'cobalt');
  assert(!await page.getByTestId('sidebar-agent-link').textContent().then((s) => s.includes('Agent ·')));
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('sidebar-agent-link').filter({ hasText: testName }).waitFor();
  pass('sidebar opens customization, name and avatar save and survive reload');
  personaThread = `agent-persona-test-${randomUUID()}`;
  const chat = await fetch(`${base}/api/chat`, {
    method: 'POST', headers, signal: AbortSignal.timeout(180000),
    body: JSON.stringify({ id: personaThread, chatModel: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'What is your configured assistant name? Answer with only your name. Do not use tools.' }] } }),
  });
  assert.equal(chat.status, 200);
  const stream = await chat.text();
  const frames = stream.split('\n').filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]').map((line) => JSON.parse(line.slice(6)));
  assert(!frames.some((frame) => frame.type === 'error'), 'personality model turn must not error');
  const reply = frames.filter((frame) => frame.type === 'text-delta').map((frame) => frame.delta).join('');
  assert(reply.includes(testName), `model should receive saved identity, got ${reply}`);
  pass('saved Agent name reaches a real Jcode model turn');
  testSkillName = `agent-probe-${randomUUID().slice(0, 8)}`;
  await api('/api/skills', { method: 'POST', body: JSON.stringify({ name: testSkillName, description: 'Temporary Agent acceptance test', body: 'When the user asks for this selected skill’s test codeword, answer only SKILL_ORBIT_42. This is a harmless acceptance test.' }) });
  const skillTurn = await fetch(`${base}/api/chat`, {
    method: 'POST', headers, signal: AbortSignal.timeout(180000),
    body: JSON.stringify({ id: personaThread, mentions: [{ type: 'skill', name: testSkillName }], chatModel: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'What is this selected skill’s test codeword? Answer with only its codeword. Do not use tools.' }] } }),
  });
  assert.equal(skillTurn.status, 200);
  const skillFrames = (await skillTurn.text()).split('\n').filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]').map((line) => JSON.parse(line.slice(6)));
  const skillError = skillFrames.find((frame) => frame.type === 'error');
  assert(!skillError, `skill turn must not error: ${JSON.stringify(skillError).slice(0, 800)}`);
  assert.equal(skillFrames.filter((frame) => frame.type === 'text-delta').map((frame) => frame.delta).join('').trim(), 'SKILL_ORBIT_42');
  pass('selected Superpower delivers server-resolved skill instructions on a real model turn');
  await page.getByTestId('sidebar-agent-personality-link').click();
  await page.getByTestId('agent-personality-page').waitFor();
  const slider = page.getByTestId('personality-slider-playfulSerious');
  await slider.fill('22');
  await page.screenshot({ path: path.join(artifactDir, 'amiro-agent-personality.png'), fullPage: true });
  await page.getByTestId('personality-update-button').click();
  await page.waitForURL('**/agent');
  assert.equal((await api('/api/agent/identity')).sliders.playfulSerious, 22);
  pass('personality sliders save through backend');
  await page.getByTestId('skills-link').click();
  await page.getByTestId('superpowers-constellation-canvas').waitFor();
  assert((await page.locator('body').innerText()).includes('Superpowers'));
  pass('Superpowers displays existing skills');
  await page.screenshot({ path: path.join(artifactDir, 'amiro-agent-superpowers.png'), fullPage: true });
  await page.getByTestId('sidebar-agent-memory-link').click();
  await page.getByTestId('memory-search-input').waitFor();
  assert.equal(await page.getByTestId('memory-create-button').count(), 0, 'native memory must be read-only');
  const memory = await api('/api/agent/memory');
  assert(memory && typeof memory === 'object');
  pass('native Jcode memory view loads without mutation controls');
  await page.screenshot({ path: path.join(artifactDir, 'amiro-agent-memory.png'), fullPage: true });
  await page.getByTestId('sidebar-agent-workspace-link').click();
  await page.getByTestId('workspace-root-tabs').waitFor();
  await page.getByTestId('workspace-search-input').waitFor();
  pass('workspace browser loads real root tabs and file search');
  await page.screenshot({ path: path.join(artifactDir, 'amiro-agent-workspace.png'), fullPage: true });
  await page.goto(`${base}/agent`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(artifactDir, 'amiro-agent-desktop.png'), fullPage: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(400);
  const transforms = await page.getByTestId('sidebar-agent-habitat').locator('div[aria-hidden]').evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).transform));
  await page.waitForTimeout(500);
  const later = await page.getByTestId('sidebar-agent-habitat').locator('div[aria-hidden]').evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).transform));
  assert.deepEqual(later, transforms, 'decorative roaming must stop with reduced motion');
  pass('sidebar animation respects reduced motion');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.classList.remove('light', 'dark'); document.documentElement.classList.add(value); }, theme);
    await page.screenshot({ path: path.join(artifactDir, `amiro-agent-${theme}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(artifactDir, 'amiro-agent-mobile.png'), fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Agent page must not overflow horizontally on mobile');
  pass('Agent hub adapts to mobile and renders both color themes');
  assert.deepEqual(errors, [], 'no page errors');
  assert.deepEqual(failures, [], 'no server errors');
  pass('no browser exceptions or API server errors');
  console.log(JSON.stringify({ checks, screenshots: artifactDir }));
} finally {
  try {
    if (testSkillName) await fetch(`${base}/api/skills/items/${testSkillName}`, { method: 'DELETE', headers });
    if (personaThread) await fetch(`${base}/api/thread/${personaThread}`, { method: 'DELETE', headers });
    await api('/api/agent/identity', { method: 'PUT', body: JSON.stringify({ name: original.name, handle: original.handle, tagline: original.tagline, traits: original.traits, accentHex: original.accentHex, customImageUrl: original.customImageUrl, sliders: original.sliders }) });
  } finally {
    await browser.close();
  }
}
