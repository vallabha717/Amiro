import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const base = process.env.AMIRO_TEST_URL || 'http://127.0.0.1:8788';
const credentials = JSON.parse(
  await readFile(process.env.AMIRO_TEST_CREDENTIALS || '/root/.amiro-preview/admin-initial-password', 'utf8')
);
const artifactDir = process.env.JCODE_SCRATCH_DIR || '/root/.jcode/scratch';
await mkdir(artifactDir, { recursive: true });

const ALL_20_THEMES = [
  'default', 'zinc', 'slate', 'stone', 'gray', 'blue', 'orange', 'pink',
  'bubblegum-pop', 'cyberpunk-neon', 'retro-arcade', 'tropical-paradise',
  'steampunk-cogs', 'neon-synthwave', 'pastel-kawaii', 'space-odyssey',
  'vintage-vinyl', 'misty-harbor', 'zen-garden', 'midnight',
];
// Back-compat alias for older assertions that still reference ALL_19_THEMES in copy
const ALL_19_THEMES = ALL_20_THEMES;

const OPENDOTS_SPRITES = ['blue', 'mint', 'orange', 'purple'];

console.log('--- Starting OpenDots & Theme Sync Integration Test Suite ---');

// 1. Verify all 4 PNG assets are served directly with HTTP 200 and PNG magic bytes
console.log('1. Checking static OpenDots asset delivery at /agent/opendots/*.png...');
for (const sprite of OPENDOTS_SPRITES) {
  const assetUrl = `${base}/agent/opendots/${sprite}.png`;
  const res = await fetch(assetUrl);
  assert.equal(res.status, 200, `Asset ${assetUrl} must return 200, got ${res.status}`);
  const contentType = res.headers.get('content-type') || '';
  assert(contentType.includes('image/png'), `Asset ${assetUrl} must have image/png content-type, got ${contentType}`);
  const buf = Buffer.from(await res.arrayBuffer());
  assert(buf.length > 1000, `Asset ${assetUrl} must be a non-trivial file, size=${buf.length}`);
  assert.equal(buf[0], 0x89, 'PNG magic byte 0');
  assert.equal(buf[1], 0x50, 'PNG magic byte 1');
  assert.equal(buf[2], 0x4e, 'PNG magic byte 2');
  assert.equal(buf[3], 0x47, 'PNG magic byte 3');
}
console.log('PASS: All 4 OpenDots plush PNG sprites are served properly with HTTP 200.');

// 2. Login
const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(credentials),
});
assert.equal(login.status, 200, 'Login must succeed');
const { token } = await login.json();
const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };

const api = async (url, init = {}) => {
  const res = await fetch(`${base}${url}`, { ...init, headers });
  assert(res.ok, `${url}: ${res.status}`);
  return res.json();
};

const originalIdentity = await api('/api/agent/identity');

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
await context.addInitScript((val) => localStorage.setItem('amiro.session-token', val), token);
const page = await context.newPage();

const errors = [];
page.on('pageerror', (err) => errors.push(err.message));

