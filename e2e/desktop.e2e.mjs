// End-to-end test of the Windows desktop companion (WinForms + WebView2).
// Launches the real app in an isolated profile, drives its WebView2 over the Chrome DevTools
// Protocol, and checks Windows-side effects through the host's test log.
// Run: npm run test:e2e:desktop   (requires `npm run build` and `npm run build:desktop`)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { ADMIN, apiClient, DOMAIN, freePort, ROOT, sleep, startServer } from './harness.mjs';

const ALEX = { email: `alex.morgan@${DOMAIN}`, name: 'Alex Morgan' };
const BIN = path.join(ROOT, 'desktop', 'TaskSync.Desktop', 'bin', 'Release', 'net8.0-windows');

let server, api, dataDir, logFile, app, cdp, page;

function win32(command, ...args) {
  const out = execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'e2e', 'win32.ps1'), command, ...args.map(String)],
    { encoding: 'utf8' },
  );
  return JSON.parse(out.trim());
}

const readLogCount = (action) => readLog().filter((e) => e.action === action).length;

function readLog() {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function waitForLog(action, predicate = () => true, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const hit = readLog().find((e) => e.action === action && predicate(e.data ?? {}));
    if (hit) return hit;
    await sleep(150);
  }
  throw new Error(`host log never recorded "${action}". Log:\n${readFileSync(logFile, 'utf8')}`);
}

/** Launches the desktop app; falls back to `dotnet TaskSync.dll` where policy blocks unsigned .exe files. */
async function launchApp() {
  const cdpPort = await freePort();
  const env = {
    ...process.env,
    TASKSYNC_DATA_DIR: dataDir,
    TASKSYNC_TEST_LOG: logFile,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
  };
  const args = ['--url', server.base];
  const dotnet = [path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'dotnet', 'dotnet.exe'), 'dotnet'].find(
    (p) => p === 'dotnet' || existsSync(p),
  );
  let child;
  try {
    child = spawn(path.join(BIN, 'TaskSync.exe'), args, { env, stdio: 'ignore' });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } catch {
    child = spawn(dotnet, [path.join(BIN, 'TaskSync.dll'), ...args], { env, stdio: 'ignore' });
  }
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      if (res.ok) break;
    } catch {
      // WebView2 not ready yet
    }
    await sleep(200);
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  let p;
  for (let i = 0; i < 50 && !p; i++) {
    p = browser.contexts()[0]?.pages().find((x) => x.url().startsWith(server.base));
    if (!p) await sleep(200);
  }
  assert.ok(p, 'widget page should load the TaskSync URL');
  return { child, browser, page: p };
}

async function closeApp() {
  await cdp?.close().catch(() => undefined);
  app?.kill();
  await sleep(800);
}

before(async () => {
  assert.ok(existsSync(path.join(BIN, 'TaskSync.dll')), 'build the desktop app first: npm run build:desktop');
  server = await startServer();
  api = apiClient(server.base);
  await api.onboard(ADMIN);
  await api.onboard(ALEX);
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'tasksync-desktop-e2e-'));
  logFile = path.join(dataDir, 'host.log');
  ({ child: app, browser: cdp, page } = await launchApp());
});

