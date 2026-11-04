// End-to-end tests in real Microsoft Edge: two employees in separate browser profiles.
// Run: npm run test:e2e   (requires a prior `npm run build`)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { ADMIN, apiClient, DOMAIN, signInViaUi, sleep, startServer } from './harness.mjs';

const ALEX = { email: `alex.morgan@${DOMAIN}`, name: 'Alex Morgan' };
const SAM = { email: `sam.patel@${DOMAIN}`, name: 'Sam Patel' };

let server, api, browser, adminCtx, alexCtx, admin, alex;

before(async () => {
  server = await startServer();
  api = apiClient(server.base);
  await api.onboard(ADMIN);
  await api.onboard(ALEX);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  adminCtx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  alexCtx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  admin = await adminCtx.newPage();
  alex = await alexCtx.newPage();
  await signInViaUi(admin, server.base, 'Dev Admin');
  await signInViaUi(alex, server.base, 'Alex Morgan');
  await admin.locator('.sidebar .conn.live').waitFor();
  await alex.locator('.sidebar .conn.live').waitFor();
});

after(async () => {
  await browser?.close();
  await server?.stop();
});

describe('Web dashboard in Microsoft Edge', () => {
  test('[T7][T9][T15] assignment via @mention and shared completion sync live between two browsers', async () => {
    await admin.getByRole('button', { name: 'Assigned by Me' }).first().click();
    const box = admin.getByRole('textbox', { name: 'New task title' });
    await box.fill('Prepare GST reconciliation @Ale');
    await admin.getByRole('option', { name: /Alex Morgan/ }).click();
    await box.press('Enter');
    await admin.locator('.task-card', { hasText: 'Prepare GST reconciliation' }).waitFor();

    // Alex sees it immediately, without reloading.
    const card = alex.locator('.task-card', { hasText: 'Prepare GST reconciliation' });
    await card.waitFor({ timeout: 5000 });
    await alex.locator('.toast', { hasText: 'assigned you' }).waitFor({ timeout: 5000 });

    // Alex completes it → it leaves both active lists and appears in both Completed tabs.
    await card.getByRole('button', { name: 'Mark as completed' }).click();
    await admin.locator('.task-card', { hasText: 'Prepare GST reconciliation' }).waitFor({ state: 'detached', timeout: 5000 });
    await alex.locator('.task-card', { hasText: 'Prepare GST reconciliation' }).waitFor({ state: 'detached', timeout: 5000 });
    await admin.getByRole('button', { name: 'Completed' }).first().click();
    await admin.locator('.task-card', { hasText: 'Prepare GST reconciliation' }).waitFor();
    await admin.locator('.task-card', { hasText: 'completed by Alex Morgan' }).waitFor();
    await alex.getByRole('button', { name: 'Completed' }).first().click();
    await alex.locator('.task-card', { hasText: 'completed by you' }).waitFor();
  });

  test('[T17] offline: missed updates are replayed and offline-created tasks sync exactly once', async () => {
    await alex.getByRole('button', { name: 'My Tasks' }).first().click();
    await alexCtx.setOffline(true);
    await alex.locator('.conn.offline, .conn.reconnecting').first().waitFor({ timeout: 10000 });

    // While Alex is offline, the admin assigns a task.
    const alexUser = await api.me(ALEX);
    await api.call(ADMIN, 'POST', '/api/tasks', { title: 'Assigned while you were offline', assigneeIds: [alexUser.id] });

    // Alex creates a task while offline: it is queued, not lost.
    await alex.getByRole('textbox', { name: 'New task title' }).fill('Written on the train');
    await alex.getByRole('textbox', { name: 'New task title' }).press('Enter');
    await alex.locator('.toast', { hasText: 'Saved offline' }).waitFor({ timeout: 10000 });

    await alexCtx.setOffline(false);
    await alex.locator('.sidebar .conn.live').waitFor({ timeout: 30000 });
    await alex.locator('.task-card', { hasText: 'Assigned while you were offline' }).waitFor({ timeout: 10000 });
    await alex.locator('.task-card', { hasText: 'Written on the train' }).waitFor({ timeout: 10000 });
    await sleep(500);
    const mine = await api.call(ALEX, 'GET', '/api/tasks?view=my');
    assert.equal(mine.tasks.filter((t) => t.title === 'Written on the train').length, 1, 'offline task must be created exactly once');
  });

  test('[T20] Message in Teams copies a PNG task card and opens the right one-to-one chat', async () => {
    await adminCtx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.base });
    // Never contact Microsoft during tests: answer Teams links locally.
    await adminCtx.route('https://teams.microsoft.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Teams stub</title>' }));
    const alexUser = await api.me(ALEX);
    await api.call(ADMIN, 'POST', '/api/tasks', { title: 'Share me in Teams', assigneeIds: [alexUser.id], priority: 'high' });
    await admin.getByRole('button', { name: 'Assigned by Me' }).first().click();
    await admin.locator('.task-card', { hasText: 'Share me in Teams' }).getByRole('button', { name: 'Alex Morgan' }).click();
    const popupPromise = adminCtx.waitForEvent('page');
    await admin.getByRole('menuitem', { name: /Message in Teams/ }).click();
    const popup = await popupPromise;
    const url = new URL(popup.url());
    assert.equal(url.host, 'teams.microsoft.com');
    assert.equal(url.pathname, '/l/chat/0/0');
    assert.equal(url.searchParams.get('users'), ALEX.email);
    assert.match(url.searchParams.get('message') ?? '', /Share me in Teams/);
    await popup.close();
    await admin.bringToFront();
    await admin.locator('.toast', { hasText: 'Task image copied' }).waitFor();
    const clip = await admin.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const blob = await items[0].getType('image/png');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return { types: items[0].types, size: blob.size, signature: [...bytes.slice(0, 4)] };
    });
    assert.ok(clip.types.includes('image/png'));
    assert.deepEqual(clip.signature, [0x89, 0x50, 0x4e, 0x47]);
    assert.ok(clip.size > 20_000, `PNG should be a full task card, got ${clip.size} bytes`);
  });

  test('[T15] behind a proxy that blocks WebSockets, updates still arrive through the HTTP fallback', async () => {
    const ctx = await browser.newContext();
    // Simulate a corporate proxy: every WebSocket upgrade to /api/realtime is refused.
    await ctx.routeWebSocket(/\/api\/realtime/, (ws) => ws.close());
    const page = await ctx.newPage();
    await signInViaUi(page, server.base, 'Alex Morgan');
    await page.locator('.sidebar .conn.polling').waitFor({ timeout: 30000 });
    const alexUser = await api.me(ALEX);
    await api.call(ADMIN, 'POST', '/api/tasks', { title: 'Delivered without WebSockets', assigneeIds: [alexUser.id] });
    await page.locator('.task-card', { hasText: 'Delivered without WebSockets' }).waitFor({ timeout: 25000 });
    await ctx.close();
  });

  test('[T19] no-install desktop: Edge app manifest and a pop-out always-on-top widget that updates live', async () => {
    const manifest = await (await fetch(`${server.base}/manifest.webmanifest`)).json();
    assert.equal(manifest.name, 'TaskSync');
    assert.equal(manifest.display, 'standalone');
    for (const icon of manifest.icons) assert.equal((await fetch(`${server.base}${icon.src}`)).status, 200, icon.src);

    await admin.getByRole('button', { name: 'My Tasks' }).first().click();
    const supported = await admin.evaluate(() => 'documentPictureInPicture' in window);
    assert.ok(supported, 'Edge should support Document Picture-in-Picture');
    await admin.getByRole('button', { name: /Pop out widget/ }).click();
    await admin.waitForFunction(() => window.documentPictureInPicture?.window?.document.querySelector('.widget .wg-panel'), null, { timeout: 10000 });

    const adminUser = await api.me(ADMIN);
    await api.call(ALEX, 'POST', '/api/tasks', { title: 'Seen in the floating widget', assigneeIds: [adminUser.id] });
    await admin.waitForFunction(
      () => window.documentPictureInPicture?.window?.document.body.innerText.includes('Seen in the floating widget'),
      null,
      { timeout: 10000 },
    );
    // The main window steps aside while the widget floats, and comes back when it closes.
    await admin.getByText('Widget mode is on').waitFor();
    await admin.evaluate(() => window.documentPictureInPicture.window.close());
    await admin.getByText('Widget mode is on').waitFor({ state: 'detached' });
    await admin.locator('.app').waitFor();
  });

  test('[T4][T5] a new employee waits for approval and gets in as soon as an admin approves', async () => {
    const samCtx = await browser.newContext();
    const sam = await samCtx.newPage();
    await sam.goto(`${server.base}/`);
    await sam.getByRole('button', { name: /^Sam Patel/ }).click();
    await sam.getByText('Waiting for approval').waitFor();
    await admin.getByRole('button', { name: 'Admin' }).first().click();
    await admin.locator('.glass', { hasText: SAM.email }).getByRole('button', { name: 'Approve' }).click();
    await sam.locator('.app').waitFor({ timeout: 20000 });
    await samCtx.close();
  });

  test('[T18] deactivating an employee revokes their open session immediately', async () => {
    const samCtx = await browser.newContext();
    const sam = await samCtx.newPage();
    await signInViaUi(sam, server.base, 'Sam Patel');
    await sam.locator('.sidebar .conn.live').waitFor();
    const samUser = await api.me(SAM);
    await api.call(ADMIN, 'POST', `/api/admin/users/${samUser.id}/deactivate`, { reason: 'E2E test' });
    await sam.getByText('Access deactivated').waitFor({ timeout: 10000 });
    await samCtx.close();
  });
});
