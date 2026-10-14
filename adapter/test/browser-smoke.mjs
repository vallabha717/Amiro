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
  await page.goto(`${base}/sign-in`, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('a[href="/sign-up"]').count(), 0, 'Closed registration must not advertise sign-up');
  await page.getByTestId('signin-email-input').fill(credentials.email);
  await page.getByTestId('signin-password-input').fill(credentials.password);
  await page.getByTestId('signin-submit-button').click();
  await page.waitForURL('**/onboarding', { timeout: 20000 });
  await page.getByTestId('onboarding-runtime-notice').waitFor();
  await page.getByTestId('login-panel').waitFor();
  console.log('PASS browser owner sign-in and honest onboarding');
  await page.getByTestId('onboarding-skip-button').click();
  await page.waitForURL(`${base}/`, { timeout: 20000 });
  await page.getByTestId('connect-provider-button').click();
  await page.getByTestId('login-panel').waitFor();
  console.log('PASS visible provider login UI');
  await page.getByTestId('login-provider-select').click();
  await page.getByRole('option').filter({ hasText: 'Antigravity' }).click();
  await page.getByTestId('login-oauth-start').click();
  await page.getByTestId('login-oauth-cancel').waitFor({ timeout: 20000 });
  console.log('PASS real provider OAuth initiation UI (no credential exchange)');
  await page.getByTestId('login-oauth-cancel').click();
  await page.getByTestId('login-oauth-start').waitFor({ timeout: 20000 });
  await page.getByTestId('login-panel-close').click();
  console.log('PASS OAuth cancellation without changing credentials');
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.fill('/login');
  await page.getByTestId('chat-send-button').click();
  await page.getByTestId('login-panel').waitFor();
  assert.equal(chatRequests, 0, '/login must not be sent to the model');
  await page.getByTestId('login-panel-close').click();
  console.log('PASS chat /login interception without a model request');
  await editor.fill('Reply with exactly AMIRO_BROWSER_OK. Do not use tools.');
  await page.getByTestId('chat-send-button').click();
  await page.getByText('AMIRO_BROWSER_OK', { exact: true }).last().waitFor({ timeout: 90000 });
  assert(chatRequests > 0);
  createdThread = new URL(page.url()).searchParams.get('thread');
  assert(createdThread, 'Chat must get a persisted thread URL');
  console.log('PASS real model response rendered by browser UI');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('AMIRO_BROWSER_OK', { exact: true }).last().waitFor({ timeout: 20000 });
  console.log('PASS persisted chat visible after browser reload');
  await page.locator('[contenteditable="true"]').first().fill('Reply with exactly AMIRO_FOLLOWUP_OK. Do not use tools.');
  await page.getByTestId('chat-send-button').click();
  await page.getByText('AMIRO_FOLLOWUP_OK', { exact: true }).last().waitFor({ timeout: 90000 });
  assert.equal(new URL(page.url()).searchParams.get('thread'), createdThread, 'Follow-up must stay on the same thread');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('AMIRO_BROWSER_OK', { exact: true }).last().waitFor({ timeout: 20000 });
  await page.getByText('AMIRO_FOLLOWUP_OK', { exact: true }).last().waitFor({ timeout: 20000 });
  console.log('PASS same-thread follow-up and both replies persisted after reload');
  await page.goto(`${base}/admin/usage`, { waitUntil: 'networkidle' });
  await page.getByText(/Usage is shared Jcode provider-account data/).waitFor({ timeout: 30000 });
  await page.screenshot({ path: `${artifactDir}/amiro-usage.png`, fullPage: true });
  console.log('PASS real usage UI and scope disclaimer');
  assert.deepEqual(errors, [], 'Browser runtime errors');
  assert.deepEqual(apiFailures, [], 'Server-side API failures during browser acceptance');
  console.log(JSON.stringify({ browser: 'chrome', checks: 9, screenshot: `${artifactDir}/amiro-usage.png` }));
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
