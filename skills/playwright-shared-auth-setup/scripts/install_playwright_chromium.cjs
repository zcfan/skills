#!/usr/bin/env node
const path = require('path');
const {
  PLAYWRIGHT_VERSION,
  ensureSharedAuth,
  loadPlaywright,
  parseArgs,
  printJson,
  run,
  sanitizeError,
  writeJsonAtomic,
} = require('./shared_auth_common.cjs');

const args = parseArgs(process.argv.slice(2));

function commandWorks(command) {
  try {
    run(command, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

(async () => {
  const { paths, contextOptions } = ensureSharedAuth({ authDir: args.authDir });
  if (!commandWorks('npm')) throw new Error('npm is required. Install Node.js LTS first.');
  writeJsonAtomic(path.join(paths.runtimeDir, 'package.json'), {
    name: 'playwright-shared-auth-runtime',
    private: true,
    dependencies: { playwright: PLAYWRIGHT_VERSION },
  });
  run('npm', ['install', '--prefix', paths.runtimeDir, '--omit=dev', '--no-audit', '--no-fund']);
  try {
    const { playwright, packageRoot, source } = loadPlaywright(paths.authDir);
    run(process.execPath, [path.join(packageRoot, 'cli.js'), 'install', 'chromium']);
    const { chromium } = playwright;
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent('<title>ok</title>Playwright OK');
    const result = { ok: true, playwrightVersion: require(path.join(packageRoot, 'package.json')).version, playwrightSource: source, title: await page.title(), executablePath: chromium.executablePath(), paths, contextOptions };
    await browser.close();
    printJson(result);
  } catch (error) {
    const message = String(error && error.message || error);
    const advice = ['Install the system libraries required by Playwright Chromium for your OS, then rerun this script.'];
    if (/shared libraries|not found|dylib|DLL|libgbm\.so\.1/.test(message)) advice.push('Use the browser launch error or ldd/otool/Dependency Walker to identify missing native libraries. On Debian-like Linux, install the package that provides the missing .so, e.g. libgbm1 for libgbm.so.1.');
    if (process.platform === 'linux') advice.push('On unsupported Linux distributions, playwright install-deps may use wrong package names; install missing libraries manually.');
    if (process.platform === 'darwin') advice.push('On macOS, ensure Xcode Command Line Tools and system browser dependencies are healthy.');
    if (process.platform === 'win32') advice.push('On Windows, ensure Microsoft Visual C++ runtime and system WebView/graphics dependencies are installed.');
    printJson({ ok: false, error: message, advice, paths, contextOptions });
    process.exit(1);
  }
})().catch((error) => { printJson({ ok: false, error: sanitizeError(error) }); process.exit(1); });
