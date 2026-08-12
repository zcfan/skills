#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createPrivateTempFile, loadPlaywright, resolvePaths, parseArgs, printJson, protectPrivateFile, sanitizeError, sanitizeUrl } = require('./shared_auth_common.cjs');
const args = parseArgs(process.argv.slice(2));
const url = args._[0] || args.url;
if (!url) { console.error('Usage: playwright-auth-wrapper launch <url> [screenshotPath] [--auth-dir <dir>]'); process.exit(2); }
const screenshotPath = args._[1] || args.screenshot || createPrivateTempFile('playwright-auth-wrapper', 'page.png');
const paths = resolvePaths(args.authDir);

(async () => {
  const options = JSON.parse(fs.readFileSync(paths.contextOptionsPath, 'utf8'));
  const { playwright, source } = loadPlaywright(paths.authDir);
  const { chromium } = playwright;
  const browser = await chromium.launch({ headless: process.env.PLAYWRIGHT_HEADLESS !== '0' });
  let context;
  try {
    context = await browser.newContext({ ...options, viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(Number(args.waitMs || 3000));
    await fs.promises.mkdir(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    protectPrivateFile(screenshotPath);
    const finalUrl = page.url();
    const result = { requestedUrl: sanitizeUrl(url), finalUrl: sanitizeUrl(finalUrl), title: await page.title(), screenshotPath, language: await page.evaluate(() => navigator.language), redirectedToLogin: /(?:login|sign-?in|oauth|authorize|authentication)/i.test(finalUrl), playwrightSource: source };
    printJson(result);
  } finally {
    if (context) await context.close().catch(() => null);
    await browser.close().catch(() => null);
  }
})().catch((error) => { printJson({ ok: false, error: sanitizeError(error) }); process.exit(1); });
