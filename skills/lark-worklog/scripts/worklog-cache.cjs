#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  assertCompleteCellsGet,
  dateIdentity,
  parseArguments,
} = require('./worklog-rules.cjs');

const CACHE_VERSION = 1;
const DEFAULT_LOCK_MAX_AGE_MS = 30 * 60 * 1000;
const ENTRY_PATTERN = /^[a-f0-9]{64}\.json$/;

class WorklogCacheError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorklogCacheError';
    this.code = code;
  }
}

function printHelp() {
  process.stdout.write(
    'Usage:\n' +
    '  worklog-cache.cjs get [--date YYYY-MM-DD] [--identity-key <key>]\n' +
    '  worklog-cache.cjs replace --identity-key <key> --workbook-token <token>\n' +
    '    --workbook-title <title> --sheet-id <id> --date YYYY-MM-DD < cells-get.json\n' +
    '  worklog-cache.cjs begin-write --identity-key <key> [--owner <lease-id>]\n' +
    '  worklog-cache.cjs finish-write --identity-key <key> --owner <lease-id>\n' +
    '    --workbook-token <token> --workbook-title <title> --sheet-id <id>\n' +
    '    --date YYYY-MM-DD < cells-get.json\n' +
    '  worklog-cache.cjs abort-write --identity-key <key> --owner <lease-id>\n' +
    '  worklog-cache.cjs invalidate --identity-key <key> [--reason <text>]\n' +
    '  worklog-cache.cjs path\n\n' +
    'All commands accept --cache-dir for testing or an explicit runtime override.\n' +
    'The cache is a read-only mirror. Only replace and finish-write accept a complete\n' +
    'live A:B cells-get response; there is no command that patches cached task data.\n',
  );
}

function outputJson(data) {
  process.stdout.write(`${JSON.stringify({ ok: true, data }, null, 2)}\n`);
}

function readJsonStdin() {
  const input = fs.readFileSync(0, 'utf8').trim();
  if (!input) throw new WorklogCacheError('MISSING_INPUT', 'Expected cells-get JSON on stdin.');
  try {
    return JSON.parse(input);
  } catch (error) {
    throw new WorklogCacheError('INVALID_JSON', `Invalid JSON on stdin: ${error.message}`);
  }
}

function defaultCacheRoot() {
  if (process.env.LARK_WORKLOG_CACHE_DIR) {
    return path.resolve(process.env.LARK_WORKLOG_CACHE_DIR);
  }
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'lark-worklog', 'cache');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'lark-worklog');
  }
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'lark-worklog');
}

function resolveCacheRoot(cacheDir) {
  return cacheDir ? path.resolve(String(cacheDir)) : defaultCacheRoot();
}

function ensureSecureDirectory(directory) {
  let created = false;
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    created = true;
    stat = fs.lstatSync(directory);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new WorklogCacheError('UNSAFE_CACHE_DIRECTORY', 'Cache path must be a real directory, not a link or file.');
  }
  if (process.platform !== 'win32') {
    if (created) fs.chmodSync(directory, 0o700);
    if ((fs.statSync(directory).mode & 0o077) !== 0) {
      throw new WorklogCacheError(
        'INSECURE_CACHE_DIRECTORY',
        'Existing cache directory must not be accessible by group or other users.',
      );
    }
  }
}

function identityHash(identityKey) {
  const normalized = String(identityKey || '').trim();
  if (!normalized) throw new WorklogCacheError('MISSING_IDENTITY', 'A stable user identity key is required.');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function entryPath(root, hash) {
  return path.join(root, `${hash}.json`);
}

function lockPath(root, hash) {
  return path.join(root, `${hash}.lock`);
}

function atomicWriteJson(file, value) {
  ensureSecureDirectory(path.dirname(file));
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function readJsonFile(file) {
  let text;
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new WorklogCacheError('UNSAFE_CACHE_FILE', `Cache path is not a regular file: ${file}`);
    }
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new WorklogCacheError('CORRUPT_CACHE', `Cannot parse ${file}: ${error.message}`);
  }
}

