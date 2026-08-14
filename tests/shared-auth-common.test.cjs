const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const common = require('../skills/playwright-auth-wrapper/scripts/shared_auth_common.cjs');
const launcher = require('../skills/playwright-auth-wrapper/scripts/open_with_shared_state.cjs');
const login = require('../skills/playwright-auth-wrapper/scripts/login_and_save_state.cjs');

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shared-auth-test-'));
}

function readyDependencies(command = 'playwright-cli') {
  return {
    ready: true,
    cli: { ready: true, command, version: '0.0.0-test', error: null },
    skill: { ready: true, path: '/test/playwright-cli/SKILL.md' },
    install: {
      url: common.PLAYWRIGHT_CLI_INSTALL_URL,
      cli: 'npm install -g @playwright/cli@latest',
      skill: 'playwright-cli install --skills=agents',
      browser: 'playwright-cli install-browser chromium',
    },
  };
}

test('the wrapper preserves the existing shared-auth data directory', () => {
  const authDir = common.defaultAuthDir();
  assert.equal(path.basename(authDir), 'shared');
  assert.equal(path.basename(path.dirname(authDir)), 'playwright-auth');
});

test('ensureSharedAuth creates a Playwright CLI config that reads shared state', () => {
  const authDir = temporaryDirectory();
  common.configureSharedAuth({ authDir, locale: 'en-US', timezoneId: 'UTC', acceptLanguage: 'en-US' });
  const result = common.ensureSharedAuth({ authDir });
  const context = result.cliConfig.browser.contextOptions;
  assert.equal(result.cliConfig.browser.browserName, 'chromium');
  assert.equal(result.cliConfig.browser.isolated, true);
  assert.equal(context.storageState, result.paths.statePath);
  assert.equal(context.locale, 'en-US');
  assert.equal(context.timezoneId, 'UTC');
  assert.equal(context.extraHTTPHeaders['Accept-Language'], 'en-US');
});

test('configureSharedAuth changes only explicitly provided context options', () => {
  const authDir = temporaryDirectory();
  common.configureSharedAuth({ authDir, locale: 'en-US', timezoneId: 'UTC', acceptLanguage: 'en-US' });
  const result = common.configureSharedAuth({ authDir, locale: 'fr-FR' });
  const context = result.cliConfig.browser.contextOptions;
  assert.equal(context.locale, 'fr-FR');
  assert.equal(context.timezoneId, 'UTC');
  assert.equal(context.extraHTTPHeaders['Accept-Language'], 'en-US');
});

test('readiness rejects a flat context-options file that playwright-cli cannot consume', () => {
  const scratch = temporaryDirectory();
  const authDir = path.join(scratch, 'auth');
  const { paths } = common.ensureSharedAuth({ authDir });
  fs.writeFileSync(paths.contextOptionsPath, JSON.stringify({
    storageState: paths.statePath,
    locale: 'zh-CN',
  }));
  const status = common.inspectSharedAuth({
    authDir,
    cliCommand: path.join(scratch, 'missing-playwright-cli'),
    cwd: scratch,
    homeDir: scratch,
  });
  assert.equal(status.configuration.ready, false);
  assert.match(status.issues.join(','), /invalid-playwright-cli-config-shape/);
  assert.throws(
    () => launcher.launchSession({
      authDir,
      dependencies: readyDependencies(),
      runCommand: () => assert.fail('must not invoke CLI with an invalid config'),
    }),
    (error) => error.code === 'PLAYWRIGHT_CLI_CONFIG_NOT_READY',
  );
});

test('readiness inspection detects first use without creating local state', () => {
  const authDir = path.join(temporaryDirectory(), 'not-created');
  const status = common.inspectSharedAuth({
    authDir,
    cliCommand: path.join(authDir, 'missing-playwright-cli'),
    cwd: authDir,
    homeDir: authDir,
  });
  assert.equal(status.setupRequired, true);
  assert.equal(status.configuration.ready, false);
  assert.equal(status.dependencies.ready, false);
  assert.equal(status.authentication.hasSavedState, false);
  assert.match(status.issues.join(','), /missing-storage-state/);
  assert.match(status.issues.join(','), /playwright-cli-not-found/);
  assert.match(status.issues.join(','), /playwright-cli-skill-missing/);
  assert.equal(fs.existsSync(authDir), false);
});

