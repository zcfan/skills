'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomBytes, randomUUID } = require('crypto');
const { spawnSync } = require('child_process');

const CORRUPT_LOCK_GRACE_MS = 30_000;
const PLAYWRIGHT_CLI_INSTALL_URL = 'https://github.com/microsoft/playwright-cli';

function defaultAuthDir() {
  if (process.env.PLAYWRIGHT_SHARED_AUTH_DIR) return process.env.PLAYWRIGHT_SHARED_AUTH_DIR;
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'playwright-auth', 'shared');
  }
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'playwright-auth', 'shared');
}

function resolvePaths(authDir = defaultAuthDir()) {
  return {
    authDir,
    statePath: path.join(authDir, 'storage-state.json'),
    contextOptionsPath: path.join(authDir, 'context-options.json'),
    metadataPath: path.join(authDir, 'metadata.json'),
    lockPath: path.join(authDir, 'storage-state.lock'),
  };
}

function setPrivateMode(target, mode) {
  if (process.platform !== 'win32') fs.chmodSync(target, mode);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  setPrivateMode(dir, 0o700);
}

function protectPrivateFile(file) {
  if (fs.existsSync(file)) setPrivateMode(file, 0o600);
}

function sanitizeUrl(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '<redacted-url>';
  }
}

function sanitizeError(error) {
  const message = String(error && (error.stack || error.message) || error);
  return message.replace(/https?:\/\/[^\s'"<>]+/g, (value) => sanitizeUrl(value));
}

function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tempFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    setPrivateMode(tempFile, 0o600);
    fs.renameSync(tempFile, file);
    setPrivateMode(file, 0o600);
  } finally {
    fs.rmSync(tempFile, { force: true });
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function savedContextOptions(config = {}) {
  if (config.browser?.contextOptions && typeof config.browser.contextOptions === 'object') {
    return config.browser.contextOptions;
  }
  return config;
}

function buildCliConfig(paths, overrides = {}, existing = {}) {
  const existingContext = savedContextOptions(existing);
  const existingHeaders = existingContext.extraHTTPHeaders && typeof existingContext.extraHTTPHeaders === 'object'
    ? existingContext.extraHTTPHeaders
    : {};
  return {
    browser: {
      ...(existing.browser && typeof existing.browser === 'object' ? existing.browser : {}),
      browserName: 'chromium',
      isolated: true,
      contextOptions: {
        ...existingContext,
        storageState: paths.statePath,
        locale: overrides.locale || process.env.PLAYWRIGHT_SHARED_LOCALE || existingContext.locale || 'zh-CN',
        timezoneId: overrides.timezoneId || process.env.PLAYWRIGHT_SHARED_TIMEZONE || existingContext.timezoneId || 'Asia/Shanghai',
        extraHTTPHeaders: {
          ...existingHeaders,
          'Accept-Language': overrides.acceptLanguage || process.env.PLAYWRIGHT_SHARED_ACCEPT_LANGUAGE || existingHeaders['Accept-Language'] || 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      },
    },
  };
}

function ensureSharedAuth(options = {}) {
  const paths = resolvePaths(options.authDir);
  ensureDir(paths.authDir);
  if (!fs.existsSync(paths.statePath)) writeJsonAtomic(paths.statePath, { cookies: [], origins: [] });
  if (!fs.existsSync(paths.contextOptionsPath)) writeJsonAtomic(paths.contextOptionsPath, buildCliConfig(paths, options));
  if (!fs.existsSync(paths.metadataPath)) {
    const now = new Date().toISOString();
    writeJsonAtomic(paths.metadataPath, { createdAt: now, updatedAt: now, sites: [] });
  }
  setPrivateMode(paths.statePath, 0o600);
  setPrivateMode(paths.contextOptionsPath, 0o600);
  setPrivateMode(paths.metadataPath, 0o600);
  return { paths, cliConfig: readJson(paths.contextOptionsPath) };
}

function configureSharedAuth(options = {}) {
  const { paths, cliConfig: existing } = ensureSharedAuth(options);
  const cliConfig = buildCliConfig(paths, options, existing);
  writeJsonAtomic(paths.contextOptionsPath, cliConfig);
  return { paths, cliConfig };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.stdio || 'inherit',
    windowsHide: true,
    encoding: options.encoding,
    timeout: options.timeout,
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr && String(result.stderr).trim();
    const error = new Error(`${command} ${args.join(' ')} exited with ${result.status}${detail ? `: ${detail}` : ''}`);
    error.status = result.status;
    throw error;
  }
  return result;
}

function findSkillFile(startDir, relativePath) {
  let current = path.resolve(startDir);
  for (let depth = 0; depth < 10; depth++) {
    const candidate = path.join(current, relativePath);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function inspectPlaywrightDependencies(options = {}) {
  const cliCommand = options.cliCommand || process.env.PLAYWRIGHT_CLI_COMMAND || 'playwright-cli';
  let cliVersion = null;
  let cliError = null;
  try {
    const result = run(cliCommand, ['--version'], {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 5_000,
      env: { NO_UPDATE_NOTIFIER: '1' },
    });
    cliVersion = String(result.stdout || result.stderr || '').trim() || 'installed';
  } catch (error) {
    cliError = error.code === 'ETIMEDOUT' ? 'playwright-cli-version-check-timed-out' : 'playwright-cli-not-found';
  }

  const cwd = options.cwd || process.cwd();
  const homeDir = options.homeDir || os.homedir();
  const skillCandidates = [
    findSkillFile(cwd, path.join('.agents', 'skills', 'playwright-cli', 'SKILL.md')),
    findSkillFile(cwd, path.join('.claude', 'skills', 'playwright-cli', 'SKILL.md')),
    path.join(homeDir, '.agents', 'skills', 'playwright-cli', 'SKILL.md'),
    path.join(homeDir, '.claude', 'skills', 'playwright-cli', 'SKILL.md'),
    path.join(homeDir, '.codex', 'skills', 'playwright-cli', 'SKILL.md'),
  ].filter(Boolean);
  const skillPath = skillCandidates.find((candidate) => fs.existsSync(candidate)) || null;

  return {
    ready: Boolean(cliVersion && skillPath),
    cli: { ready: Boolean(cliVersion), command: cliCommand, version: cliVersion, error: cliError },
    skill: { ready: Boolean(skillPath), path: skillPath },
    install: {
      url: PLAYWRIGHT_CLI_INSTALL_URL,
      cli: 'npm install -g @playwright/cli@latest',
      skill: 'playwright-cli install --skills=agents',
      browser: 'playwright-cli install-browser chromium',
    },
  };
}

function inspectSharedAuth(options = {}) {
  const paths = resolvePaths(options.authDir);
  const issues = [];
  let cliConfig;
  let state;
  let metadata;

  for (const [name, file] of [
    ['storage-state', paths.statePath],
    ['context-options', paths.contextOptionsPath],
    ['metadata', paths.metadataPath],
  ]) {
    if (!fs.existsSync(file)) {
      issues.push(`missing-${name}`);
      continue;
    }
    try {
      const value = readJson(file);
      if (name === 'storage-state') state = value;
      if (name === 'context-options') cliConfig = value;
      if (name === 'metadata') metadata = value;
    } catch {
      issues.push(`invalid-${name}`);
    }
  }

  const storageStateValid = Boolean(state && Array.isArray(state.cookies) && Array.isArray(state.origins));
  if (state && !storageStateValid) issues.push('invalid-storage-state-shape');

  const cliConfigShapeValid = Boolean(cliConfig?.browser?.contextOptions);
  if (cliConfig && !cliConfigShapeValid) issues.push('invalid-playwright-cli-config-shape');
  const contextOptions = cliConfigShapeValid ? cliConfig.browser.contextOptions : null;
  const contextStorageMatches = contextOptions?.storageState === paths.statePath;
  if (cliConfigShapeValid && !contextStorageMatches) issues.push('context-storage-state-path-mismatch');

  const dependencies = inspectPlaywrightDependencies(options);
  if (!dependencies.cli.ready) issues.push(dependencies.cli.error);
  if (!dependencies.skill.ready) issues.push('playwright-cli-skill-missing');

  const configurationReady = storageStateValid && cliConfigShapeValid && contextStorageMatches && Boolean(metadata);
  const cookieCount = storageStateValid ? state.cookies.length : 0;
  const originCount = storageStateValid ? state.origins.length : 0;
  return {
    authDir: paths.authDir,
    setupRequired: !configurationReady || !dependencies.ready,
    issues: [...new Set(issues.filter(Boolean))],
    configuration: {
      ready: configurationReady,
      locale: contextOptions?.locale || null,
      timezoneId: contextOptions?.timezoneId || null,
      acceptLanguage: contextOptions?.extraHTTPHeaders?.['Accept-Language'] || null,
      metadataPresent: Boolean(metadata),
    },
    dependencies,
    authentication: {
      hasSavedState: cookieCount > 0 || originCount > 0,
      cookieCount,
      originCount,
    },
  };
}

function assertCliConfigReady(cliConfig, paths) {
  if (!cliConfig?.browser?.contextOptions || cliConfig.browser.contextOptions.storageState !== paths.statePath) {
    const error = new Error('Shared Playwright CLI configuration is not ready. Run the Setup subflow before Login or Launch.');
    error.code = 'PLAYWRIGHT_CLI_CONFIG_NOT_READY';
    throw error;
  }
  return cliConfig;
}

function assertSessionName(sessionName) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(sessionName || '')) {
    throw new Error('Session names must be 1-64 characters using letters, digits, dots, underscores, or hyphens.');
  }
  return sessionName;
}

function createSessionName(prefix = 'shared-auth') {
  return assertSessionName(`${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`);
}

function playwrightCliArgs(sessionName, command, commandArgs = []) {
  return [`-s=${assertSessionName(sessionName)}`, command, ...commandArgs];
}

function dependencyError(dependencies) {
  const missing = [];
  if (!dependencies.cli.ready) missing.push('the official playwright-cli executable');
  if (!dependencies.skill.ready) missing.push('the official playwright-cli companion Skill');
  const error = new Error(
    `Missing ${missing.join(' and ')}. Follow ${PLAYWRIGHT_CLI_INSTALL_URL}. Recommended commands: `
    + `${dependencies.install.cli}; ${dependencies.install.skill}; ${dependencies.install.browser}.`,
  );
  error.code = 'PLAYWRIGHT_CLI_DEPENDENCY_MISSING';
  return error;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code !== 'ESRCH';
  }
}

function removeStaleLock(lockPath) {
  try {
    const lock = readJson(lockPath);
    if (lock.hostname === os.hostname() && Number.isInteger(lock.pid) && !isProcessAlive(lock.pid)) {
      fs.unlinkSync(lockPath);
      return true;
    }
  } catch {
    try {
      const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (ageMs > CORRUPT_LOCK_GRACE_MS) {
        fs.unlinkSync(lockPath);
        return true;
      }
    } catch {
      return false;
    }
  }
  return false;
}

function acquireLock(lockPath) {
  ensureDir(path.dirname(lockPath));
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = randomUUID();
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify({ token, pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() }, null, 2)}\n`);
      } finally {
        fs.closeSync(fd);
      }
      setPrivateMode(lockPath, 0o600);
      return () => {
        try {
          const current = readJson(lockPath);
          if (current.token === token) fs.unlinkSync(lockPath);
        } catch (error) {
          if (!error || error.code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if (error && error.code === 'EEXIST' && attempt === 0 && removeStaleLock(lockPath)) continue;
      if (error && error.code === 'EEXIST') {
        const locked = new Error(`Another shared-auth save is active. Lock: ${lockPath}`);
        locked.code = 'AUTH_STATE_LOCKED';
        throw locked;
      }
      throw error;
    }
  }
  throw new Error(`Unable to acquire lock: ${lockPath}`);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

module.exports = {
  PLAYWRIGHT_CLI_INSTALL_URL,
  acquireLock,
  assertCliConfigReady,
  assertSessionName,
  buildCliConfig,
  configureSharedAuth,
  createSessionName,
  defaultAuthDir,
  dependencyError,
  ensureDir,
  ensureSharedAuth,
  inspectPlaywrightDependencies,
  inspectSharedAuth,
  parseArgs,
  playwrightCliArgs,
  printJson,
  protectPrivateFile,
  readJson,
  resolvePaths,
  run,
  sanitizeError,
  sanitizeUrl,
  savedContextOptions,
  writeJsonAtomic,
};