function dateIdentityForKey(key) {
  const match = String(key || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new WorklogCacheError('INVALID_DATE', 'Date must use YYYY-MM-DD format.');
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0);
  const identity = dateIdentity(date);
  if (identity.key !== key) throw new WorklogCacheError('INVALID_DATE', `Invalid calendar date: ${key}`);
  return identity;
}

function scalarCellValue(cell) {
  if (!cell || cell.value === undefined || cell.value === null) return '';
  if (typeof cell.value === 'object') {
    if (cell.value.value !== undefined && cell.value.value !== null) return String(cell.value.value);
    if (cell.value.text !== undefined && cell.value.text !== null) return String(cell.value.text);
    return '';
  }
  return String(cell.value);
}

function parseMetadataLines(value) {
  const lines = String(value || '').split(/\r?\n/);
  const visibleLines = lines.map((line) => line.trim()).filter(Boolean);
  const title = visibleLines.find((line) => !line.startsWith('别名：') && !line.startsWith('状态：')) || '';
  const aliases = visibleLines
    .filter((line) => line.startsWith('别名：'))
    .flatMap((line) => line.slice('别名：'.length).split('、'))
    .map((alias) => alias.trim())
    .filter(Boolean);
  const statusLines = visibleLines.filter((line) => line.startsWith('状态：'));
  const status = statusLines.length
    ? statusLines.at(-1).slice('状态：'.length).trim()
    : null;
  const notes = visibleLines.filter((line) => (
    line !== title && !line.startsWith('别名：') && !line.startsWith('状态：')
  ));
  return { title, aliases, status, notes };
}

function parseDailyItems(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^\[(|x|X|~)\]\s*(.*)$/);
      if (!match) return { type: 'context', text: line };
      const type = match[1] === ''
        ? 'open'
        : match[1] === '~' ? 'progress' : 'done';
      return { type, text: match[2] };
    });
}

function snapshotRows(cellsGet) {
  try {
    assertCompleteCellsGet(cellsGet);
  } catch (error) {
    throw new WorklogCacheError(error.code || 'INCOMPLETE_CELLS_GET', error.message);
  }
  const data = cellsGet?.data || cellsGet;
  const ranges = Array.isArray(data?.ranges) ? data.ranges : [];
  if (ranges.length !== 1) {
    throw new WorklogCacheError('INVALID_SNAPSHOT_RANGE', 'Expected one complete A:B cells-get range.');
  }
  const range = ranges[0];
  const columns = Array.isArray(range.col_indices) ? range.col_indices : [];
  const rows = Array.isArray(range.row_indices) ? range.row_indices.map(Number) : [];
  const columnA = columns.indexOf('A');
  const columnB = columns.indexOf('B');
  if (columnA < 0 || columnB < 0 || rows.length < 2 || rows[0] !== 1) {
    throw new WorklogCacheError(
      'INVALID_SNAPSHOT_RANGE',
      'The snapshot must contain columns A and B, starting at row 1 and including row 2.',
    );
  }
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index] !== rows[index - 1] + 1) {
      throw new WorklogCacheError('NONCONTIGUOUS_SNAPSHOT', 'Snapshot rows must be contiguous.');
    }
  }
  const values = rows.map((row, index) => {
    const rowCells = Array.isArray(range.cells?.[index]) ? range.cells[index] : [];
    return {
      row,
      task: scalarCellValue(rowCells[columnA]),
      daily: scalarCellValue(rowCells[columnB]),
    };
  });
  let lastIndex = values.length - 1;
  while (lastIndex > 1 && !values[lastIndex].task && !values[lastIndex].daily) lastIndex -= 1;
  return {
    header: values[0].daily,
    lastRow: values[lastIndex].row,
    rows: values.slice(1, lastIndex + 1)
      .filter((record) => record.task || record.daily)
      .map((record) => ({
        row: record.row,
        ...parseMetadataLines(record.task),
        daily_text: record.daily,
        daily_items: parseDailyItems(record.daily),
      })),
  };
}

