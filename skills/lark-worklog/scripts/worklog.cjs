#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CONFIG_VERSION = 1;
const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const DATE_HEADER_RE = /^(\d{4})\/(\d{2})\/(\d{2})(?:\s+(.+))?$/;
const MONTH_SHEET_RE = /^\d{6}$/;
const ALIAS_RE = /^别名\s*[：:]\s*(.*)$/;
const STATUS_RE = /^状态\s*[：:]\s*(.*)$/;
const COMPLETE_STATUS = '已完成';

class WorklogError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'WorklogError';
    this.code = code;
    this.details = details;
  }
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith('--')) {
      throw new WorklogError('INVALID_ARGUMENT', `Unexpected argument: ${item}`);
    }
    const key = item.slice(2);
    if (key === 'dry-run' || key === 'help') {
      options[key] = true;
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new WorklogError('INVALID_ARGUMENT', `Missing value for --${key}`);
    }
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function printHelp() {
  process.stdout.write(`Usage:\n\n` +
    `  worklog.cjs configure --url <spreadsheet-url> [--timezone <iana-timezone>]\n` +
    `  worklog.cjs inspect [--url <spreadsheet-url>]\n` +
    `  worklog.cjs prepare [--url <spreadsheet-url>] [--dry-run]\n\n` +
    `Environment:\n\n` +
    `  LARK_WORKLOG_CONFIG_DIR  Override the private configuration directory.\n` +
    `  LARK_WORKLOG_LARK_CLI    Override the lark-cli executable (tests only).\n`);
}

function configDirectory({
  env = process.env,
  platform = process.platform,
  homeDirectory = os.homedir(),
} = {}) {
  if (env.LARK_WORKLOG_CONFIG_DIR) return path.resolve(env.LARK_WORKLOG_CONFIG_DIR);
  if (platform === 'darwin') {
    return path.join(homeDirectory, 'Library', 'Application Support', 'lark-worklog');
  }
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(homeDirectory, 'AppData', 'Roaming');
    return path.join(appData, 'lark-worklog');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(homeDirectory, '.config'), 'lark-worklog');
}

function configPath(options) {
  return path.join(configDirectory(options), 'config.json');
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
}

function writePrivateJson(file, value) {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = path.join(path.dirname(file), `.config-${process.pid}-${Date.now()}.tmp`);
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
  if (process.platform !== 'win32') fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function loadConfig({ file = configPath() } = {}) {
  if (!fs.existsSync(file)) {
    throw new WorklogError(
      'CONFIG_REQUIRED',
      'No default work-log spreadsheet is configured. Ask for a spreadsheet link or permission to create one.',
    );
  }
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new WorklogError('CONFIG_INVALID', 'The private work-log configuration is invalid JSON.', {
      cause: error.message,
    });
  }
  if (value.version !== CONFIG_VERSION || !value.default_spreadsheet_url || !value.timezone) {
    throw new WorklogError('CONFIG_INVALID', 'The private work-log configuration has an unsupported shape.');
  }
  validateTimezone(value.timezone);
  return value;
}

function canonicalizeSpreadsheetUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new WorklogError('INVALID_SPREADSHEET_URL', 'Provide a valid http(s) Lark spreadsheet or wiki URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new WorklogError('INVALID_SPREADSHEET_URL', 'The spreadsheet URL must use http or https.');
  }
  const match = parsed.pathname.match(/^\/(sheets|spreadsheets|wiki)\/([^/]+)\/?$/);
  if (!match) {
    throw new WorklogError('INVALID_SPREADSHEET_URL', 'The URL must point to /sheets/, /spreadsheets/, or /wiki/.');
  }
  parsed.username = '';
  parsed.password = '';
  parsed.pathname = `/${match[1]}/${match[2]}`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function redactSensitiveText(input) {
  return String(input || '')
    .replace(/(https?:\/\/[^\s/]+\/(?:sheets|spreadsheets|wiki)\/)[^\s/?#]+/gi, '$1<redacted>')
    .replace(/\b(?:sht|docx)[A-Za-z0-9_-]{8,}\b/g, '<redacted-token>')
    .replace(/(access[_-]?token|refresh[_-]?token|authorization)(["'=:\s]+)[^\s",}]+/gi, '$1$2<redacted>');
}

function validateTimezone(timezone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new WorklogError('INVALID_TIMEZONE', `Invalid IANA timezone: ${timezone}`);
  }
}

function runLarkCli(args, { input, env = process.env } = {}) {
  const executable = env.LARK_WORKLOG_LARK_CLI || 'lark-cli';
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    input,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...env,
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
    },
  });
  if (result.error) {
    const code = result.error.code === 'ENOENT' ? 'LARK_CLI_NOT_FOUND' : 'LARK_CLI_FAILED';
    throw new WorklogError(code, redactSensitiveText(result.error.message));
  }
  if (result.status !== 0) {
    throw new WorklogError('LARK_CLI_FAILED', redactSensitiveText(result.stderr || result.stdout), {
      exit_code: result.status,
    });
  }
  let envelope;
  try {
    envelope = JSON.parse(result.stdout);
  } catch (error) {
    throw new WorklogError('LARK_CLI_INVALID_OUTPUT', 'lark-cli did not return valid JSON.', {
      cause: error.message,
    });
  }
  if (!envelope.ok) {
    throw new WorklogError('LARK_API_FAILED', redactSensitiveText(JSON.stringify(envelope.error || envelope)));
  }
  return envelope.data || {};
}

function createLarkClient({ invoke = runLarkCli } = {}) {
  return {
    workbookInfo(url) {
      return invoke(['sheets', '+workbook-info', '--url', url]);
    },
    cellsGet(url, sheetId, range, include = 'value') {
      return invoke([
        'sheets', '+cells-get', '--url', url, '--sheet-id', sheetId,
        '--range', range, '--include', include,
      ]);
    },
    sheetCopy(url, sheetId, title) {
      return invoke([
        'sheets', '+sheet-copy', '--url', url, '--sheet-id', sheetId,
        '--title', title, '--index', '0',
      ]);
    },
    sheetMove(url, sheetId, index) {
      return invoke([
        'sheets', '+sheet-move', '--url', url, '--sheet-id', sheetId,
        '--index', String(index),
      ]);
    },
    batchUpdate(url, operations, { dryRun = false } = {}) {
      const args = ['sheets', '+batch-update', '--url', url, '--operations', '-', '--yes'];
      if (dryRun) args.push('--dry-run');
      return invoke(args, { input: `${JSON.stringify(operations)}\n` });
    },
  };
}

function getSheets(workbookData) {
  const sheets = workbookData.sheets || workbookData.workbook?.sheets || [];
  return sheets.map((sheet, index) => ({
    ...sheet,
    sheet_id: sheet.sheet_id || sheet.sheetId || sheet.reference_id || sheet.referenceId,
    title: sheet.title || sheet.sheet_name || sheet.name,
    index: Number.isInteger(sheet.index) ? sheet.index : index,
  }));
}

function sheetDimensions(sheet) {
  const grid = sheet.grid_properties || sheet.gridProperties || {};
  const rowCount = Number(
    grid.row_count || grid.rowCount || sheet.row_count || sheet.rowCount || 500,
  );
  const columnCount = Number(
    grid.column_count || grid.columnCount || sheet.column_count || sheet.columnCount || 100,
  );
  return {
    rowCount: Math.max(3, Math.min(rowCount, 50000)),
    columnCount: Math.max(2, Math.min(columnCount, 2000)),
  };
}

function indexToColumn(index) {
  if (!Number.isInteger(index) || index < 0) throw new WorklogError('INVALID_COLUMN', `Invalid column index: ${index}`);
  let number = index + 1;
  let result = '';
  while (number > 0) {
    number -= 1;
    result = String.fromCharCode(65 + (number % 26)) + result;
    number = Math.floor(number / 26);
  }
  return result;
}

function columnToIndex(column) {
  if (!/^[A-Z]+$/i.test(column)) throw new WorklogError('INVALID_COLUMN', `Invalid column: ${column}`);
  let value = 0;
  for (const character of column.toUpperCase()) value = value * 26 + character.charCodeAt(0) - 64;
  return value - 1;
}

function shiftColumn(column, amount) {
  return indexToColumn(columnToIndex(column) + amount);
}

