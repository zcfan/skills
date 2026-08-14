#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { randomUUID } = require('crypto');
const {
  acquireLock,
  assertCliConfigReady,
  createSessionName,
  dependencyError,
  ensureSharedAuth,
  inspectPlaywrightDependencies,
  parseArgs,
  playwrightCliArgs,
  printJson,
  readJson,
  run,
  sanitizeError,
  sanitizeUrl,
  writeJsonAtomic,
} = require('./shared_auth_common.cjs');

function requireDependencies(options) {
  const dependencies = options.dependencies || inspectPlaywrightDependencies(options);
  if (!dependencies.ready) throw dependencyError(dependencies);
  return dependencies;
}

function startLogin(options = {}) {
  if (!options.url) throw new Error('Login start requires --url <login-or-target-url>.');
  const dependencies = requireDependencies(options);
  const { paths, cliConfig } = ensureSharedAuth({ authDir: options.authDir });
  assertCliConfigReady(cliConfig, paths);
  const sessionName = options.session || createSessionName('shared-auth-login');
  const cliArgs = playwrightCliArgs(sessionName, 'open', [
    options.url,
    `--config=${paths.contextOptionsPath}`,
    '--headed',
  ]);
  const runCommand = options.runCommand || run;
  runCommand(dependencies.cli.command, cliArgs, {
    stdio: options.stdio || 'inherit',
    cwd: options.cwd,
    env: { NO_UPDATE_NOTIFIER: '1' },
  });
  return {
    ok: true,
    event: 'ready-for-user',
    sessionName,
    url: sanitizeUrl(options.url),
    commandPrefix: `${dependencies.cli.command} -s=${sessionName}`,
    saveCommand: `node <skill-directory>/scripts/login_and_save_state.cjs save --session ${sessionName}`,
    cancelCommand: `node <skill-directory>/scripts/login_and_save_state.cjs cancel --session ${sessionName}`,
    saved: false,
  };
}

function saveLogin(options = {}) {
  if (!options.session) throw new Error('Login save requires --session <name> from Login start.');
  const dependencies = requireDependencies(options);
  const { paths } = ensureSharedAuth({ authDir: options.authDir });
  const runCommand = options.runCommand || run;
  const temporaryStatePath = `${paths.statePath}.${randomUUID()}.tmp`;
  let releaseLock;
  try {
    releaseLock = acquireLock(paths.lockPath);
    runCommand(
      dependencies.cli.command,
      playwrightCliArgs(options.session, 'state-save', [temporaryStatePath]),
      { stdio: options.stdio || 'inherit', cwd: options.cwd, env: { NO_UPDATE_NOTIFIER: '1' } },
    );
    const state = readJson(temporaryStatePath);
    if (!Array.isArray(state.cookies) || !Array.isArray(state.origins)) {
      throw new Error('playwright-cli returned an invalid storage state. Shared state was not changed.');
    }
    writeJsonAtomic(paths.statePath, state);
    const oldMetadata = readJson(paths.metadataPath);
    const metadata = {
      ...oldMetadata,
      updatedAt: new Date().toISOString(),
      cookieCount: state.cookies.length,
      originCount: state.origins.length,
      cookieDomains: [...new Set(state.cookies.map((cookie) => cookie.domain).filter(Boolean))].sort(),
    };
    writeJsonAtomic(paths.metadataPath, metadata);
    runCommand(
      dependencies.cli.command,
      playwrightCliArgs(options.session, 'close'),
      { stdio: options.stdio || 'inherit', cwd: options.cwd, env: { NO_UPDATE_NOTIFIER: '1' } },
    );
    return {
      ok: true,
      event: 'saved',
      sessionName: options.session,
      statePath: paths.statePath,
      metadataPath: paths.metadataPath,
      cookieCount: metadata.cookieCount,
      originCount: metadata.originCount,
    };
  } finally {
    fs.rmSync(temporaryStatePath, { force: true });
    if (releaseLock) releaseLock();
  }
}

function cancelLogin(options = {}) {
  if (!options.session) throw new Error('Login cancel requires --session <name> from Login start.');
  const dependencies = requireDependencies(options);
  const runCommand = options.runCommand || run;
  runCommand(
    dependencies.cli.command,
    playwrightCliArgs(options.session, 'close'),
    { stdio: options.stdio || 'inherit', cwd: options.cwd, env: { NO_UPDATE_NOTIFIER: '1' } },
  );
  return { ok: true, event: 'cancelled', sessionName: options.session, saved: false };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const action = args._[0] || 'start';
  const options = {
    authDir: args.authDir,
    session: args.session,
    url: args.url,
  };
  if (action === 'start') return printJson(startLogin(options));
  if (action === 'save') return printJson(saveLogin(options));
  if (action === 'cancel') return printJson(cancelLogin(options));
  throw new Error('Usage: login_and_save_state.cjs <start|save|cancel> [options].');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    printJson({ ok: false, error: sanitizeError(error) });
    process.exit(1);
  }
}

module.exports = { cancelLogin, main, saveLogin, startLogin };