function requiredOption(options, name) {
  const value = String(options[name] || '').trim();
  if (!value) throw new WorklogCacheError('MISSING_OPTION', `--${name} is required.`);
  return value;
}

function buildSnapshot(cellsGet, metadata, now = new Date()) {
  const identity = dateIdentityForKey(metadata.date);
  const workbookTitle = String(metadata.workbookTitle || '').trim();
  if (!workbookTitle.includes('[worklog]')) {
    throw new WorklogCacheError('INVALID_WORKBOOK_TITLE', 'Workbook title must contain the literal [worklog] marker.');
  }
  const extracted = snapshotRows(cellsGet);
  if (extracted.header !== identity.header) {
    throw new WorklogCacheError(
      'DATE_HEADER_MISMATCH',
      `B1 must be ${identity.header}; received ${extracted.header || '<empty>'}.`,
    );
  }
  const data = cellsGet?.data || cellsGet;
  const revision = metadata.revision ?? data?.revision;
  if (revision === undefined || revision === null || revision === '') {
    throw new WorklogCacheError('MISSING_REVISION', 'The live cells-get response must include a revision.');
  }
  return {
    version: CACHE_VERSION,
    state: 'clean',
    identity_hash: identityHash(metadata.identityKey),
    target: {
      workbook_title: workbookTitle,
      workbook_token: String(metadata.workbookToken || '').trim(),
      sheet_id: String(metadata.sheetId || '').trim(),
      month: identity.month,
    },
    prepared_date: identity.key,
    header: identity.header,
    revision,
    fetched_at: now.toISOString(),
    complete: true,
    actual_range: `A1:B${extracted.lastRow}`,
    rows: extracted.rows,
  };
}

function validateTarget(snapshot) {
  if (!snapshot?.target?.workbook_token || !snapshot?.target?.sheet_id) {
    throw new WorklogCacheError('INVALID_TARGET', 'Workbook token and sheet ID are required.');
  }
}

