const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');
const skillRoot = path.join(repositoryRoot, 'skills', 'playwright-auth-wrapper');
const common = require('../skills/playwright-auth-wrapper/scripts/shared_auth_common.cjs');

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shared-auth-test-'));
}

test('the wrapper preserves the existing shared-auth data directory', () => {
  const authDir = common.defaultAuthDir();
  assert.equal(path.basename(authDir), 'shared');
  assert.equal(path.basename(path.dirname(authDir)), 'playwright-auth');
});

test('ensureSharedAuth preserves configured context options', () => {
  const authDir = temporaryDirectory();
  common.configureSharedAuth({ authDir, locale: 'en-US', timezoneId: 'UTC', acceptLanguage: 'en-US' });
  const result = common.ensureSharedAuth({ authDir });
  assert.equal(result.contextOptions.locale, 'en-US');
  assert.equal(result.contextOptions.timezoneId, 'UTC');
  assert.equal(result.contextOptions.extraHTTPHeaders['Accept-Language'], 'en-US');
});

test('configureSharedAuth changes only explicitly provided options', () => {
  const authDir = temporaryDirectory();
  common.configureSharedAuth({ authDir, locale: 'en-US', timezoneId: 'UTC', acceptLanguage: 'en-US' });
  const result = common.configureSharedAuth({ authDir, locale: 'fr-FR' });
  assert.equal(result.contextOptions.locale, 'fr-FR');
  assert.equal(result.contextOptions.timezoneId, 'UTC');
  assert.equal(result.contextOptions.extraHTTPHeaders['Accept-Language'], 'en-US');
});

test('readiness inspection detects first use without creating local state', () => {
  const authDir = path.join(temporaryDirectory(), 'not-created');
  const status = common.inspectSharedAuth({ authDir });
  assert.equal(status.setupRequired, true);
  assert.equal(status.configuration.ready, false);
  assert.equal(status.runtime.ready, false);
  assert.equal(status.authentication.hasSavedState, false);
  assert.match(status.issues.join(','), /missing-storage-state/);
  assert.match(status.issues.join(','), /playwright-runtime-missing/);
  assert.equal(fs.existsSync(authDir), false);
});

test('readiness inspection accepts a configured pinned runtime and Chromium', () => {
  const authDir = temporaryDirectory();
  common.ensureSharedAuth({ authDir });
  const packageRoot = path.join(authDir, 'runtime', 'node_modules', 'playwright');
  const executablePath = path.join(authDir, 'runtime', 'chromium-test');
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(executablePath, 'browser');
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: 'playwright',
    version: common.PLAYWRIGHT_VERSION,
    main: 'index.js',
  }));
  fs.writeFileSync(
    path.join(packageRoot, 'index.js'),
    `module.exports = { chromium: { executablePath: () => ${JSON.stringify(executablePath)} } };\n`,
  );
  const status = common.inspectSharedAuth({ authDir });
  assert.equal(status.setupRequired, false);
  assert.equal(status.configuration.ready, true);
  assert.equal(status.runtime.ready, true);
  assert.deepEqual(status.issues, []);
  assert.equal(status.runtime.chromiumInstalled, true);
});

test('auth artifacts use private POSIX permissions', { skip: process.platform === 'win32' }, () => {
  const authDir = temporaryDirectory();
  const { paths } = common.ensureSharedAuth({ authDir });
  assert.equal(fs.statSync(authDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.statePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(paths.contextOptionsPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(paths.metadataPath).mode & 0o777, 0o600);
});

test('temporary screenshots use private POSIX permissions', { skip: process.platform === 'win32' }, () => {
  const screenshot = common.createPrivateTempFile('shared-auth-test', 'page.png');
  fs.writeFileSync(screenshot, 'image');
  common.protectPrivateFile(screenshot);
  assert.equal(fs.statSync(path.dirname(screenshot)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(screenshot).mode & 0o777, 0o600);
});

test('sanitizeUrl removes credentials, query, and fragment', () => {
  assert.equal(common.sanitizeUrl('https://user:pass@localhost/callback?code=secret#token'), 'https://localhost/callback');
});

test('login lock excludes a second writer and can be reacquired', () => {
  const authDir = temporaryDirectory();
  const lockPath = path.join(authDir, 'storage-state.lock');
  const releaseFirst = common.acquireLock(lockPath);
  assert.throws(() => common.acquireLock(lockPath), (error) => error.code === 'AUTH_STATE_LOCKED');
  releaseFirst();
  const releaseSecond = common.acquireLock(lockPath);
  releaseSecond();
  assert.equal(fs.existsSync(lockPath), false);
});

test('login lock recovers an old corrupt lock file', () => {
  const authDir = temporaryDirectory();
  const lockPath = path.join(authDir, 'storage-state.lock');
  fs.writeFileSync(lockPath, '');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, old, old);
  const release = common.acquireLock(lockPath);
  release();
  assert.equal(fs.existsSync(lockPath), false);
});

test('loadPlaywright prefers the private shared runtime', () => {
  const authDir = temporaryDirectory();
  const packageRoot = path.join(authDir, 'runtime', 'node_modules', 'playwright');
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'index.js'), 'module.exports = { marker: "shared-runtime-playwright" };\n');
  fs.writeFileSync(path.join(packageRoot, 'package.json'), '{"name":"playwright","version":"0.0.0-test","main":"index.js"}\n');
  const loaded = common.loadPlaywright(authDir);
  assert.equal(loaded.source, 'shared-runtime');
  assert.equal(loaded.playwright.marker, 'shared-runtime-playwright');
});

test('login timeout does not overwrite storage state', () => {
  const scratch = temporaryDirectory();
  const authDir = path.join(scratch, 'auth');
  const packageRoot = path.join(authDir, 'runtime', 'node_modules', 'playwright');
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), '{"name":"playwright","version":"0.0.0-test","main":"index.js"}\n');
  fs.writeFileSync(path.join(packageRoot, 'index.js'), `
const fs = require('fs');
const page = {
  goto: async () => {},
  waitForTimeout: async () => {},
  screenshot: async ({ path }) => { fs.writeFileSync(path, 'screenshot'); },
  url: () => 'https://example.test/login?code=must-not-leak#token',
  title: async () => 'Login',
  locator: () => ({ first: () => ({ count: async () => 0, isVisible: async () => false }) }),
};
const context = {
  newPage: async () => page,
  storageState: async () => ({ cookies: [{ name: 'should-not-save' }], origins: [] }),
  close: async () => {},
};
module.exports = { chromium: { launch: async () => ({ newContext: async () => context, close: async () => {} }) } };
`);
  common.ensureSharedAuth({ authDir });
  const statePath = path.join(authDir, 'storage-state.json');
  const before = fs.readFileSync(statePath, 'utf8');
  const loginScript = path.join(skillRoot, 'scripts', 'login_and_save_state.cjs');
  const result = spawnSync(process.execPath, [loginScript, '--url', 'https://example.test/login?code=must-not-leak', '--auth-dir', authDir, '--timeout-ms', '1'], {
    encoding: 'utf8',
    env: process.env,
  });
  assert.equal(result.status, 3, result.stderr || result.stdout);
  assert.match(result.stdout, /"event": "timeout"/);
  assert.match(result.stdout, /SAVE_NOW-[0-9a-f-]{36}/);
  assert.doesNotMatch(result.stdout, /must-not-leak/);
  assert.equal(fs.readFileSync(statePath, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(authDir, 'storage-state.lock')), false);
});
