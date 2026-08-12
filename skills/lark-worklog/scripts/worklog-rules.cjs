#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

class WorklogRulesError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorklogRulesError';
    this.code = code;
  }
}

function parseArguments(argv) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }
    const equals = argument.indexOf('=');
    if (equals !== -1) {
      options[argument.slice(2, equals)] = argument.slice(equals + 1);
      continue;
    }
    const key = argument.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return { positionals, options };
}

function printHelp() {
  process.stdout.write(
    'Usage:\n' +
    '  worklog-rules.cjs date\n' +
    '  worklog-rules.cjs carry < previous-cell.txt\n\n' +
    'This helper is stateless: it reads no configuration and writes no files.\n',
  );
}

function dateIdentity(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  const key = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    key,
    month: `${parts.year}${parts.month}`,
    header: `${parts.year}/${parts.month}/${parts.day} ${parts.weekday}`,
  };
}

function previousMonth(monthKey) {
  const match = String(monthKey || '').match(/^(\d{4})(\d{2})$/);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) {
    throw new WorklogRulesError('INVALID_MONTH', 'Month must use YYYYMM format.');
  }
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 2, 1));
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function carryDailyText(value) {
  return String(value || '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*\[[xX]\]/.test(line))
    .join('\n')
    .trim();
}

function outputJson(data) {
  process.stdout.write(`${JSON.stringify({ ok: true, data }, null, 2)}\n`);
}

function main(argv = process.argv.slice(2)) {
  const { positionals, options } = parseArguments(argv);
  const [command] = positionals;
  if (!command || command === 'help' || options.help) {
    printHelp();
    return;
  }
  if (command === 'date') {
    if (options.timezone) {
      throw new WorklogRulesError('UNSUPPORTED_ARGUMENT', 'Timezone configuration is not supported.');
    }
    outputJson(dateIdentity(new Date()));
    return;
  }
  if (command === 'carry') {
    outputJson({ value: carryDailyText(fs.readFileSync(0, 'utf8')) });
    return;
  }
  throw new WorklogRulesError('UNKNOWN_COMMAND', 'Unknown command. Run with --help for usage.');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const normalized = error instanceof WorklogRulesError
      ? error
      : new WorklogRulesError('UNEXPECTED_ERROR', String(error?.message || error));
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: { code: normalized.code, message: normalized.message },
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  WorklogRulesError,
  carryDailyText,
  dateIdentity,
  parseArguments,
  previousMonth,
};