test('readiness requires both the official CLI and companion Skill', { skip: process.platform === 'win32' }, () => {
  const scratch = temporaryDirectory();
  const authDir = path.join(scratch, 'auth');
  const workspace = path.join(scratch, 'workspace');
  const cli = path.join(scratch, 'playwright-cli');
  const skill = path.join(workspace, '.agents', 'skills', 'playwright-cli', 'SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, '---\nname: playwright-cli\n---\n');
  fs.writeFileSync(cli, '#!/bin/sh\nprintf "Version 0.1.0-test\\n"\n');
  fs.chmodSync(cli, 0o755);
  common.ensureSharedAuth({ authDir });

  const status = common.inspectSharedAuth({ authDir, cliCommand: cli, cwd: workspace, homeDir: scratch });
  assert.equal(status.setupRequired, false);
  assert.equal(status.dependencies.cli.ready, true);
  assert.equal(status.dependencies.skill.ready, true);
  assert.equal(status.dependencies.skill.path, skill);
  assert.deepEqual(status.issues, []);
});

test('missing dependency error contains the official guide and recommended commands', () => {
  const dependencies = {
    ...readyDependencies(),
    ready: false,
    cli: { ready: false, command: 'playwright-cli', version: null, error: 'playwright-cli-not-found' },
    skill: { ready: false, path: null },
  };
  const error = common.dependencyError(dependencies);
  assert.equal(error.code, 'PLAYWRIGHT_CLI_DEPENDENCY_MISSING');
  assert.match(error.message, /github\.com\/microsoft\/playwright-cli/);
  assert.match(error.message, /npm install -g @playwright\/cli@latest/);
  assert.match(error.message, /playwright-cli install --skills=agents/);
});

test('auth artifacts use private POSIX permissions', { skip: process.platform === 'win32' }, () => {
  const authDir = temporaryDirectory();
  const { paths } = common.ensureSharedAuth({ authDir });
  assert.equal(fs.statSync(authDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.statePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(paths.contextOptionsPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(paths.metadataPath).mode & 0o777, 0o600);
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

test('Launch opens a named playwright-cli session and leaves it running for the Agent', () => {
  const authDir = temporaryDirectory();
  const calls = [];
  const result = launcher.launchSession({
    authDir,
    session: 'agent-work',
    url: 'https://example.test/app?secret=hidden#fragment',
    headed: true,
    dependencies: readyDependencies('/test/playwright-cli'),
    runCommand: (command, args, options) => calls.push({ command, args, options }),
  });

  const { paths } = common.ensureSharedAuth({ authDir });
  assert.equal(result.sessionName, 'agent-work');
  assert.equal(result.initialUrl, 'https://example.test/app');
  assert.equal(result.stateReadOnly, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/test/playwright-cli');
  assert.deepEqual(calls[0].args, [
    '-s=agent-work',
    'open',
    'https://example.test/app?secret=hidden#fragment',
    `--config=${paths.contextOptionsPath}`,
    '--headed',
  ]);
  assert.ok(!calls[0].args.includes('close'));
  assert.ok(!calls[0].args.includes('screenshot'));
});

test('Launch rejects unsafe session names before invoking playwright-cli', () => {
  assert.throws(
    () => launcher.launchSession({
      authDir: temporaryDirectory(),
      session: 'bad session; close-all',
      dependencies: readyDependencies(),
      runCommand: () => assert.fail('must not invoke CLI'),
    }),
    /Session names must be/,
  );
});

test('Login start opens a headed named CLI session without saving state', () => {
  const authDir = temporaryDirectory();
  const calls = [];
  const { paths } = common.ensureSharedAuth({ authDir });
  const before = fs.readFileSync(paths.statePath, 'utf8');
  const result = login.startLogin({
    authDir,
    session: 'login-one',
    url: 'https://example.test/login?secret=hidden',
    dependencies: readyDependencies(),
    runCommand: (command, args) => calls.push({ command, args }),
  });
  assert.equal(result.sessionName, 'login-one');
  assert.equal(result.saved, false);
  assert.deepEqual(calls[0].args, [
    '-s=login-one',
    'open',
    'https://example.test/login?secret=hidden',
    `--config=${paths.contextOptionsPath}`,
    '--headed',
  ]);
  assert.equal(fs.readFileSync(paths.statePath, 'utf8'), before);
});

test('Login save validates, atomically stores, and closes a CLI session', () => {
  const authDir = temporaryDirectory();
  const calls = [];
  const state = {
    cookies: [{ name: 'session', value: 'secret', domain: 'example.test', path: '/' }],
    origins: [{ origin: 'https://example.test', localStorage: [] }],
  };
  const result = login.saveLogin({
    authDir,
    session: 'login-one',
    dependencies: readyDependencies(),
    runCommand: (command, args) => {
      calls.push({ command, args });
      if (args[1] === 'state-save') fs.writeFileSync(args[2], JSON.stringify(state));
    },
  });

  const { paths } = common.ensureSharedAuth({ authDir });
  assert.deepEqual(readJson(paths.statePath), state);
  assert.deepEqual(calls.map(({ args }) => args[1]), ['state-save', 'close']);
  assert.equal(result.cookieCount, 1);
  assert.equal(result.originCount, 1);
  assert.equal(fs.existsSync(paths.lockPath), false);
});

test('Login save leaves existing state unchanged when CLI export is invalid', () => {
  const authDir = temporaryDirectory();
  const { paths } = common.ensureSharedAuth({ authDir });
  const before = fs.readFileSync(paths.statePath, 'utf8');
  const commands = [];
  assert.throws(() => login.saveLogin({
    authDir,
    session: 'login-one',
    dependencies: readyDependencies(),
    runCommand: (command, args) => {
      commands.push(args[1]);
      if (args[1] === 'state-save') fs.writeFileSync(args[2], '{"cookies":[]}');
    },
  }), /invalid storage state/);
  assert.equal(fs.readFileSync(paths.statePath, 'utf8'), before);
  assert.deepEqual(commands, ['state-save']);
  assert.equal(fs.existsSync(paths.lockPath), false);
});

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
