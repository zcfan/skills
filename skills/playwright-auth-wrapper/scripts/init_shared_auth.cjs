#!/usr/bin/env node
'use strict';

const { configureSharedAuth, parseArgs, printJson } = require('./shared_auth_common.cjs');
const args = parseArgs(process.argv.slice(2));
const configured = configureSharedAuth({ authDir: args.authDir, locale: args.locale, timezoneId: args.timezone, acceptLanguage: args.acceptLanguage });
printJson({ ok: true, ...configured });