function firstRange(cellsData) {
  const range = cellsData.ranges?.[0];
  if (!range) throw new WorklogError('LARK_RESPONSE_INVALID', 'lark-cli returned no cell range.');
  return range;
}

function cellValue(cell) {
  const value = cell?.value;
  return value === null || value === undefined ? '' : String(value);
}

function hasCellValue(cell) {
  return cellValue(cell).trim().length > 0;
}

function rowFromRange(cellsData) {
  const range = firstRange(cellsData);
  const cells = range.cells?.[0] || [];
  const columns = range.col_indices || cells.map((_, index) => indexToColumn(index));
  return columns.map((column, index) => ({ column, cell: cells[index] || {} }));
}

function columnFromRange(cellsData) {
  const range = firstRange(cellsData);
  const rows = range.row_indices || (range.cells || []).map((_, index) => index + 1);
  return rows.map((row, index) => ({ row, cell: range.cells?.[index]?.[0] || {} }));
}

function parseDateHeader(value) {
  const match = String(value || '').trim().match(DATE_HEADER_RE);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) return null;
  return {
    key: `${match[1]}-${match[2]}-${match[3]}`,
    month: `${match[1]}${match[2]}`,
    year,
    monthNumber: month,
    day,
    weekday: match[4] || '',
  };
}

function dateIdentity(date, timezone) {
  validateTimezone(timezone);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
  const key = `${parts.year}-${parts.month}-${parts.day}`;
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' }).format(date);
  return {
    key,
    month: `${parts.year}${parts.month}`,
    header: `${parts.year}/${parts.month}/${parts.day} ${weekday}`,
    year: Number(parts.year),
    monthNumber: Number(parts.month),
    day: Number(parts.day),
  };
}

function previousMonth(monthKey) {
  if (!/^\d{6}$/.test(monthKey)) throw new WorklogError('INVALID_MONTH', `Invalid month: ${monthKey}`);
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(4, 6));
  const date = new Date(Date.UTC(year, month - 2, 1));
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function currentDate({ env = process.env, timezone, now } = {}) {
  const effectiveNow = now || (env.LARK_WORKLOG_NOW ? new Date(env.LARK_WORKLOG_NOW) : new Date());
  if (Number.isNaN(effectiveNow.getTime())) throw new WorklogError('INVALID_NOW', 'LARK_WORKLOG_NOW is not a valid date.');
  return dateIdentity(effectiveNow, timezone);
}

function parseAliases(value) {
  return String(value || '')
    .split(/[、,，/]/)
    .map((alias) => alias.trim())
    .filter(Boolean)
    .filter((alias, index, values) => values.findIndex((item) => item.toLocaleLowerCase() === alias.toLocaleLowerCase()) === index);
}

function parseTaskCell(cell, row) {
  const value = cellValue(cell);
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const aliases = [];
  let status = 'active';
  const titleLines = [];
  for (const line of lines) {
    const alias = line.match(ALIAS_RE);
    if (alias) {
      aliases.push(...parseAliases(alias[1]));
      continue;
    }
    const state = line.match(STATUS_RE);
    if (state) {
      if (state[1].trim() === COMPLETE_STATUS) status = 'completed';
      continue;
    }
    titleLines.push(line);
  }
  const richText = Array.isArray(cell?.rich_text) ? cell.rich_text : [];
  const documents = richText
    .filter((item) => item?.type === 'mention' && Number(item.mention_type) === 22 && item.mention_token)
    .map((item) => ({ token: item.mention_token, title: item.text || '' }));
  const links = richText
    .filter((item) => item?.type === 'link' && item.link)
    .map((item) => ({ url: item.link, title: item.text || item.link }));
  return {
    row,
    title: titleLines[0] || documents[0]?.title || '',
    aliases: parseAliases(aliases.join('、')),
    status,
    documents,
    links,
    legacy_background: cell?.cell_styles?.background_color || null,
    value,
  };
}

