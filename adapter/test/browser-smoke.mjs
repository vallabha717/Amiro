import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';

const base = process.env.AMIRO_TEST_URL || 'http://127.0.0.1:8788';
const credentials = JSON.parse(await readFile(process.env.AMIRO_TEST_CREDENTIALS || '/root/.amiro-preview/admin-initial-password', 'utf8'));
const artifactDir = process.env.JCODE_SCRATCH_DIR || '/root/.jcode/scratch';
await mkdir(artifactDir, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
const apiFailures = [];
let chatRequests = 0;
let createdThread;
page.on('request', (request) => {
  if (new URL(request.url()).pathname === '/api/chat' && request.method() === 'POST') chatRequests += 1;
});
page.on('pageerror', (error) => errors.push(error.message));
page.on('response', (response) => {
  const u = new URL(response.url());
  if (u.pathname.startsWith('/api/') && response.status() >= 500) apiFailures.push(`${response.status()} ${u.pathname}`);
});
try {
  // A check only counts when it actually ran: one step (workspace trust) is
  // conditional, so the reported total must be counted, never hardcoded.
  let checks = 0;
  const pass = (message) => {
    checks += 1;
    console.log(`PASS ${message}`);
  };
  await page.goto(`${base}/sign-in`, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('a[href="/sign-up"]').count(), 0, 'Closed registration must not advertise sign-up');
  await page.getByTestId('signin-email-input').fill(credentials.email);
  await page.getByTestId('signin-password-input').fill(credentials.password);
  await page.getByTestId('signin-submit-button').click();
  await page.waitForURL('**/onboarding', { timeout: 20000 });
  await page.getByTestId('onboarding-runtime-notice').waitFor();
  await page.getByTestId('login-panel').waitFor();
  pass('browser owner sign-in and honest onboarding');
  await page.getByTestId('onboarding-skip-button').click();
  await page.waitForURL(`${base}/`, { timeout: 20000 });
  // Provider connection lives in the admin panel now, so the chat opens the
  // same panel through the /login composer command only (never a visible button,
  // and never as a model request).
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.fill('/login');
  await page.getByTestId('chat-send-button').click();
  await page.getByTestId('login-panel').waitFor({ timeout: 20000 });
  assert.equal(chatRequests, 0, '/login must not be sent to the model');
  pass('chat /login opens the provider panel without a model request');
  assert.equal(await page.getByTestId('connect-provider-button').count(), 0, 'the chat window must not show a connect-provider button');
  // Every provider Jcode supports must be listed with its real mechanism.
  const providerCountText = await page.locator('[data-testid="login-panel"]').innerText();
  const providerCount = Number((/(\d+)\s+providers/i.exec(providerCountText) || [])[1] || 0);
  assert(providerCount > 30, `provider catalog should list every Jcode provider, saw ${providerCount}`);
  await page.getByTestId('login-provider-select').click();
  const optionCount = await page.getByRole('option').count();
  assert(optionCount > 30, `provider select should offer every provider, saw ${optionCount} options`);
  const optionText = await page.locator('[role="listbox"]').innerText();
  assert(/\bOAuth\b/.test(optionText), 'the provider list must label its OAuth providers');
  assert(/API key/i.test(optionText), 'the provider list must label its API-key providers');
  assert(/Device code/i.test(optionText) || /Local\b/.test(optionText) || /CLI/.test(optionText), 'other real mechanisms must be labelled too');
  await page.getByRole('option').filter({ hasText: 'Antigravity' }).click();
  pass(`provider catalog lists ${providerCount} providers with OAuth and API-key mechanisms`);
  await page.getByTestId('login-oauth-start').click();
  await page.getByTestId('login-oauth-cancel').waitFor({ timeout: 20000 });
  pass('real provider OAuth initiation UI (no credential exchange)');
  await page.getByTestId('login-oauth-cancel').click();
  await page.getByTestId('login-oauth-start').waitFor({ timeout: 20000 });
  await page.getByTestId('login-panel-close').click();
  pass('OAuth cancellation without changing credentials');
  // Model selector must offer models from every connected provider.
  await page.getByTestId('model-selector-button').click();
  await page.getByTestId('model-selector-popover').waitFor({ timeout: 20000 });
  const providerGroups = await page.locator('[data-testid^="model-provider-"]').count();
  const optionNodes = await page.locator('[data-testid^="model-option-"]').count();
  assert(providerGroups >= 3, `model selector should group models for every connected provider, saw ${providerGroups}`);
  assert(optionNodes > 50, `model selector should list the connected providers' models, saw ${optionNodes}`);
  await page.keyboard.press('Escape');
  pass(`model selector offers ${optionNodes} models across ${providerGroups} connected providers`);
  // Folder picker must browse the server filesystem from the web UI.
  const projectDir = '/root/Projects/Personal/Amiro';
  await page.getByTestId('project-selector-trigger').click();
  await page.getByTestId('folder-browser-trigger').click();
  await page.getByTestId('folder-browser-dialog').waitFor({ timeout: 20000 });
  await page.getByTestId('folder-entry-Projects').click();
  await page.getByTestId('folder-browser-current-path').filter({ hasText: '/root/Projects' }).waitFor({ timeout: 15000 });
  await page.getByTestId('folder-entry-Personal').click();
  await page.getByTestId('folder-entry-Amiro').click();
  await page.getByTestId('folder-browser-current-path').filter({ hasText: projectDir }).waitFor({ timeout: 15000 });
  await page.getByTestId('folder-browser-use-this-folder').click();
  await page.getByTestId('folder-browser-dialog').waitFor({ state: 'hidden', timeout: 15000 });
  pass(`web folder picker browsed the server filesystem to ${projectDir}`);
  // Choosing a folder may raise the workspace-trust prompt; accept it so the
  // selection is usable, then make sure no dialog overlay is left blocking chat.
  const trustPrompt = page.getByTestId('workspace-trust-prompt');
  if (await trustPrompt.isVisible().catch(() => false)) {
    await page.getByTestId('workspace-trust-grant').click();
    await trustPrompt.waitFor({ state: 'hidden', timeout: 15000 });
    pass('workspace trust granted for the selected folder');
  }
  await editor.fill('Reply with exactly AMIRO_BROWSER_OK. Do not use tools.');
  await page.getByTestId('chat-send-button').click();
  await page.getByText('AMIRO_BROWSER_OK', { exact: true }).last().waitFor({ timeout: 90000 });
  assert(chatRequests > 0);
  createdThread = new URL(page.url()).searchParams.get('thread');
  assert(createdThread, 'Chat must get a persisted thread URL');
  pass('real model response rendered by browser UI');
  // The selected folder must be the directory the session actually uses.
  const threadInfo = await page.evaluate(async (threadId) => {
    const token = localStorage.getItem('amiro.session-token');
    const res = await fetch(`/api/thread/${encodeURIComponent(threadId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { status: res.status, body: await res.json() };
  }, createdThread);
  assert.equal(threadInfo.status, 200);
  assert.equal(threadInfo.body.workingDir, projectDir, `thread must run in the selected folder, got ${threadInfo.body.workingDir}`);
  pass(`thread runs in the selected server folder ${threadInfo.body.workingDir}`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('AMIRO_BROWSER_OK', { exact: true }).last().waitFor({ timeout: 20000 });
  pass('persisted chat visible after browser reload');
  await page.locator('[contenteditable="true"]').first().fill('Reply with exactly AMIRO_FOLLOWUP_OK. Do not use tools.');
  await page.getByTestId('chat-send-button').click();
  await page.getByText('AMIRO_FOLLOWUP_OK', { exact: true }).last().waitFor({ timeout: 90000 });
  assert.equal(new URL(page.url()).searchParams.get('thread'), createdThread, 'Follow-up must stay on the same thread');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('AMIRO_BROWSER_OK', { exact: true }).last().waitFor({ timeout: 20000 });
  await page.getByText('AMIRO_FOLLOWUP_OK', { exact: true }).last().waitFor({ timeout: 20000 });
  pass('same-thread follow-up and both replies persisted after reload');
  await page.goto(`${base}/admin/usage`, { waitUntil: 'networkidle' });
  await page.getByText(/Usage is shared Jcode provider-account data/).waitFor({ timeout: 30000 });
  await page.screenshot({ path: `${artifactDir}/amiro-usage.png`, fullPage: true });
  pass('real usage UI and scope disclaimer');
  // The admin providers page must offer every provider too. It used to hardcode
  // six of them, so a user could not add most of what Jcode supports.
  await page.goto(`${base}/admin/providers`, { waitUntil: 'networkidle' });
  await page.getByTestId('add-provider-button').click();
  await page.getByTestId('admin-add-provider-menu').waitFor({ timeout: 20000 });
  const adminCountText = await page.getByTestId('admin-provider-count').innerText();
  const adminCount = Number((/(\d+)\s+providers/i.exec(adminCountText) || [])[1] || 0);
  assert(adminCount > 30, `admin add menu should list every Jcode provider, saw ${adminCount}`);
  const adminOptions = await page.locator('[data-testid^="admin-provider-option-"]').count();
  assert(adminOptions > 30, `admin add menu should render every provider, saw ${adminOptions} options`);
  const adminMenuText = await page.getByTestId('admin-add-provider-menu').innerText();
  assert(/\bOAuth\b/.test(adminMenuText), 'admin menu must label OAuth providers');
  assert(/API key/i.test(adminMenuText), 'admin menu must label API-key providers');
  pass(`admin add-provider menu lists ${adminCount} providers with mechanisms`);
  // Choosing an API-key provider must open the mechanism-appropriate form.
  await page.getByTestId('admin-provider-search').fill('openrouter');
  await page.getByTestId('admin-provider-option-openrouter').click();
  await page.getByTestId('login-panel').waitFor({ timeout: 20000 });
  await page.getByTestId('login-api-key').waitFor({ timeout: 20000 });
  assert.equal(await page.getByTestId('login-oauth-start').count(), 0, 'an API-key provider must not show the OAuth start button');
  await page.getByTestId('login-panel-close').click();
  pass('admin menu opens the API-key form for an API-key provider');
  assert.deepEqual(errors, [], 'Browser runtime errors');
  assert.deepEqual(apiFailures, [], 'Server-side API failures during browser acceptance');
  console.log(JSON.stringify({ browser: 'chrome', checks, screenshot: `${artifactDir}/amiro-usage.png` }));
} finally {
  // Revoke only this test browser's own application session.
  await page.evaluate(async (threadId) => {
    const token = localStorage.getItem('amiro.session-token');
    if (token && threadId) await fetch(`/api/thread/${encodeURIComponent(threadId)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    if (token) await fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    localStorage.removeItem('amiro.session-token');
  }, createdThread).catch(() => {});
  await browser.close();
}
