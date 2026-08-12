#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const {
  acquireLock,
  createPrivateTempFile,
  ensureSharedAuth,
  loadPlaywright,
  parseArgs,
  printJson,
  protectPrivateFile,
  resolvePaths,
  sanitizeError,
  sanitizeUrl,
  writeJsonAtomic,
} = require('./shared_auth_common.cjs');

const args = parseArgs(process.argv.slice(2));
const url = args.url || process.env.PLAYWRIGHT_SHARED_LOGIN_URL;
if (!url) {
  console.error('Usage: login_and_save_state.cjs --url <login-or-target-url> [--headed] [--timeout-ms <ms>] [--screenshot <path>]');
  process.exit(2);
}

const timeoutMs = Number(args.timeoutMs || process.env.PLAYWRIGHT_SHARED_LOGIN_TIMEOUT_MS || 12 * 60 * 1000);
const screenshot = args.screenshot || process.env.PLAYWRIGHT_SHARED_LOGIN_SCREENSHOT || createPrivateTempFile('playwright-login', 'login.png');
const statusScreenshot = args.statusScreenshot || process.env.PLAYWRIGHT_SHARED_STATUS_SCREENSHOT || createPrivateTempFile('playwright-login-status', 'status.png');
const headless = args.headed ? false : process.env.PLAYWRIGHT_HEADLESS !== '0';
const autoAuthorize = args.autoAuthorize === true;
const authorizeHost = typeof args.authorizeHost === 'string' ? args.authorizeHost.toLowerCase() : null;

if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout-ms must be a positive number');
if (autoAuthorize && !authorizeHost) throw new Error('--auto-authorize requires --authorize-host <exact-hostname>');

async function clickCommonAuthorization(page) {
  const currentHost = new URL(page.url()).hostname.toLowerCase();
  if (!autoAuthorize || currentHost !== authorizeHost) return null;
  const selectors = [
    'button:has-text("允许")',
    'button:has-text("授权")',
    'button:has-text("同意")',
    'button:has-text("确认")',
    'button:has-text("继续")',
    'button:has-text("Allow")',
    'button:has-text("Authorize")',
    'button:has-text("Continue")',
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count().catch(() => 0) && await locator.isVisible().catch(() => false)) {
      await locator.click({ timeout: 5000 });
      return selector;
    }
  }
  return null;
}

async function main() {
  const unresolvedPaths = resolvePaths(args.authDir);
  let releaseLock;
  let browser;
  let context;
  let saveMarkerPath;
  try {
    releaseLock = acquireLock(unresolvedPaths.lockPath);

    const { paths, contextOptions } = ensureSharedAuth({ authDir: args.authDir });
    saveMarkerPath = path.join(paths.authDir, `SAVE_NOW-${randomUUID()}`);
    const { playwright, source } = loadPlaywright(paths.authDir);
    browser = await playwright.chromium.launch({ headless });
    context = await browser.newContext({ ...contextOptions, storageState: paths.statePath, viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    await fs.promises.mkdir(path.dirname(screenshot), { recursive: true });
    await fs.promises.mkdir(path.dirname(statusScreenshot), { recursive: true });
    await page.screenshot({ path: screenshot, fullPage: true });
    protectPrivateFile(screenshot);
    printJson({ event: 'ready-for-user', url: sanitizeUrl(page.url()), screenshot, statePath: paths.statePath, saveMarkerPath, playwrightSource: source });

    const deadline = Date.now() + timeoutMs;
    let lastUrl = page.url();
    let confirmed = false;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2000);
      const current = page.url();
      if (current !== lastUrl) {
        lastUrl = current;
        printJson({ event: 'url', url: sanitizeUrl(current) });
        await page.screenshot({ path: statusScreenshot, fullPage: true }).catch(() => null);
        protectPrivateFile(statusScreenshot);
      }
      const clicked = await clickCommonAuthorization(page);
      if (clicked) printJson({ event: 'clicked', selector: clicked, url: sanitizeUrl(current) });
      if (fs.existsSync(saveMarkerPath)) {
        confirmed = true;
        break;
      }
    }

    if (!confirmed) {
      printJson({ event: 'timeout', saved: false, statePath: paths.statePath });
      process.exitCode = 3;
      return;
    }

    const state = await context.storageState();
    writeJsonAtomic(paths.statePath, state);
    const oldMeta = fs.existsSync(paths.metadataPath) ? JSON.parse(fs.readFileSync(paths.metadataPath, 'utf8')) : {};
    const { lastUrl: _lastUrl, lastTitle: _lastTitle, ...safeOldMeta } = oldMeta;
    const meta = {
      ...safeOldMeta,
      updatedAt: new Date().toISOString(),
      lastUrl: sanitizeUrl(page.url()),
      cookieCount: state.cookies?.length ?? 0,
      originCount: state.origins?.length ?? 0,
      cookieDomains: [...new Set((state.cookies ?? []).map((cookie) => cookie.domain))].sort(),
    };
    writeJsonAtomic(paths.metadataPath, meta);
    printJson({ event: 'saved', statePath: paths.statePath, metadataPath: paths.metadataPath, ...meta });
  } finally {
    if (saveMarkerPath) fs.rmSync(saveMarkerPath, { force: true });
    if (context) await context.close().catch(() => null);
    if (browser) await browser.close().catch(() => null);
    if (releaseLock) releaseLock();
  }
}

main().catch((error) => {
  printJson({ ok: false, error: sanitizeError(error), statusScreenshot });
  process.exit(1);
});