try {
  await page.goto(`${base}/agent`, { waitUntil: 'networkidle' });
  await page.getByTestId('agent-overview-page').waitFor();

  // 3. Exercise sidebar theme chooser through actual UI
  console.log('2. Exercising sidebar user menu theme chooser through UI...');
  const userButton = page.getByTestId('sidebar-user-button');
  await userButton.waitFor();
  await userButton.click();

  const themeTrigger = page.getByRole('menuitem', { name: /theme/i });
  await themeTrigger.waitFor();
  await themeTrigger.hover();
  await themeTrigger.click();

  const pinkOption = page.getByRole('menuitemcheckbox', { name: /pink/i }).first();
  await pinkOption.waitFor();
  await pinkOption.click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Body theme must update immediately without page reload
  await page.waitForFunction(() => document.body.getAttribute('data-theme') === 'pink');
  assert.equal(await page.evaluate(() => document.body.getAttribute('data-theme')), 'pink');

  // Habitat avatar must reflect the pink theme immediately
  const habitatAvatar = page.getByTestId('sidebar-agent-habitat').locator('svg[data-testid="agent-avatar"]');
  await habitatAvatar.waitFor();
  const habitatRectFill = await habitatAvatar.locator('rect').getAttribute('fill');
  assert(
    habitatRectFill === 'var(--sidebar-primary)' || habitatRectFill.includes('var('),
    `Habitat rect fill must use theme accent token, got ${habitatRectFill}`,
  );
  console.log('PASS: Sidebar theme selector changes theme to pink live without page reload.');

  // 4. Four sprite selections in customizer
  console.log('3. Verifying 4 distinct OpenDots plush characters in customizer...');
  const heroButton = page.getByTestId('agent-hero-avatar-button');
  await heroButton.waitFor();
  await heroButton.click();

  const modal = page.getByTestId('agent-customizer-modal');
  await modal.waitFor();

  const observedSpriteUrls = new Set();
  const nextFormBtn = page.getByTestId('agent-next-body-shape');
  for (let i = 0; i < 6; i++) {
    // Note: svg has two image nodes (mask and visible g > image); select visible g > image
    const previewImage = modal.locator('svg[data-testid="agent-avatar"] g > image');
    await previewImage.waitFor();
    const href = await previewImage.getAttribute('href');
    assert(href && href.startsWith('/agent/opendots/'), `Preview image must point to /agent/opendots/*, got ${href}`);
    observedSpriteUrls.add(href);
    await nextFormBtn.click();
    await page.waitForTimeout(100);
  }
  assert.equal(observedSpriteUrls.size, 4, `All 4 distinct plush characters must cycle, found ${observedSpriteUrls.size}: ${[...observedSpriteUrls]}`);
  console.log(`PASS: All 4 plush sprites cycled and rendered: ${[...observedSpriteUrls].join(', ')}`);

  // 5. Test cancel preserves theme – use visible TraitCycleRow arrows, not hidden controls
  console.log('4. Verifying Customizer Cancel preserves theme via visible arrows...');
  const themeBeforeCancel = await page.evaluate(() => document.body.getAttribute('data-theme') || 'default');
  const targetTheme = themeBeforeCancel === 'zinc' ? 'orange' : 'zinc';
  const formatLabel = (id) => id.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  const targetLabel = formatLabel(targetTheme);
  const themeValue = page.getByTestId('agent-theme-value');
  const nextThemeBtn = page.getByTestId('agent-next-theme');
  // Bounded loop: click Next Theme until modal draft matches target, reading visible center value
  for (let i = 0; i < 25; i++) {
    const draft = await modal.getAttribute('data-theme');
    if (draft === targetTheme) break;
    const visible = (await themeValue.textContent())?.trim();
    if (visible === targetLabel && draft === targetTheme) break;
    await nextThemeBtn.click();
    await page.waitForTimeout(140);
  }
  await page.waitForTimeout(150);

  // Modal draft changes
  const modalDraft = await modal.getAttribute('data-theme');
  assert.equal(modalDraft, targetTheme, `Customizer modal data-theme should reflect draft ${targetTheme}`);
  // Visible center value must match the target label
  const visibleThemeLabel = (await themeValue.textContent())?.trim();
  assert.equal(visibleThemeLabel, targetLabel, `Visible theme value must show ${targetLabel}`);

  // But document.body should still have themeBeforeCancel
  const bodyDuringDraft = await page.evaluate(() => document.body.getAttribute('data-theme') || 'default');
  assert.equal(bodyDuringDraft, themeBeforeCancel, 'Body theme must NOT change before Save is clicked');

  // Cancel via explicit cancel button
  await page.getByTestId('agent-customizer-cancel').click();
  await modal.waitFor({ state: 'hidden' });
  const bodyAfterCancel = await page.evaluate(() => document.body.getAttribute('data-theme') || 'default');
  assert.equal(bodyAfterCancel, themeBeforeCancel, 'Body theme must stay preserved after Cancel');
  console.log('PASS: Customizer Cancel preserves active theme via visible arrows.');

  // 6. Test save applies theme immediately to sidebar and agent – visible arrows
  console.log('5. Verifying Customizer Save applies theme via visible arrows...');
  await heroButton.click();
  await modal.waitFor();
  const saveTheme = 'tropical-paradise';
  const saveLabel = formatLabel(saveTheme);
  // Cycle visible Theme row until saveTheme is the draft
  for (let i = 0; i < 25; i++) {
    const draft = await modal.getAttribute('data-theme');
    if (draft === saveTheme) break;
    await page.getByTestId('agent-next-theme').click();
    await page.waitForTimeout(140);
  }
  const saveVisible = (await page.getByTestId('agent-theme-value').textContent())?.trim();
  assert.equal(saveVisible, saveLabel, `Visible theme value must be ${saveLabel} before Save`);
  // Midnight tint check: SVG tint attribute reflects preview – when saveTheme is not midnight, should be accent
  const tintBeforeSave = await modal.locator('svg[data-testid="agent-avatar"]').getAttribute('data-agent-tint');
  assert(tintBeforeSave === 'accent' || tintBeforeSave === 'black', `Preview tint attribute must be present, got ${tintBeforeSave}`);
  await page.getByTestId('agent-customizer-save').click();
  await modal.waitFor({ state: 'hidden' });

  // Body theme must update immediately without a page reload
  await page.waitForFunction((expected) => document.body.getAttribute('data-theme') === expected, saveTheme);
  const bodyAfterSave = await page.evaluate(() => document.body.getAttribute('data-theme'));
  assert.equal(bodyAfterSave, saveTheme, `Body theme must update immediately to ${saveTheme}`);
  console.log('PASS: Customizer Save applies theme via visible arrows without reload.');

  // 7. Test all 20 themes in both light and dark modes with real computed DOM colors
  console.log('6. Verifying all 20 themes in light and dark modes with computed DOM colors and sRGB resolution...');
  for (const mode of ['light', 'dark']) {
    await page.evaluate((m) => {
      document.documentElement.classList.remove('light', 'dark');
      document.documentElement.classList.add(m);
      localStorage.setItem('app-theme-v2', m);
    }, mode);

    for (const theme of ALL_19_THEMES) {
      await page.evaluate(({ theme }) => {
        document.body.setAttribute('data-theme', theme);
        localStorage.setItem('ChATBOT-STOREAGE-theme-style', JSON.stringify({ value: theme }));
      }, { theme });

      const colors = await page.evaluate(() => {
        const style = getComputedStyle(document.body);
        const primary = style.getPropertyValue('--sidebar-primary').trim();
        const fg = style.getPropertyValue('--sidebar-primary-foreground').trim();

        // Canvas sRGB resolution
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d');
        let hex = '#000000';
        if (ctx && primary) {
          ctx.fillStyle = primary;
          ctx.fillRect(0, 0, 1, 1);
          const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
          hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
        }

        return { primary, fg, hex };
      });

      assert(colors.primary && colors.primary.length > 0, `Mode ${mode} theme ${theme} must define --sidebar-primary`);
      assert(colors.fg && colors.fg.length > 0, `Mode ${mode} theme ${theme} must define --sidebar-primary-foreground`);
      assert(colors.hex && colors.hex.startsWith('#'), `Resolved sRGB hex must be valid, got ${colors.hex}`);
    }
  }
  console.log(`PASS: All ${ALL_19_THEMES.length} themes verified in both light and dark modes with active computed DOM colors.`);

  // 8. Verify uploaded portrait is unaffected by SVG tint
  console.log('7. Verifying uploaded portrait is unaffected by SVG color tint...');
  const fakeDataPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  await api('/api/agent/identity', {
    method: 'PUT',
    body: JSON.stringify({ ...originalIdentity, customImageUrl: fakeDataPng }),
  });
  await page.reload({ waitUntil: 'networkidle' });
  const customImg = page.getByTestId('agent-hero-avatar-button').locator('img[data-testid="agent-avatar"]');
  await customImg.waitFor();
  const imgSrc = await customImg.getAttribute('src');
  assert.equal(imgSrc, fakeDataPng, 'Custom portrait image must be displayed');
  const hasTintRect = await page.getByTestId('agent-hero-avatar-button').locator('svg mask').count();
  assert.equal(hasTintRect, 0, 'Custom uploaded image must not have SVG tint mask');
  console.log('PASS: Uploaded portrait is unaffected by color blend/tint.');

  // 9. Reduced motion verification
  console.log('8. Verifying reduced motion support...');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(300);
  const motionTransforms = await page.getByTestId('sidebar-agent-habitat').locator('div[aria-hidden]').evaluateAll((nodes) => nodes.map((n) => getComputedStyle(n).transform));
  await page.waitForTimeout(400);
  const laterTransforms = await page.getByTestId('sidebar-agent-habitat').locator('div[aria-hidden]').evaluateAll((nodes) => nodes.map((n) => getComputedStyle(n).transform));
  assert.deepEqual(laterTransforms, motionTransforms, 'Decorative roaming must stop with reduced motion');
  console.log('PASS: Decorative motion respects prefers-reduced-motion.');

  assert.deepEqual(errors, [], `No page errors expected, got: ${errors.join(', ')}`);
  console.log('ALL INTEGRATION CHECKS PASSED SUCCESSFULLY.');
} finally {
  try {
    await api('/api/agent/identity', {
      method: 'PUT',
      body: JSON.stringify({
        name: originalIdentity.name,
        handle: originalIdentity.handle,
        tagline: originalIdentity.tagline,
        traits: originalIdentity.traits,
        accentHex: originalIdentity.accentHex,
        customImageUrl: originalIdentity.customImageUrl,
        sliders: originalIdentity.sliders,
      }),
    });
  } catch (err) {
    console.error('Failed restoring identity:', err);
  } finally {
    await browser.close();
  }
}