function listEntryFiles(root) {
  try {
    return fs.readdirSync(root).filter((entry) => ENTRY_PATTERN.test(entry));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function reusableTarget(snapshot) {
  const target = snapshot?.target;
  return target?.workbook_token && target?.sheet_id ? target : undefined;
}

function cacheReadResult({ root, date, identityKey }) {
  const expectedDate = dateIdentityForKey(date || dateIdentity(new Date()).key).key;
  let hash;
  let file;
  if (identityKey) {
    hash = identityHash(identityKey);
    file = entryPath(root, hash);
  } else {
    const entries = listEntryFiles(root);
    if (!entries.length) return { status: 'miss', reason: 'cache_missing' };
    if (entries.length > 1) return { status: 'miss', reason: 'identity_ambiguous', entry_count: entries.length };
    file = path.join(root, entries[0]);
    hash = entries[0].slice(0, -'.json'.length);
  }
  if (fs.existsSync(lockPath(root, hash))) {
    return { status: 'miss', reason: 'write_in_progress' };
  }
  let snapshot;
  try {
    snapshot = readJsonFile(file);
  } catch (error) {
    if (error.code === 'CORRUPT_CACHE') return { status: 'miss', reason: 'cache_corrupt' };
    throw error;
  }
  if (!snapshot) return { status: 'miss', reason: 'cache_missing' };
  if (snapshot.version !== CACHE_VERSION) return { status: 'miss', reason: 'cache_version_mismatch' };
  if (snapshot.state !== 'clean' || snapshot.complete !== true) {
    return {
      status: 'miss',
      reason: snapshot.dirty_reason || 'cache_dirty',
      ...(reusableTarget(snapshot) ? { target: reusableTarget(snapshot) } : {}),
    };
  }
  if (snapshot.prepared_date !== expectedDate) {
    return {
      status: 'miss',
      reason: 'date_mismatch',
      prepared_date: snapshot.prepared_date,
      expected_date: expectedDate,
      target: snapshot.target,
    };
  }
  validateTarget(snapshot);
  return { status: 'hit', snapshot };
}

function leaseRecord(root, hash) {
  return readJsonFile(path.join(lockPath(root, hash), 'owner.json'));
}

function assertOwner(owner) {
  const value = String(owner || '').trim();
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(value)) {
    throw new WorklogCacheError('INVALID_OWNER', 'Lease owner must contain 8-128 safe identifier characters.');
  }
  return value;
}

function releaseLease(root, hash) {
  const directory = lockPath(root, hash);
  const ownerFile = path.join(directory, 'owner.json');
  if (fs.existsSync(ownerFile)) fs.unlinkSync(ownerFile);
  if (fs.existsSync(directory)) fs.rmdirSync(directory);
}

function verifyLease(root, hash, owner) {
  const lease = leaseRecord(root, hash);
  if (!lease || lease.owner !== assertOwner(owner)) {
    throw new WorklogCacheError('LEASE_OWNER_MISMATCH', 'The active write lease belongs to another process.');
  }
  return lease;
}

function acquireLease({ root, identityKey, owner, now = new Date() }) {
  ensureSecureDirectory(root);
  const hash = identityHash(identityKey);
  const directory = lockPath(root, hash);
  const normalizedOwner = owner ? assertOwner(owner) : crypto.randomUUID();
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new WorklogCacheError('CACHE_LOCKED', 'Another work-log write is already in progress.');
    }
    throw error;
  }
  try {
    atomicWriteJson(path.join(directory, 'owner.json'), {
      owner: normalizedOwner,
      pid: process.pid,
      acquired_at: now.toISOString(),
    });
    const file = entryPath(root, hash);
    const existing = readJsonFile(file);
    atomicWriteJson(file, {
      ...(existing || { version: CACHE_VERSION, identity_hash: hash }),
      state: 'dirty',
      complete: false,
      dirty_reason: 'write_in_progress',
      dirty_since: now.toISOString(),
    });
  } catch (error) {
    releaseLease(root, hash);
    throw error;
  }
  return { owner: normalizedOwner, acquired_at: now.toISOString() };
}

function markDirty({ root, identityKey, reason, now = new Date() }) {
  const hash = identityHash(identityKey);
  if (fs.existsSync(lockPath(root, hash))) {
    throw new WorklogCacheError('CACHE_LOCKED', 'Cannot invalidate while a work-log write is in progress.');
  }
  const file = entryPath(root, hash);
  const existing = readJsonFile(file);
  atomicWriteJson(file, {
    ...(existing || { version: CACHE_VERSION, identity_hash: hash }),
    state: 'dirty',
    complete: false,
    dirty_reason: String(reason || 'explicit_refresh_required'),
    dirty_since: now.toISOString(),
  });
  return { state: 'dirty', reason: String(reason || 'explicit_refresh_required') };
}

function lockAgeMs(root, hash, now = new Date()) {
  const lease = leaseRecord(root, hash);
  const acquired = Date.parse(lease?.acquired_at || '');
  return Number.isFinite(acquired) ? now.getTime() - acquired : Number.POSITIVE_INFINITY;
}

function replaceCache({
  root,
  identityKey,
  cellsGet,
  metadata,
  owner,
  recover = false,
  lockMaxAgeMs = DEFAULT_LOCK_MAX_AGE_MS,
  now = new Date(),
}) {
  const hash = identityHash(identityKey);
  const directory = lockPath(root, hash);
  const hasLease = fs.existsSync(directory);
  if (owner) {
    verifyLease(root, hash, owner);
  } else if (hasLease) {
    if (!recover || lockAgeMs(root, hash, now) < lockMaxAgeMs) {
      throw new WorklogCacheError('CACHE_LOCKED', 'A live write lease blocks cache replacement.');
    }
  }
  const snapshot = buildSnapshot(cellsGet, { ...metadata, identityKey }, now);
  validateTarget(snapshot);
  atomicWriteJson(entryPath(root, hash), snapshot);
  if (hasLease) releaseLease(root, hash);
  return {
    state: 'clean',
    prepared_date: snapshot.prepared_date,
    revision: snapshot.revision,
    row_count: snapshot.rows.length,
    actual_range: snapshot.actual_range,
  };
}

