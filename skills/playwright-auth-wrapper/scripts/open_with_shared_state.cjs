#!/usr/bin/env node
'use strict';

const {
  assertCliConfigReady,
  createSessionName,
  dependencyError,
  ensureSharedAuth,
  inspectPlaywrightDependencies,
  parseArgs,
  playwrightCliArgs,
  printJson,
  run,
  sanitizeError,
  sanitizeUrl,
} = require('./shared_auth_common.cjs');

function launchSession(options = {}) {
  const dependencies = options.dependencies || inspectPlaywrightDependencies(options);
  if (!dependencies.ready) throw dependencyError(dependencies);

  const { paths, cliConfig } = ensureSharedAuth({ authDir: options.authDir });
  assertCliConfigReady(cliConfig, paths);
  const sessionName = options.session || createSessionName('shared-auth');
  const commandArgs = [];
  if (options.url) commandArgs.push(options.url);
  commandArgs.push(`--config=${paths.contextOptionsPath}`);
  if (options.headed) commandArgs.push('--headed');

  const cliArgs = playwrightCliArgs(sessionName, 'open', commandArgs);
  const runCommand = options.runCommand || run;
  runCommand(dependencies.cli.command, cliArgs, {
    stdio: options.stdio || 'inherit',
    cwd: options.cwd,
    env: { NO_UPDATE_NOTIFIER: '1' },
  });

  return {
    ok: true,
    event: 'session-ready',
    sessionName,
    initialUrl: options.url ? sanitizeUrl(options.url) : 'about:blank',
    commandPrefix: `${dependencies.cli.command} -s=${sessionName}`,
    closeCommand: `${dependencies.cli.command} -s=${sessionName} close`,
    statePath: paths.statePath,
    stateReadOnly: true,
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = launchSession({
    authDir: args.authDir,
    session: args.session,
    url: args.url || args._[0],
    headed: Boolean(args.headed),
  });
  printJson(result);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    printJson({ ok: false, error: sanitizeError(error) });
    process.exit(1);
  }
}

module.exports = { launchSession, main };
