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
    '  worklog-rules.cjs carry < previous-cell.txt\n' +
    '  worklog-rules.cjs day-plan --source-column <B|C|...> --last-row <n>\n\n' +
    'This helper is stateless: it reads no configuration and writes no files.\n',
  );
}

function columnToIndex(column) {
  const normalized = String(column || '').trim().toUpperCase();
  if (!/^[A-Z]+$/.test(normalized)) {
    throw new WorklogRulesError('INVALID_COLUMN', 'Column must contain only A-Z letters.');
  }
  let index = 0;
  for (const character of normalized) index = index * 26 + character.charCodeAt(0) - 64;
  return index - 1;
}

function indexToColumn(index) {
  if (!Number.isInteger(index) || index < 0) {
    throw new WorklogRulesError('INVALID_COLUMN_INDEX', 'Column index must be a non-negative integer.');
  }
  let value = index + 1;
  let column = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    column = String.fromCharCode(65 + remainder) + column;
    value = Math.floor((value - 1) / 26);
  }
  return column;
}

function dayRolloverPlan({ sourceColumn, lastRow }) {
  const normalizedSource = String(sourceColumn || '').trim().toUpperCase();
  const sourceIndex = columnToIndex(normalizedSource);
  const normalizedLastRow = Number(lastRow);
  if (sourceIndex < 1) {
    throw new WorklogRulesError('INVALID_SOURCE_COLUMN', 'The source date column must be B or later.');
  }
  if (!Number.isInteger(normalizedLastRow) || normalizedLastRow < 2) {
    throw new WorklogRulesError('INVALID_LAST_ROW', 'Last row must be an integer greater than or equal to 2.');
  }
  const shiftedSource = indexToColumn(sourceIndex + 1);
  return {
    insert: {
      position: 'B',
      count: 1,
      inherit_style: 'after',
    },
    inserted_column: 'B',
    source_column_before_insert: normalizedSource,
    source_column_after_insert: shiftedSource,
    format_source_range_after_insert: `${shiftedSource}1:${shiftedSource}${normalizedLastRow}`,
    target_range: `B1:B${normalizedLastRow}`,
  };
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
  if (command === 'day-plan') {
    outputJson(dayRolloverPlan({
      sourceColumn: options['source-column'],
      lastRow: options['last-row'],
    }));
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
  columnToIndex,
  dateIdentity,
  dayRolloverPlan,
  indexToColumn,
  parseArguments,
  previousMonth,
};