after(async () => {
  await closeApp();
  await server?.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Windows desktop companion', () => {
  test('[T19] widget loads, signs in and shows the floating widget UI', async () => {
    await waitForLog('started');
    assert.match(page.url(), /\/widget$/, 'the desktop app opens the widget route');
    await page.getByRole('button', { name: /^Alex Morgan/ }).click();
    await page.locator('.widget .wg-dot.live').waitFor({ timeout: 15000 });
    // Host state reached the page through the bridge (pinned on top by default).
    await page.getByRole('button', { name: 'On top', pressed: true }).waitFor();
  });

  test('[T19] always-on-top toggle and compact/expanded modes change the real window', async () => {
    await page.getByRole('button', { name: 'On top', pressed: true }).click();
    const pin = await waitForLog('setAlwaysOnTop', (d) => d.value === false);
    assert.equal(pin.data.topMost, false, 'WinForms TopMost must follow the toggle');
    await page.getByTitle('Expand').click();
    const expanded = await waitForLog('setMode', (d) => d.mode === 'Expanded');
    await page.getByTitle('Compact').click();
    const compact = await waitForLog('setMode', (d) => d.mode === 'Compact');
    assert.ok(expanded.data.Height > compact.data.Height && expanded.data.Width > compact.data.Width, 'expanded window is larger');
    await page.getByTitle('Expand').click();
    await waitForLog('setMode', (d) => d.mode === 'Expanded' && d.Height === expanded.data.Height);
  });

  test('[T14][T15][T19] a task assigned on the server appears live and raises a Windows notification', async () => {
    const alex = await api.me(ALEX);
    await api.call(ADMIN, 'POST', '/api/tasks', { title: 'Approve petty cash claims', assigneeIds: [alex.id] });
    await page.locator('.task-card', { hasText: 'Approve petty cash claims' }).waitFor({ timeout: 8000 });
    const toast = await waitForLog('notify', (d) => String(d.title).includes('Approve petty cash claims'));
    assert.match(toast.data.taskId, /^[0-9a-f-]{36}$/);
  });

  test('[T20] Message in Teams: host copies the PNG to the Windows clipboard and launches the Teams chat link', async () => {
    const before = execFileSync('powershell', ['-NoProfile', '-STA', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; if ([Windows.Forms.Clipboard]::ContainsText()) { [Windows.Forms.Clipboard]::GetText() }'], { encoding: 'utf8' });
    try {
      await page.locator('.task-card', { hasText: 'Approve petty cash claims' }).getByRole('button', { name: 'Dev Admin' }).click();
      await page.getByRole('menuitem', { name: /Message in Teams/ }).click();
      const copy = await waitForLog('copyImage');
      assert.ok(copy.data.bytes > 20_000 && copy.data.Width === 2400, `full-resolution PNG expected, got ${JSON.stringify(copy.data)}`);
      const open = await waitForLog('openExternal');
      const url = new URL(open.data.url);
      assert.equal(url.protocol, 'msteams:');
      assert.equal(url.pathname, '/l/chat/0/0');
      assert.equal(url.searchParams.get('users'), ADMIN.email);
      const hasImage = execFileSync('powershell', ['-NoProfile', '-STA', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.Clipboard]::ContainsImage()'], { encoding: 'utf8' }).trim();
      assert.equal(hasImage, 'True', 'Windows clipboard should contain the task image');
    } finally {
      // Restore whatever text the developer had on their clipboard.
      const restore = before.trim() ? `Set-Clipboard -Value ${JSON.stringify(before.trimEnd())}` : 'Set-Clipboard -Value $null';
      execFileSync('powershell', ['-NoProfile', '-STA', '-Command', restore]);
    }
  });

  test('[T19] widget is hidden from screen sharing and screenshots (on by default, can be turned off)', async () => {
    const entry = await waitForLog('captureExclusion', (d) => d.hide === true);
    assert.equal(entry.data.affinity, 0x11, 'WDA_EXCLUDEFROMCAPTURE applied');
    const hwnd = entry.data.hwnd;
    assert.equal(win32('affinity', hwnd).affinity, 0x11);
    // Compare what screen capture sees in the widget's rectangle with exclusion on vs off.
    const bounds = win32('rect', hwnd);
    const hidden = win32('grabhash', bounds.x, bounds.y, bounds.w, bounds.h).hash;
    await page.evaluate(() => window.chrome.webview.postMessage({ type: 'setHideFromCapture', value: false }));
    await waitForLog('captureExclusion', (d) => d.hide === false);
    await sleep(400);
    assert.equal(win32('affinity', hwnd).affinity, 0);
    const shown = win32('grabhash', bounds.x, bounds.y, bounds.w, bounds.h).hash;
    assert.notEqual(hidden, shown, 'capture must not contain the widget while exclusion is on');
    await page.evaluate(() => window.chrome.webview.postMessage({ type: 'setHideFromCapture', value: true }));
    await waitForLog('captureExclusion', (d) => d.hide === true && readLogCount('captureExclusion') >= 3);
    assert.equal(win32('affinity', hwnd).affinity, 0x11);
  });

  test('[T19] stays visible when Windows or another app tries to minimise it (Win+M / Show desktop path)', async () => {
    const hwnd = (await waitForLog('stayOnDesktop', (d) => d.stay === true)).data.hwnd;
    win32('minimize', hwnd);
    await sleep(600);
    assert.deepEqual(win32('state', hwnd), { iconic: false, visible: true }, 'ShowWindow(SW_MINIMIZE) is undone');
    win32('sysminimize', hwnd);
    await sleep(400);
    assert.deepEqual(win32('state', hwnd), { iconic: false, visible: true }, 'SC_MINIMIZE is ignored');
    await waitForLog('minimizeBlocked');
    // With the setting off, the same request really minimises it (proves the guard is what keeps it up).
    await page.evaluate(() => window.chrome.webview.postMessage({ type: 'setStayOnDesktop', value: false }));
    await waitForLog('stayOnDesktop', (d) => d.stay === false);
    win32('minimize', hwnd);
    await sleep(600);
    assert.equal(win32('state', hwnd).iconic, true);
    win32('restore', hwnd);
    await page.evaluate(() => window.chrome.webview.postMessage({ type: 'setStayOnDesktop', value: true }));
    await waitForLog('stayOnDesktop', (d) => d.stay === true && readLogCount('stayOnDesktop') >= 3);
  });

  test('[T19] minimise to tray hides the widget', async () => {
    await page.getByTitle('Minimise to tray').click();
    await waitForLog('minimizeToTray');
  });

  test('[T19] size, position, mode and sign-in survive an app restart', async () => {
    await closeApp();
    const settings = JSON.parse(readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
    assert.equal(settings.Mode, 'Expanded');
    assert.equal(settings.AlwaysOnTop, false);
    assert.ok(settings.ExpandedBounds?.Width > 0 && settings.CompactBounds?.Width > 0);
    ({ child: app, browser: cdp, page } = await launchApp());
    // No sign-in click needed: the WebView2 profile kept the session.
    await page.locator('.widget .wg-dot.live').waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: 'On top', pressed: false }).waitFor(); // persisted "not on top"
    await page.getByTitle('Compact').waitFor(); // persisted expanded mode
  });

  test('[T17][T19] when the server is unreachable the widget shows a retry page and recovers by itself', async () => {
    const port = server.port;
    await server.stop();
    await page.reload().catch(() => undefined);
    const offline = await waitForLog('offline', () => true, 15000);
    assert.ok(offline.data.retryInSeconds >= 2);
    server = await startServer({ port });
    // The host retries on its own and loads TaskSync again (fresh dev server → sign-in screen).
    const end = Date.now() + 45_000;
    let recovered = false;
    while (Date.now() < end && !recovered) {
      const pages = cdp.contexts()[0]?.pages() ?? [];
      for (const p of pages) {
        if (p.url().startsWith(server.base) && (await p.locator('.hero, .widget').count().catch(() => 0)) > 0) recovered = true;
      }
      await sleep(500);
    }
    assert.ok(recovered, 'widget should reload TaskSync after the server is back');
  });
});
