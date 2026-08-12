const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const worklog = require('../skills/lark-worklog/scripts/worklog.cjs');

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lark-worklog-test-'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseCellReference(reference) {
  const match = String(reference).match(/^([A-Z]+)(\d+)$/i);
  if (!match) throw new Error(`invalid cell reference: ${reference}`);
  return { column: worklog.columnToIndex(match[1]), row: Number(match[2]) - 1 };
}

function parseRange(range) {
  const [startText, endText = startText] = range.split(':');
  return { start: parseCellReference(startText), end: parseCellReference(endText) };
}

function makeGrid(rows = 12, columns = 8) {
  return Array.from({ length: rows }, () => Array.from({ length: columns }, () => ({})));
}

function put(grid, reference, cell) {
  const { row, column } = parseCellReference(reference);
  grid[row][column] = clone(cell);
}

class FakeLarkClient {
  constructor(sheets) {
    this.sheets = sheets.map((sheet, index) => ({
      sheet_id: sheet.sheet_id,
      title: sheet.title,
      index,
      grid: clone(sheet.grid),
    }));
    this.calls = [];
    this.nextSheet = 1;
  }

  workbookInfo() {
    this.calls.push({ method: 'workbookInfo' });
    return {
      sheets: this.sheets.map((sheet, index) => ({
        sheet_id: sheet.sheet_id,
        title: sheet.title,
        index,
        grid_properties: {
          row_count: sheet.grid.length,
          column_count: sheet.grid[0].length,
        },
      })),
    };
  }

  findSheet(sheetId) {
    const sheet = this.sheets.find((entry) => entry.sheet_id === sheetId);
    if (!sheet) throw new Error(`sheet not found: ${sheetId}`);
    return sheet;
  }

  cellsGet(_url, sheetId, range) {
    this.calls.push({ method: 'cellsGet', sheetId, range });
    const sheet = this.findSheet(sheetId);
    const parsed = parseRange(range);
    const cells = [];
    const rows = [];
    for (let row = parsed.start.row; row <= parsed.end.row; row += 1) {
      const outputRow = [];
      rows.push(row + 1);
      for (let column = parsed.start.column; column <= parsed.end.column; column += 1) {
        outputRow.push(clone(sheet.grid[row]?.[column] || {}));
      }
      cells.push(outputRow);
    }
    const columns = [];
    for (let column = parsed.start.column; column <= parsed.end.column; column += 1) {
      columns.push(worklog.indexToColumn(column));
    }
    return {
      ranges: [{
        actual_range: range,
        cells,
        row_indices: rows,
        col_indices: columns,
      }],
    };
  }

  sheetCopy(_url, sheetId, title) {
    this.calls.push({ method: 'sheetCopy', sheetId, title });
    const source = this.findSheet(sheetId);
    const copied = {
      sheet_id: `copied-${this.nextSheet++}`,
      title,
      index: 0,
      grid: clone(source.grid),
    };
    const sourceIndex = this.sheets.findIndex((entry) => entry.sheet_id === sheetId);
    this.sheets.splice(sourceIndex + 1, 0, copied);
    this.sheets.forEach((sheet, index) => { sheet.index = index; });
    return { sheet: { sheet_id: copied.sheet_id, title } };
  }

  sheetMove(_url, sheetId, index) {
    this.calls.push({ method: 'sheetMove', sheetId, index });
    const sourceIndex = this.sheets.findIndex((entry) => entry.sheet_id === sheetId);
    const [sheet] = this.sheets.splice(sourceIndex, 1);
    this.sheets.splice(index, 0, sheet);
    this.sheets.forEach((entry, entryIndex) => { entry.index = entryIndex; });
    return { sheet_id: sheetId, index };
  }

  batchUpdate(_url, operations) {
    this.calls.push({ method: 'batchUpdate', operations: clone(operations) });
    for (const operation of operations) this.applyOperation(operation);
    return { operations_count: operations.length };
  }