function abortWrite({ root, identityKey, owner, reason, now = new Date() }) {
  const hash = identityHash(identityKey);
  verifyLease(root, hash, owner);
  const file = entryPath(root, hash);
  const existing = readJsonFile(file);
  atomicWriteJson(file, {
    ...(existing || { version: CACHE_VERSION, identity_hash: hash }),
    state: 'dirty',
    complete: false,
    dirty_reason: String(reason || 'write_reconciliation_required'),
    dirty_since: now.toISOString(),
  });
  releaseLease(root, hash);
  return { state: 'dirty', reason: String(reason || 'write_reconciliation_required') };
}

function metadataFromOptions(options) {
  return {
    workbookToken: requiredOption(options, 'workbook-token'),
    workbookTitle: requiredOption(options, 'workbook-title'),
    sheetId: requiredOption(options, 'sheet-id'),
    date: requiredOption(options, 'date'),
    revision: options.revision,
  };
}

function main(argv = process.argv.slice(2)) {
  const { positionals, options } = parseArguments(argv);
  const [command] = positionals;
  if (!command || command === 'help' || options.help) {
    printHelp();
    return;
  }
  const root = resolveCacheRoot(options['cache-dir']);
  if (command === 'path') {
    outputJson({ cache_dir: root });
    return;
  }
  if (command === 'get') {
    outputJson(cacheReadResult({
      root,
      date: options.date,
      identityKey: options['identity-key'],
    }));
    return;
  }
  if (command === 'replace') {
    const identityKey = requiredOption(options, 'identity-key');
    outputJson(replaceCache({
      root,
      identityKey,
      cellsGet: readJsonStdin(),
      metadata: metadataFromOptions(options),
      recover: Boolean(options.recover),
    }));
    return;
  }
  if (command === 'begin-write') {
    outputJson(acquireLease({
      root,
      identityKey: requiredOption(options, 'identity-key'),
      owner: options.owner,
    }));
    return;
  }
  if (command === 'finish-write') {
    const identityKey = requiredOption(options, 'identity-key');
    outputJson(replaceCache({
      root,
      identityKey,
      owner: requiredOption(options, 'owner'),
      cellsGet: readJsonStdin(),
      metadata: metadataFromOptions(options),
    }));
    return;
  }
  if (command === 'abort-write') {
    outputJson(abortWrite({
      root,
      identityKey: requiredOption(options, 'identity-key'),
      owner: requiredOption(options, 'owner'),
      reason: options.reason,
    }));
    return;
  }
  if (command === 'invalidate') {
    outputJson(markDirty({
      root,
      identityKey: requiredOption(options, 'identity-key'),
      reason: options.reason,
    }));
    return;
  }
  throw new WorklogCacheError('UNKNOWN_COMMAND', 'Unknown command. Run with --help for usage.');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const normalized = error instanceof WorklogCacheError
      ? error
      : new WorklogCacheError(error.code || 'UNEXPECTED_ERROR', String(error?.message || error));
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: { code: normalized.code, message: normalized.message },
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  CACHE_VERSION,
  WorklogCacheError,
  abortWrite,
  acquireLease,
  buildSnapshot,
  cacheReadResult,
  defaultCacheRoot,
  identityHash,
  markDirty,
  parseDailyItems,
  parseMetadataLines,
  replaceCache,
  resolveCacheRoot,
  snapshotRows,
};
