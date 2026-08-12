#!/usr/bin/env node
'use strict';

const {
  inspectSharedAuth,
  parseArgs,
  printJson,
  sanitizeError,
} = require('./shared_auth_common.cjs');

try {
  const args = parseArgs(process.argv.slice(2));
  const status = inspectSharedAuth({ authDir: args.authDir });
  printJson({ ok: true, ...status });
} catch (error) {
  printJson({ ok: false, error: sanitizeError(error) });
  process.exitCode = 1;
}