function stripTaskMetadataFromText(text) {
  return String(text || '')
    .split(/(\r?\n)/)
    .reduce((result, part) => {
      if (/^\r?\n$/.test(part)) {
        if (result.length && !/\n$/.test(result[result.length - 1])) result.push(part);
        return result;
      }
      if (ALIAS_RE.test(part.trim()) || STATUS_RE.test(part.trim())) return result;
      result.push(part);
      return result;
    }, [])
    .join('')
    .replace(/\n{2,}/g, '\n')
    .replace(/\n$/, '');
}

function upsertTaskMetadata(cell, { aliases = [], status = 'active' } = {}) {
  const richText = Array.isArray(cell?.rich_text) && cell.rich_text.length
    ? cell.rich_text.map((item) => ({ ...item }))
    : [{ type: 'text', text: cellValue(cell) }];
  const preserved = [];
  let pendingNewline = false;
  for (const item of richText) {
    if (item.type === 'text') {
      const text = stripTaskMetadataFromText(item.text);
      if (text) {
        preserved.push({ ...item, text });
        pendingNewline = false;
      } else if (/\r?\n/.test(item.text || '')) {
        pendingNewline = true;
      }
    } else {
      if (pendingNewline && preserved.length) preserved.push({ type: 'text', text: '\n' });
      preserved.push(item);
      pendingNewline = false;
    }
  }
  const metadata = [];
  const normalizedAliases = parseAliases(aliases.join('、'));
  if (normalizedAliases.length) metadata.push(`别名：${normalizedAliases.join('、')}`);
  if (status === 'completed') metadata.push(`状态：${COMPLETE_STATUS}`);
  if (metadata.length) {
    const currentText = preserved.map((item) => item.text || '').join('');
    preserved.push({ type: 'text', text: `${currentText.endsWith('\n') || !currentText ? '' : '\n'}${metadata.join('\n')}` });
  }
  return preserved;
}

function carryDailyText(value) {
  const lines = String(value || '').split(/\r?\n/);
  return lines
    .filter((line) => !/^\s*\[x\]\s*/i.test(line))
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
    .replace(/\n{3,}/g, '\n\n');
}

function escapeXmlText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function taskDocumentXml({ title, background = '', goal = '', links = [] }) {
  if (!String(title || '').trim()) throw new WorklogError('TASK_TITLE_REQUIRED', 'A task title is required.');
  const linkParagraphs = links.map((link) => {
    const url = canonicalizeHttpUrl(link.url || link);
    const label = escapeXmlText(link.title || link.url || link);
    return `<p><a href="${escapeXmlText(url)}">${label}</a></p>`;
  }).join('');
  return [
    `<title>${escapeXmlText(title)}</title>`,
    '<h1>背景</h1>',
    background ? `<p>${escapeXmlText(background)}</p>` : '',
    '<h1>目标</h1>',
    goal ? `<p>${escapeXmlText(goal)}</p>` : '',
    '<h1>相关资料</h1>',
    linkParagraphs,
    '<h1>决策记录</h1>',
  ].join('');
}

function canonicalizeHttpUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new WorklogError('INVALID_RELATED_URL', `Invalid related URL: ${rawUrl}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new WorklogError('INVALID_RELATED_URL', 'Related URLs must use http or https.');
  }
  parsed.username = '';
  parsed.password = '';
  return parsed.toString();
}

function taskDocumentRichText({ title, url, token }) {
  const normalizedTitle = String(title || '').trim();
  const normalizedToken = String(token || '').trim();
  if (!normalizedTitle) throw new WorklogError('TASK_TITLE_REQUIRED', 'A task title is required.');
  if (!normalizedToken) {
    throw new WorklogError('DOCUMENT_TOKEN_REQUIRED', 'A document token is required for the task mention.');
  }
  const normalizedUrl = canonicalizeHttpUrl(url);
  return [
    {
      type: 'mention',
      mention_type: 22,
      mention_token: normalizedToken,
      text: normalizedTitle,
      link: normalizedUrl,
    },
    { type: 'text', text: ' ' },
  ];
}

function createTaskTransaction({ task, documents, sheet }) {
  if (!documents || typeof documents.create !== 'function') {
    throw new WorklogError('INVALID_CLIENT', 'A document client is required.');
  }
  if (!sheet || typeof sheet.insert !== 'function') {
    throw new WorklogError('INVALID_CLIENT', 'A sheet writer is required.');
  }
  const content = taskDocumentXml(task);
  const document = documents.create({
    title: task.title,
    content,
    parent_position: 'my_library',
  });
  if (!document?.url || !(document.document_id || document.token)) {
    throw new WorklogError('DOCUMENT_CREATE_INVALID', 'Document creation returned no URL or document token.');
  }
  const token = document.document_id || document.token;
  const inserted = sheet.insert({
    title: task.title,
    aliases: parseAliases((task.aliases || []).join('、')),
    daily_entry: task.daily_entry || '',
    document: {
      url: document.url,
      token,
      rich_text: taskDocumentRichText({ title: task.title, url: document.url, token }),
    },
  });
  return { document, inserted };
}

function contiguousRowRangesDescending(rows) {
  const sorted = [...new Set(rows)].sort((left, right) => left - right);
  const groups = [];
  for (const row of sorted) {
    const current = groups[groups.length - 1];
    if (current && current.end + 1 === row) current.end = row;
    else groups.push({ start: row, end: row });
  }
  return groups.reverse().map(({ start, end }) => (start === end ? String(start) : `${start}:${end}`));
}

function lastNonemptyRow(cellsData, minimum = 2) {
  let last = minimum;
  for (const { row, cell } of columnFromRange(cellsData)) {
    if (hasCellValue(cell)) last = Math.max(last, row);
  }
  return last;
}

function readHeaders(cli, url, sheet) {
  const { columnCount } = sheetDimensions(sheet);
  const lastColumn = indexToColumn(columnCount - 1);
  return rowFromRange(cli.cellsGet(url, sheet.sheet_id, `A1:${lastColumn}1`, 'value'))
    .map(({ column, cell }) => ({ column, value: cellValue(cell), date: parseDateHeader(cellValue(cell)) }))
    .filter((entry) => entry.date);
}

function readTasks(cli, url, sheet) {
  const { rowCount } = sheetDimensions(sheet);
  const data = cli.cellsGet(url, sheet.sheet_id, `A1:A${rowCount}`, 'value,style');
  const rows = columnFromRange(data);
  const tasks = rows
    .filter(({ row, cell }) => row >= 3 && hasCellValue(cell))
    .map(({ row, cell }) => parseTaskCell(cell, row));
  return { data, rows, tasks, lastRow: lastNonemptyRow(data) };
}

function readDailyColumn(cli, url, sheet, column, lastRow) {
  const data = cli.cellsGet(url, sheet.sheet_id, `${column}1:${column}${lastRow}`, 'value,style');
  return { data, rows: columnFromRange(data) };
}

function latestPopulatedDateColumn(cli, url, sheet, headers, todayKey, lastRow) {
  const candidates = headers
    .filter((entry) => entry.date.key < todayKey)
    .sort((left, right) => right.date.key.localeCompare(left.date.key));
  let fallback = null;
  for (const candidate of candidates) {
    const daily = readDailyColumn(cli, url, sheet, candidate.column, lastRow);
    if (!fallback) fallback = { ...candidate, daily };
    if (daily.rows.some(({ row, cell }) => row >= 2 && hasCellValue(cell))) {
      return { ...candidate, daily, populated: true };
    }
  }
  return fallback ? { ...fallback, populated: false } : null;
}

function validateWorklogStructure(cli, url, workbookData, date) {
  const sheets = getSheets(workbookData);
  const monthly = sheets.filter((sheet) => MONTH_SHEET_RE.test(sheet.title || ''));
  if (!monthly.length) {
    throw new WorklogError('WORKLOG_STRUCTURE_INVALID', 'The workbook has no YYYYMM monthly worksheet.');
  }
  const sample = monthly.find((sheet) => sheet.title === date.month) ||
    monthly.sort((left, right) => right.title.localeCompare(left.title))[0];
  const values = cli.cellsGet(url, sample.sheet_id, 'A1:B3', 'value');
  const range = firstRange(values);
  const miscellaneous = cellValue(range.cells?.[1]?.[0]).trim();
  if (miscellaneous !== '杂项') {
    throw new WorklogError('WORKLOG_STRUCTURE_INVALID', 'Cell A2 must contain “杂项”.');
  }
  return { sheets, sample };
}

function configureWorklog({ url, timezone = DEFAULT_TIMEZONE, cli = createLarkClient(), file = configPath(), now } = {}) {
  const canonicalUrl = canonicalizeSpreadsheetUrl(url);
  validateTimezone(timezone);
  const date = currentDate({ timezone, now });
  const workbook = cli.workbookInfo(canonicalUrl);
  const structure = validateWorklogStructure(cli, canonicalUrl, workbook, date);
  writePrivateJson(file, {
    version: CONFIG_VERSION,
    default_spreadsheet_url: canonicalUrl,
    timezone,
  });
  return {
    configured: true,
    timezone,
    monthly_sheet_count: structure.sheets.filter((sheet) => MONTH_SHEET_RE.test(sheet.title || '')).length,
  };
}

function inspectWorklog({ config, cli = createLarkClient(), now } = {}) {
  const url = config.default_spreadsheet_url;
  const date = currentDate({ timezone: config.timezone, now });
  const workbook = cli.workbookInfo(url);
  const sheets = getSheets(workbook);
  const sheet = sheets.find((entry) => entry.title === date.month);
  if (!sheet) {
    return {
      timezone: config.timezone,
      today: date.key,
      current_month: date.month,
      current_sheet: null,
      previous_month_sheet: sheets.find((entry) => entry.title === previousMonth(date.month)) || null,
      needs_prepare: true,
      tasks: [],
    };
  }
  const headers = readHeaders(cli, url, sheet);
  const todayColumns = headers.filter((entry) => entry.date.key === date.key);
  const taskData = readTasks(cli, url, sheet);
  const latest = latestPopulatedDateColumn(cli, url, sheet, headers, date.key, taskData.lastRow);
  const todayEntries = [];
  if (todayColumns.length === 1) {
    const daily = readDailyColumn(cli, url, sheet, todayColumns[0].column, taskData.lastRow);
    for (const { row, cell } of daily.rows) {
      if (row >= 2 && hasCellValue(cell)) todayEntries.push({ row, value: cellValue(cell) });
    }
  }
  return {
    timezone: config.timezone,
    today: date.key,
    current_month: date.month,
    current_sheet: { sheet_id: sheet.sheet_id, title: sheet.title, index: sheet.index },
    today_column: todayColumns.length === 1 ? todayColumns[0].column : null,
    duplicate_today_columns: todayColumns.length > 1 ? todayColumns.map((entry) => entry.column) : [],
    latest_populated_column: latest ? { column: latest.column, date: latest.date.key, populated: latest.populated } : null,
    needs_prepare: todayColumns.length === 0,
    tasks: taskData.tasks,
    today_entries: todayEntries,
    legacy_color_candidates: taskData.tasks
      .filter((task) => task.legacy_background && task.status !== 'completed')
      .map((task) => ({ row: task.row, title: task.title, background: task.legacy_background })),
  };
}

function assertDailyWrite(cli, url, sheet, expectedValues) {
  const actual = readDailyColumn(cli, url, sheet, 'B', expectedValues.length);
  if (actual.rows.length < expectedValues.length) {
    throw new WorklogError('WRITE_VERIFICATION_FAILED', 'The new daily column is shorter than expected.');
  }
  for (let index = 0; index < expectedValues.length; index += 1) {
    if (cellValue(actual.rows[index]?.cell) !== expectedValues[index]) {
      throw new WorklogError('WRITE_VERIFICATION_FAILED', `Daily column verification failed at B${index + 1}.`);
    }
  }
}

function deleteCompletedRows(cli, url, sheet, taskData, actions, dryRun) {
  const completedRows = taskData.tasks.filter((task) => task.status === 'completed').map((task) => task.row);
  const ranges = contiguousRowRangesDescending(completedRows);
  if (!ranges.length) return { completedRows, taskData };
  actions.push({ type: 'delete_completed_task_rows', rows: completedRows, ranges });
  if (dryRun) return { completedRows, taskData };
  const operations = ranges.map((range) => ({
    shortcut: '+dim-delete',
    input: { sheet_id: sheet.sheet_id, range },
  }));
  cli.batchUpdate(url, operations);
  const after = readTasks(cli, url, sheet);
  if (after.tasks.some((task) => task.status === 'completed')) {
    throw new WorklogError('WRITE_VERIFICATION_FAILED', 'Completed task rows remain after monthly cleanup.');
  }
  return { completedRows, taskData: after };
}

function prepareWorklog({ config, cli = createLarkClient(), dryRun = false, now } = {}) {
  const url = config.default_spreadsheet_url;
  const date = currentDate({ timezone: config.timezone, now });
  const actions = [];
  let workbook = cli.workbookInfo(url);
  let sheets = getSheets(workbook);
  let sheet = sheets.find((entry) => entry.title === date.month);
  let created = false;
  let virtualDeletedRows = [];

  if (!sheet) {
    const expectedPrevious = previousMonth(date.month);
    const source = sheets.find((entry) => entry.title === expectedPrevious);
    if (!source) {
      throw new WorklogError(
        'PREVIOUS_MONTH_MISSING',
        `Cannot create ${date.month}: worksheet ${expectedPrevious} does not exist. Ask the user how to proceed.`,
      );
    }
    actions.push({ type: 'copy_month_sheet', from: expectedPrevious, to: date.month, index: 0 });
    created = true;
    if (dryRun) {
      sheet = { ...source, title: date.month, index: 0, dry_run_source_sheet_id: source.sheet_id };
    } else {
      cli.sheetCopy(url, source.sheet_id, date.month);
      workbook = cli.workbookInfo(url);
      sheets = getSheets(workbook);
      sheet = sheets.find((entry) => entry.title === date.month);
      if (!sheet) {
        throw new WorklogError('WRITE_VERIFICATION_FAILED', `Worksheet ${date.month} was not created.`);
      }
      if (sheet.index !== 0) {
        cli.sheetMove(url, sheet.sheet_id, 0);
        workbook = cli.workbookInfo(url);
        sheets = getSheets(workbook);
        sheet = sheets.find((entry) => entry.title === date.month);
      }
      if (!sheet || sheet.index !== 0) {
        throw new WorklogError('WRITE_VERIFICATION_FAILED', `Worksheet ${date.month} was not moved to index 0.`);
      }
    }
  }

  let headers = readHeaders(cli, url, sheet);
  const duplicateToday = headers.filter((entry) => entry.date.key === date.key);
  if (duplicateToday.length > 1) {
    throw new WorklogError('DUPLICATE_TODAY_COLUMNS', `Multiple columns represent ${date.key}. Ask the user to resolve them.`, {
      columns: duplicateToday.map((entry) => entry.column),
    });
  }

  let taskData = readTasks(cli, url, sheet);
  const hasCurrentMonthDate = headers.some((entry) => entry.date.month === date.month);
  if (created || !hasCurrentMonthDate) {
    const cleanup = deleteCompletedRows(cli, url, sheet, taskData, actions, dryRun);
    virtualDeletedRows = cleanup.completedRows;
    taskData = cleanup.taskData;
  }

  if (!dryRun && actions.some((action) => action.type === 'delete_completed_task_rows')) {
    headers = readHeaders(cli, url, sheet);
  }
  const todayColumns = headers.filter((entry) => entry.date.key === date.key);
  if (todayColumns.length === 1) {
    return {
      dry_run: dryRun,
      changed: actions.length > 0,
      timezone: config.timezone,
      today: date.key,
      current_month: date.month,
      sheet_id: dryRun && created ? null : sheet.sheet_id,
      today_column: todayColumns[0].column,
      actions,
    };
  }

  const source = latestPopulatedDateColumn(cli, url, sheet, headers, date.key, taskData.lastRow);
  const sourceRows = source?.daily?.rows || [];
  const sourceByRow = new Map();
  for (const { row, cell } of sourceRows) {
    if (dryRun && virtualDeletedRows.includes(row)) continue;
    const effectiveRow = dryRun
      ? row - virtualDeletedRows.filter((deletedRow) => deletedRow < row).length
      : row;
    sourceByRow.set(effectiveRow, cellValue(cell));
  }
  const effectiveLastRow = dryRun ? taskData.lastRow - virtualDeletedRows.length : taskData.lastRow;
  const expectedValues = [date.header];
  for (let row = 2; row <= effectiveLastRow; row += 1) {
    expectedValues.push(carryDailyText(sourceByRow.get(row) || ''));
  }
  actions.push({
    type: 'insert_today_column',
    column: 'B',
    date: date.key,
    source_column: source?.column || null,
    source_date: source?.date?.key || null,
    carried_rows: expectedValues.slice(1).filter(Boolean).length,
  });

  if (!dryRun) {
    const operations = [{
      shortcut: '+dim-insert',
      input: { sheet_id: sheet.sheet_id, position: 'A', count: 1, inherit_style: 'after' },
    }];
    if (source?.column) {
      const shiftedSource = shiftColumn(source.column, 1);
      operations.push({
        shortcut: '+range-copy',
        input: {
          sheet_id: sheet.sheet_id,
          source_range: `${shiftedSource}1:${shiftedSource}${effectiveLastRow}`,
          target_range: 'B1',
          paste_type: 'all',
        },
      });
    }
    operations.push({
      shortcut: '+cells-set',
      input: {
        sheet_id: sheet.sheet_id,
        range: `B1:B${effectiveLastRow}`,
        cells: expectedValues.map((value) => [{ value }]),
      },
    });
    cli.batchUpdate(url, operations);
    assertDailyWrite(cli, url, sheet, expectedValues);
  }

  return {
    dry_run: dryRun,
    changed: true,
    timezone: config.timezone,
    today: date.key,
    current_month: date.month,
    sheet_id: dryRun && created ? null : sheet.sheet_id,
    today_column: 'B',
    actions,
  };
}

function resolveConfigForCommand(options, { cli, file, now } = {}) {
  if (options.url) {
    const existing = fs.existsSync(file) ? loadConfig({ file }) : null;
    configureWorklog({
      url: options.url,
      timezone: options.timezone || existing?.timezone || DEFAULT_TIMEZONE,
      cli,
      file,
      now,
    });
  }
  return loadConfig({ file });
}

function outputJson(value) {
  process.stdout.write(`${JSON.stringify({ ok: true, data: value }, null, 2)}\n`);
}

function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArguments(argv);
  if (!command || command === 'help' || options.help) {
    printHelp();
    return;
  }
  const cli = createLarkClient();
  const file = configPath();
  if (command === 'configure') {
    if (!options.url) throw new WorklogError('INVALID_ARGUMENT', 'configure requires --url.');
    outputJson(configureWorklog({
      url: options.url,
      timezone: options.timezone || DEFAULT_TIMEZONE,
      cli,
      file,
    }));
    return;
  }
  if (command === 'inspect') {
    const config = resolveConfigForCommand(options, { cli, file });
    outputJson(inspectWorklog({ config, cli }));
    return;
  }
  if (command === 'prepare') {
    const config = resolveConfigForCommand(options, { cli, file });
    outputJson(prepareWorklog({ config, cli, dryRun: Boolean(options['dry-run']) }));
    return;
  }
  throw new WorklogError('UNKNOWN_COMMAND', `Unknown command: ${command}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const normalized = error instanceof WorklogError
      ? error
      : new WorklogError('UNEXPECTED_ERROR', redactSensitiveText(error?.message || error));
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.details ? { details: normalized.details } : {}),
      },
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  ALIAS_RE,
  COMPLETE_STATUS,
  CONFIG_VERSION,
  DEFAULT_TIMEZONE,
  STATUS_RE,
  WorklogError,
  canonicalizeSpreadsheetUrl,
  canonicalizeHttpUrl,
  carryDailyText,
  columnToIndex,
  configDirectory,
  configPath,
  configureWorklog,
  contiguousRowRangesDescending,
  createLarkClient,
  createTaskTransaction,
  currentDate,
  dateIdentity,
  getSheets,
  indexToColumn,
  inspectWorklog,
  loadConfig,
  parseAliases,
  parseDateHeader,
  parseTaskCell,
  prepareWorklog,
  previousMonth,
  redactSensitiveText,
  resolveConfigForCommand,
  sheetDimensions,
  shiftColumn,
  stripTaskMetadataFromText,
  taskDocumentRichText,
  taskDocumentXml,
  upsertTaskMetadata,
  validateWorklogStructure,
  writePrivateJson,
};