  applyOperation(operation) {
    const input = operation.input;
    const sheet = this.findSheet(input.sheet_id);
    if (operation.shortcut === '+dim-delete') {
      const [startText, endText = startText] = input.range.split(':');
      const start = Number(startText) - 1;
      const count = Number(endText) - Number(startText) + 1;
      sheet.grid.splice(start, count);
      return;
    }
    if (operation.shortcut === '+dim-insert') {
      assert.equal(input.position, 'A');
      const insertionIndex = worklog.columnToIndex(input.position) + 1;
      for (const row of sheet.grid) row.splice(insertionIndex, 0, clone(row[insertionIndex] || {}));
      return;
    }
    if (operation.shortcut === '+range-copy') {
      const source = parseRange(input.source_range);
      const target = parseCellReference(input.target_range);
      for (let rowOffset = 0; rowOffset <= source.end.row - source.start.row; rowOffset += 1) {
        for (let colOffset = 0; colOffset <= source.end.column - source.start.column; colOffset += 1) {
          sheet.grid[target.row + rowOffset][target.column + colOffset] =
            clone(sheet.grid[source.start.row + rowOffset][source.start.column + colOffset]);
        }
      }
      return;
    }
    if (operation.shortcut === '+cells-set') {
      const target = parseRange(input.range);
      for (let rowOffset = 0; rowOffset < input.cells.length; rowOffset += 1) {
        for (let colOffset = 0; colOffset < input.cells[rowOffset].length; colOffset += 1) {
          const existing = sheet.grid[target.start.row + rowOffset][target.start.column + colOffset] || {};
          sheet.grid[target.start.row + rowOffset][target.start.column + colOffset] = {
            ...existing,
            ...clone(input.cells[rowOffset][colOffset]),
          };
        }
      }
      return;
    }
    if (operation.shortcut === '+rows-resize') return;
    throw new Error(`unsupported fake operation: ${operation.shortcut}`);
  }
}

function configured(url = 'https://tenant.example/sheets/example-token') {
  return {
    version: 1,
    default_spreadsheet_url: url,
    timezone: 'Asia/Shanghai',
  };
}

function monthlySheet(title, { completed = true } = {}) {
  const grid = makeGrid();
  put(grid, 'A1', { value: '' });
  put(grid, 'B1', { value: '2026/07/31 Friday', cell_styles: { background_color: '#3370ff' } });
  put(grid, 'A2', { value: '杂项' });
  put(grid, 'B2', { value: '[] open\n[x] done\n[~] progress' });
  put(grid, 'A3', {
    value: completed ? 'Finished task\n状态：已完成' : 'Active task',
    rich_text: [{ type: 'mention', mention_type: 22, mention_token: 'doc-token-one', text: 'Finished task' }],
  });
  put(grid, 'B3', { value: '[x] finished' });
  put(grid, 'A4', {
    value: 'Active task\n别名：active、AT',
    rich_text: [{ type: 'mention', mention_type: 22, mention_token: 'doc-token-two', text: 'Active task' }],
  });
  put(grid, 'B4', { value: '[] next\n[~] context' });
  return { sheet_id: `sheet-${title}`, title, grid };
}

test('canonicalizeSpreadsheetUrl keeps only a safe workbook path', () => {
  assert.equal(
    worklog.canonicalizeSpreadsheetUrl('https://tenant.example/wiki/example-token?sheet=abc#fragment'),
    'https://tenant.example/wiki/example-token',
  );
  assert.throws(
    () => worklog.canonicalizeSpreadsheetUrl('file:///tmp/workbook'),
    (error) => error.code === 'INVALID_SPREADSHEET_URL',
  );
});

test('configDirectory follows each operating-system convention', () => {
  assert.equal(
    worklog.configDirectory({ platform: 'darwin', homeDirectory: '/Users/example', env: {} }),
    '/Users/example/Library/Application Support/lark-worklog',
  );
  assert.equal(
    worklog.configDirectory({ platform: 'linux', homeDirectory: '/home/example', env: {} }),
    '/home/example/.config/lark-worklog',
  );
  assert.equal(
    worklog.configDirectory({ platform: 'win32', homeDirectory: 'C:\\Users\\example', env: { APPDATA: 'C:\\Data' } }),
    path.join('C:\\Data', 'lark-worklog'),
  );
});

