'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');

const PLAYWRIGHT_VERSION = '1.62.1';
const CORRUPT_LOCK_GRACE_MS = 30_000;

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
    runtimeDir: path.join(authDir, 'runtime'),
  };
}

function setPrivateMode(target, mode) {
  if (process.platform !== 'win32') fs.chmodSync(target, mode);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  setPrivateMode(dir, 0o700);
}

function createPrivateTempFile(prefix, filename) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  setPrivateMode(directory, 0o700);
  return path.join(directory, filename);
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

function buildContextOptions(paths, overrides = {}, existing = {}) {
  const existingHeaders = existing.extraHTTPHeaders && typeof existing.extraHTTPHeaders === 'object'
    ? existing.extraHTTPHeaders
    : {};
  return {
    storageState: paths.statePath,
    locale: overrides.locale || process.env.PLAYWRIGHT_SHARED_LOCALE || existing.locale || 'zh-CN',
    timezoneId: overrides.timezoneId || process.env.PLAYWRIGHT_SHARED_TIMEZONE || existing.timezoneId || 'Asia/Shanghai',
    extraHTTPHeaders: {
      ...existingHeaders,
      'Accept-Language': overrides.acceptLanguage || process.env.PLAYWRIGHT_SHARED_ACCEPT_LANGUAGE || existingHeaders['Accept-Language'] || 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  };
}

function ensureSharedAuth(options = {}) {
  const paths = resolvePaths(options.authDir);
  ensureDir(paths.authDir);
  if (!fs.existsSync(paths.statePath)) writeJsonAtomic(paths.statePath, { cookies: [], origins: [] });
  if (!fs.existsSync(paths.contextOptionsPath)) writeJsonAtomic(paths.contextOptionsPath, buildContextOptions(paths, options));
  if (!fs.existsSync(paths.metadataPath)) {
    const now = new Date().toISOString();
    writeJsonAtomic(paths.metadataPath, { createdAt: now, updatedAt: now, sites: [] });
  }
  setPrivateMode(paths.statePath, 0o600);
  setPrivateMode(paths.contextOptionsPath, 0o600);
  setPrivateMode(paths.metadataPath, 0o600);
  return { paths, contextOptions: readJson(paths.contextOptionsPath) };
}

function configureSharedAuth(options = {}) {
  const { paths, contextOptions: existing } = ensureSharedAuth(options);
  const contextOptions = buildContextOptions(paths, options, existing);
  writeJsonAtomic(paths.contextOptionsPath, contextOptions);
  return { paths, contextOptions };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.stdio || 'inherit',
    shell: process.platform === 'win32',
    windowsHide: true,
    encoding: options.encoding,
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

function loadPlaywright(authDir) {
  const failures = [];
  try {
    const packageRoot = path.join(resolvePaths(authDir).runtimeDir, 'node_modules', 'playwright');
    return { playwright: require(packageRoot), packageRoot, source: 'shared-runtime' };
  } catch (error) {
    failures.push(`shared runtime: ${error && error.message || error}`);
  }
  try {
    const packageJsonPath = require.resolve('playwright/package.json');
    const packageRoot = path.dirname(packageJsonPath);
    return { playwright: require(packageRoot), packageRoot, source: 'local-fallback' };
  } catch (error) {
    failures.push(`local: ${error && error.message || error}`);
  }
  throw new Error(`Playwright is unavailable. Run the Setup subflow of playwright-auth-wrapper first. ${failures.join(' | ')}`);
}

function inspectSharedAuth(options = {}) {
  const paths = resolvePaths(options.authDir);
  const issues = [];
  let contextOptions;
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
      if (name === 'context-options') contextOptions = value;
      if (name === 'metadata') metadata = value;
    } catch {
      issues.push(`invalid-${name}`);
    }
  }

  const storageStateValid = Boolean(state && Array.isArray(state.cookies) && Array.isArray(state.origins));
  if (state && !storageStateValid) issues.push('invalid-storage-state-shape');

  const contextStorageMatches = contextOptions?.storageState === paths.statePath;
  if (contextOptions && !contextStorageMatches) {
    issues.push('context-storage-state-path-mismatch');
  }

  const packageRoot = path.join(paths.runtimeDir, 'node_modules', 'playwright');
  let installedVersion = null;
  let chromiumInstalled = false;
  try {
    installedVersion = readJson(path.join(packageRoot, 'package.json')).version || null;
    if (installedVersion !== PLAYWRIGHT_VERSION) issues.push('playwright-version-mismatch');
    const playwright = require(packageRoot);
    const executablePath = playwright.chromium?.executablePath?.();
    chromiumInstalled = Boolean(executablePath && fs.existsSync(executablePath));
    if (!chromiumInstalled) issues.push('chromium-not-installed');
  } catch {
    issues.push('playwright-runtime-missing');
  }

  const configurationReady = storageStateValid && contextStorageMatches && Boolean(metadata);
  const runtimeReady = installedVersion === PLAYWRIGHT_VERSION && chromiumInstalled;
  const cookieCount = storageStateValid ? state.cookies.length : 0;
  const originCount = storageStateValid ? state.origins.length : 0;
  return {
    authDir: paths.authDir,
    setupRequired: !configurationReady || !runtimeReady,
    issues: [...new Set(issues)],
    configuration: {
      ready: configurationReady,
      locale: contextOptions?.locale || null,
      timezoneId: contextOptions?.timezoneId || null,
      acceptLanguage: contextOptions?.extraHTTPHeaders?.['Accept-Language'] || null,
      metadataPresent: Boolean(metadata),
    },
    runtime: {
      ready: runtimeReady,
      expectedVersion: PLAYWRIGHT_VERSION,
      installedVersion,
      chromiumInstalled,
    },
    authentication: {
      hasSavedState: cookieCount > 0 || originCount > 0,
      cookieCount,
      originCount,
    },
  };
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
        const locked = new Error(`Another shared-auth login is active. Lock: ${lockPath}`);
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
  acquireLock,
  PLAYWRIGHT_VERSION,
  configureSharedAuth,
  createPrivateTempFile,
  defaultAuthDir,
  ensureDir,
  ensureSharedAuth,
  inspectSharedAuth,
  loadPlaywright,
  parseArgs,
  printJson,
  protectPrivateFile,
  readJson,
  resolvePaths,
  run,
  sanitizeError,
  sanitizeUrl,
  writeJsonAtomic,
};
