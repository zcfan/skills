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
    '  worklog-rules.cjs day-plan --source-column <B|C|...> --last-row <n>\n' +
    '  worklog-rules.cjs mention-link --base-url <url> --token <token>\n' +
    '  worklog-rules.cjs resolve-mentions --document-base-url <url> < rich-text.json\n' +
    '  worklog-rules.cjs set-status --sheet-id <id> --rows <spec> [--status <text>]\n' +
    '    [--document-base-url <url>] [--writes-only] < cells-get.json\n\n' +
    'This helper is stateless: it reads no configuration and writes no files.\n',
  );
}

function readJsonStdin() {
  const input = fs.readFileSync(0, 'utf8').trim();
  if (!input) throw new WorklogRulesError('MISSING_INPUT', 'Expected JSON on stdin.');
  try {
    return JSON.parse(input);
  } catch (error) {
    throw new WorklogRulesError('INVALID_JSON', `Invalid JSON on stdin: ${error.message}`);
  }
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

function buildMentionLink(mentionToken, documentBaseUrl) {
  const token = String(mentionToken || '').trim();
  if (!token) throw new WorklogRulesError('INVALID_MENTION_TOKEN', 'Mention token is required.');
  if (!documentBaseUrl) {
    throw new WorklogRulesError('MISSING_DOCUMENT_BASE_URL', 'A verified document base URL is required.');
  }
  let base;
  try {
    base = new URL(String(documentBaseUrl));
  } catch {
    throw new WorklogRulesError('INVALID_DOCUMENT_BASE_URL', 'Document base URL must be an absolute URL.');
  }
  if (!['http:', 'https:'].includes(base.protocol)) {
    throw new WorklogRulesError('INVALID_DOCUMENT_BASE_URL', 'Document base URL must use HTTP or HTTPS.');
  }
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/${encodeURIComponent(token)}`;
  base.search = '';
  base.hash = '';
  return base.toString();
}

function isDocumentMention(segment) {
  return segment?.type === 'mention'
    && segment.mention_type !== undefined
    && Number(segment.mention_type) !== 0;
}

function resolveMentions(richText, { documentBaseUrl, linkByToken = {} } = {}) {
  if (!Array.isArray(richText)) {
    throw new WorklogRulesError('INVALID_RICH_TEXT', 'Rich text must be an array.');
  }
  return richText.map((segment) => {
    const resolved = { ...segment };
    if (!isDocumentMention(resolved) || resolved.link) return resolved;
    const token = String(resolved.mention_token || '').trim();
    if (!token) {
      throw new WorklogRulesError('INVALID_MENTION_TOKEN', 'Document mention is missing mention_token.');
    }
    const mapped = linkByToken[token];
    if (mapped) {
      resolved.link = String(mapped);
      return resolved;
    }
    if (documentBaseUrl) {
      resolved.link = buildMentionLink(token, documentBaseUrl);
      return resolved;
    }
    throw new WorklogRulesError(
      'UNRESOLVED_MENTION_LINK',
      `No document URL is available for mention token ${token}.`,
    );
  });
}

function normalizeStatus(status) {
  const normalized = String(status || '').trim();
  if (!normalized || /[\r\n]/.test(normalized)) {
    throw new WorklogRulesError('INVALID_STATUS', 'Status must be a non-empty single line.');
  }
  const value = normalized.replace(/^状态：\s*/, '').trim();
  if (!value) throw new WorklogRulesError('INVALID_STATUS', 'Status value cannot be empty.');
  return value;
}

function parseRowRange(value) {
  const match = String(value || '').trim().match(/^(\d+)(?:-(\d+))?$/);
  if (!match) throw new WorklogRulesError('INVALID_ROW_SPEC', `Invalid row range: ${value}`);
  const start = Number(match[1]);
  const end = Number(match[2] || match[1]);
  if (start < 1 || end < start) {
    throw new WorklogRulesError('INVALID_ROW_SPEC', `Invalid row range: ${value}`);
  }
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function parseRowStatusSpec(spec, defaultStatus) {
  const result = new Map();
  const source = String(spec || '').trim();
  if (!source) throw new WorklogRulesError('INVALID_ROW_SPEC', 'At least one row is required.');
  for (const entry of source.split(',').map((part) => part.trim()).filter(Boolean)) {
    const separator = entry.indexOf(':');
    const range = separator === -1 ? entry : entry.slice(0, separator);
    const status = normalizeStatus(separator === -1 ? defaultStatus : entry.slice(separator + 1));
    for (const row of parseRowRange(range)) {
      if (result.has(row)) {
        throw new WorklogRulesError('DUPLICATE_ROW', `Row ${row} appears more than once.`);
      }
      result.set(row, status);
    }
  }
  return result;
}

function stripStatusLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => !/^[ \t]*状态：/.test(line))
    .join('\n');
}

function richTextForCell(cell) {
  const richText = cell?.rich_text || cell?.value?.rich_text;
  if (Array.isArray(richText)) return richText;
  const value = cell?.value;
  return value === undefined || value === null || value === ''
    ? []
    : [{ type: 'text', text: String(value) }];
}

function setRichTextStatus(richText, status, options) {
  const normalizedStatus = normalizeStatus(status);
  const resolved = resolveMentions(richText, options)
    .map((segment) => segment.type === 'text'
      ? { ...segment, text: stripStatusLines(segment.text) }
      : segment)
    .filter((segment) => segment.type !== 'text' || segment.text !== '');
  const hasContent = resolved.some((segment) => String(segment.text || '').length > 0);
  const trailingText = resolved.at(-1)?.type === 'text' ? resolved.at(-1).text : '';
  const separator = hasContent && !/\r?\n$/.test(trailingText) ? '\n' : '';
  resolved.push({ type: 'text', text: `${separator}状态：${normalizedStatus}` });
  return resolved;
}

function cellRecords(cellsGet) {
  const data = cellsGet?.data || cellsGet;
  if (Array.isArray(data?.records)) {
    return new Map(data.records.map((record) => [Number(record.row), record.cell]));
  }
  const ranges = Array.isArray(data?.ranges) ? data.ranges : [];
  const records = new Map();
  for (const range of ranges) {
    const rows = Array.isArray(range.row_indices) ? range.row_indices : [];
    const columns = Array.isArray(range.col_indices) ? range.col_indices : [];
    const columnIndex = columns.length ? columns.indexOf('A') : 0;
    if (columnIndex < 0) continue;
    for (let index = 0; index < rows.length; index += 1) {
      const rowCells = Array.isArray(range.cells?.[index]) ? range.cells[index] : [];
      records.set(Number(rows[index]), rowCells[columnIndex]);
    }
  }
  return records;
}

function mentionSnapshot(richText) {
  return richText
    .filter((segment) => segment.type === 'mention')
    .map((segment) => ({
      mention_token: segment.mention_token,
      mention_type: segment.mention_type,
      link: segment.link,
    }));
}

function backgroundColor(cell) {
  return cell?.cell_styles?.background_color
    ?? cell?.style?.background_color
    ?? null;
}

function assertCompleteCellsGet(cellsGet) {
  const data = cellsGet?.data || cellsGet;
  const scopes = [cellsGet];
  if (data !== cellsGet) scopes.push(data);
  if (Array.isArray(data?.ranges)) scopes.push(...data.ranges);
  const incomplete = scopes.some((scope) => scope && (
    scope.complete === false
    || scope.truncated === true
    || scope.has_more === true
  ));
  if (incomplete) {
    throw new WorklogRulesError(
      'INCOMPLETE_CELLS_GET',
      'The cells-get input is truncated or paginated. Read the target cells completely before planning writes.',
    );
  }
}

function buildStatusWrites(cellsGet, {
  sheetId,
  sheetName,
  rowStatuses,
  documentBaseUrl,
  linkByToken,
} = {}) {
  if ((!sheetId && !sheetName) || (sheetId && sheetName)) {
    throw new WorklogRulesError('INVALID_SHEET', 'Provide exactly one of sheetId or sheetName.');
  }
  assertCompleteCellsGet(cellsGet);
  const statuses = rowStatuses instanceof Map
    ? rowStatuses
    : new Map(Object.entries(rowStatuses || {}).map(([row, status]) => [Number(row), status]));
  if (!statuses.size) throw new WorklogRulesError('INVALID_ROW_SPEC', 'At least one row is required.');
  const records = cellRecords(cellsGet);
  const writes = [];
  const expectations = [];
  for (const [row, status] of statuses) {
    const cell = records.get(Number(row));
    if (!cell) throw new WorklogRulesError('ROW_NOT_READ', `Row ${row} is absent from the cells-get input.`);
    const richText = setRichTextStatus(richTextForCell(cell), status, { documentBaseUrl, linkByToken });
    writes.push({
      ...(sheetId ? { sheet_id: sheetId } : { sheet_name: sheetName }),
      range: `A${row}`,
      cells: [[{ rich_text: richText }]],
    });
    expectations.push({
      row: Number(row),
      status: normalizeStatus(status),
      mention_tokens: mentionSnapshot(richText),
      background_color: backgroundColor(cell),
    });
  }
  return { writes, expectations };
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
  if (command === 'mention-link') {
    outputJson({
      link: buildMentionLink(options.token, options['base-url']),
    });
    return;
  }
  if (command === 'resolve-mentions') {
    const input = readJsonStdin();
    const richText = Array.isArray(input) ? input : input.rich_text;
    outputJson({
      rich_text: resolveMentions(richText, {
        documentBaseUrl: options['document-base-url'] || input.document_base_url,
        linkByToken: input.link_by_token,
      }),
    });
    return;
  }
  if (command === 'set-status') {
    const input = readJsonStdin();
    const plan = buildStatusWrites(input, {
      sheetId: options['sheet-id'],
      sheetName: options['sheet-name'],
      rowStatuses: parseRowStatusSpec(options.rows, options.status),
      documentBaseUrl: options['document-base-url'],
      linkByToken: input.link_by_token,
    });
    if (options['writes-only']) {
      process.stdout.write(`${JSON.stringify(plan.writes, null, 2)}\n`);
    } else {
      outputJson(plan);
    }
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
  assertCompleteCellsGet,
  buildMentionLink,
  buildStatusWrites,
  carryDailyText,
  cellRecords,
  columnToIndex,
  dateIdentity,
  dayRolloverPlan,
  indexToColumn,
  parseArguments,
  parseRowStatusSpec,
  previousMonth,
  resolveMentions,
  setRichTextStatus,
};