test('configure validates the structure and writes a private config', { skip: process.platform === 'win32' }, () => {
  const scratch = temporaryDirectory();
  const file = path.join(scratch, 'private', 'config.json');
  const cli = new FakeLarkClient([monthlySheet('202608', { completed: false })]);
  const result = worklog.configureWorklog({
    url: 'https://tenant.example/sheets/example-token?sheet=current',
    timezone: 'Asia/Shanghai',
    cli,
    file,
    now: new Date('2026-08-12T04:00:00Z'),
  });
  assert.equal(result.configured, true);
  assert.deepEqual(worklog.loadConfig({ file }), configured());
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('daily carry removes completed lines and preserves todos, progress, and legacy text', () => {
  assert.equal(
    worklog.carryDailyText('[] todo\n[x] done\n[X] also done\n[~] progress\nlegacy note'),
    '[] todo\n[~] progress\nlegacy note',
  );
});

test('task metadata parsing and rendering preserve mentions and links', () => {
  const cell = {
    value: 'Primary task\n别名：PT、primary\n状态：已完成',
    cell_styles: { background_color: '#abcdef' },
    rich_text: [
      { type: 'mention', mention_type: 22, mention_token: 'doc-token', text: 'Primary task' },
      { type: 'text', text: '\n别名：PT、primary\n状态：已完成' },
      { type: 'text', text: '\n' },
      { type: 'link', link: 'https://example.invalid/reference', text: 'Reference' },
    ],
  };
  const parsed = worklog.parseTaskCell(cell, 7);
  assert.equal(parsed.status, 'completed');
  assert.deepEqual(parsed.aliases, ['PT', 'primary']);
  assert.equal(parsed.documents[0].token, 'doc-token');
  const rendered = worklog.upsertTaskMetadata(cell, { aliases: ['PT', 'new alias', 'pt'], status: 'active' });
  assert.equal(rendered.some((item) => item.type === 'mention' && item.mention_token === 'doc-token'), true);
  assert.equal(rendered.some((item) => item.type === 'link' && item.link === 'https://example.invalid/reference'), true);
  const text = rendered.map((item) => item.text || '').join('');
  assert.match(text, /Primary task\nReference\n别名：PT、new alias/);
  assert.doesNotMatch(text, /状态：已完成/);
});

test('task title follows the first visible line even when another document mention appears later', () => {
  const parsed = worklog.parseTaskCell({
    value: 'Legacy task title\nhttps://example.invalid/item\nDetailed document',
    rich_text: [
      { type: 'text', text: 'Legacy task title\n' },
      { type: 'link', link: 'https://example.invalid/item', text: 'https://example.invalid/item' },
      { type: 'text', text: '\n' },
      { type: 'mention', mention_type: 22, mention_token: 'document-token', text: 'Detailed document' },
    ],
  }, 5);
  assert.equal(parsed.title, 'Legacy task title');
  assert.equal(parsed.documents[0].title, 'Detailed document');
});

test('prepare copies the exact previous month, deletes completed rows, and carries the latest day', () => {
  const cli = new FakeLarkClient([monthlySheet('202607')]);
  const result = worklog.prepareWorklog({
    config: configured(),
    cli,
    now: new Date('2026-08-03T04:00:00Z'),
  });
  assert.equal(result.current_month, '202608');
  assert.equal(result.today_column, 'B');
  assert.deepEqual(result.actions.map((action) => action.type), [
    'copy_month_sheet',
    'delete_completed_task_rows',
    'insert_today_column',
  ]);
  const current = cli.sheets[0];
  assert.equal(current.title, '202608');
  assert.equal(cli.calls.some((call) => call.method === 'sheetMove' && call.index === 0), true);
  assert.equal(current.grid[0][1].value, '2026/08/03 Monday');
  assert.equal(current.grid[1][1].value, '[] open\n[~] progress');
  assert.equal(current.grid[2][0].value, 'Active task\n别名：active、AT');
  assert.equal(current.grid[2][1].value, '[] next\n[~] context');
  assert.equal(current.grid.flat().some((cell) => /状态：已完成/.test(cell.value || '')), false);

  const second = worklog.prepareWorklog({
    config: configured(),
    cli,
    now: new Date('2026-08-03T04:00:00Z'),
  });
  assert.equal(second.changed, false);
  assert.deepEqual(second.actions, []);
});

test('monthly dry-run simulates completed-row deletion before counting carried rows', () => {
  const cli = new FakeLarkClient([monthlySheet('202607')]);
  const result = worklog.prepareWorklog({
    config: configured(),
    cli,
    dryRun: true,
    now: new Date('2026-08-03T04:00:00Z'),
  });
  const insert = result.actions.find((action) => action.type === 'insert_today_column');
  assert.equal(insert.carried_rows, 2);
  assert.equal(cli.calls.some((call) => call.method === 'sheetCopy'), false);
  assert.equal(cli.calls.some((call) => call.method === 'batchUpdate'), false);
});

test('prepare skips missed dates and uses the latest prior populated day', () => {
  const sheet = monthlySheet('202608', { completed: false });
  put(sheet.grid, 'B1', { value: '2026/08/07 Friday' });
  const cli = new FakeLarkClient([sheet]);
  const result = worklog.prepareWorklog({
    config: configured(),
    cli,
    dryRun: true,
    now: new Date('2026-08-10T04:00:00Z'),
  });
  const insert = result.actions.find((action) => action.type === 'insert_today_column');
  assert.equal(insert.source_date, '2026-08-07');
  assert.equal(insert.column, 'B');
  assert.equal(cli.calls.some((call) => call.method === 'batchUpdate'), false);
});

test('prepare refuses to copy an older month when the exact previous month is missing', () => {
  const cli = new FakeLarkClient([monthlySheet('202606')]);
  assert.throws(
    () => worklog.prepareWorklog({
      config: configured(),
      cli,
      now: new Date('2026-08-03T04:00:00Z'),
    }),
    (error) => error.code === 'PREVIOUS_MONTH_MISSING',
  );
  assert.equal(cli.calls.some((call) => call.method === 'sheetCopy'), false);
});

test('new task document failure leaves the sheet untouched', () => {
  let sheetWrites = 0;
  assert.throws(() => worklog.createTaskTransaction({
    task: { title: 'Example task' },
    documents: { create() { throw new Error('document unavailable'); } },
    sheet: { insert() { sheetWrites += 1; } },
  }), /document unavailable/);
  assert.equal(sheetWrites, 0);
});

test('new task creation escapes XML and inserts only after the document exists', () => {
  const events = [];
  const result = worklog.createTaskTransaction({
    task: {
      title: 'A & B <test>',
      background: 'Context & constraints',
      aliases: ['AB', 'ab'],
      links: [{ url: 'https://example.invalid/reference?x=1&y=2', title: 'PRD & notes' }],
    },
    documents: {
      create(input) {
        events.push(['document', input]);
        return { document_id: 'document-token', url: 'https://example.invalid/docx/document-token' };
      },
    },
    sheet: {
      insert(input) {
        events.push(['sheet', input]);
        return { row: 3 };
      },
    },
  });
  assert.deepEqual(events.map(([type]) => type), ['document', 'sheet']);
  assert.match(events[0][1].content, /A &amp; B &lt;test&gt;/);
  assert.match(events[0][1].content, /PRD &amp; notes/);
  assert.deepEqual(events[1][1].aliases, ['AB']);
  assert.deepEqual(events[1][1].document.rich_text, [
    {
      type: 'mention',
      mention_type: 22,
      mention_token: 'document-token',
      text: 'A & B <test>',
      link: 'https://example.invalid/docx/document-token',
    },
    { type: 'text', text: ' ' },
  ]);
  assert.equal(result.inserted.row, 3);
});

test('task document mentions require both a token and a link', () => {
  assert.throws(
    () => worklog.taskDocumentRichText({ title: 'Example', url: '', token: 'document-token' }),
    (error) => error.code === 'INVALID_RELATED_URL',
  );
  assert.throws(
    () => worklog.taskDocumentRichText({ title: 'Example', url: 'https://example.invalid/docx/token', token: '' }),
    (error) => error.code === 'DOCUMENT_TOKEN_REQUIRED',
  );
  assert.equal(
    worklog.taskDocumentRichText({
      title: 'Example',
      url: 'https://example.invalid/docx/token',
      token: 'document-token',
    })[0].link,
    'https://example.invalid/docx/token',
  );
});

test('date and row helpers cover year boundaries and descending deletion order', () => {
  assert.equal(worklog.previousMonth('202601'), '202512');
  assert.deepEqual(worklog.contiguousRowRangesDescending([3, 4, 8, 10, 11]), ['10:11', '8', '3:4']);
});
