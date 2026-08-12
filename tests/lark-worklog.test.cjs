const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const scriptPath = path.resolve(__dirname, '../skills/lark-worklog/scripts/worklog-rules.cjs');
const worklog = require(scriptPath);

test('date helpers use the process-local calendar and cover year boundaries', () => {
  assert.deepEqual(
    worklog.dateIdentity(new Date(2026, 7, 12, 12, 0, 0)),
    {
      key: '2026-08-12',
      month: '202608',
      header: '2026/08/12 Wednesday',
    },
  );
  assert.equal(worklog.previousMonth('202601'), '202512');
  assert.throws(
    () => worklog.previousMonth('202613'),
    (error) => error.code === 'INVALID_MONTH',
  );
});

test('daily carry removes completed lines and preserves todos, progress, and unrecognized text', () => {
  assert.equal(
    worklog.carryDailyText('[] todo\n[x] done\n[X] also done\n[~] progress\nplain note'),
    '[] todo\n[~] progress\nplain note',
  );
});

test('day rollover plan always inserts before B and shifts the source exactly once', () => {
  assert.deepEqual(
    worklog.dayRolloverPlan({ sourceColumn: 'B', lastRow: 30 }),
    {
      insert: { position: 'B', count: 1, inherit_style: 'after' },
      inserted_column: 'B',
      source_column_before_insert: 'B',
      source_column_after_insert: 'C',
      format_source_range_after_insert: 'C1:C30',
      target_range: 'B1:B30',
    },
  );
  assert.equal(
    worklog.dayRolloverPlan({ sourceColumn: 'AZ', lastRow: 2 }).source_column_after_insert,
    'BA',
  );
  assert.throws(
    () => worklog.dayRolloverPlan({ sourceColumn: 'A', lastRow: 30 }),
    (error) => error.code === 'INVALID_SOURCE_COLUMN',
  );
});

test('document mention links are restored without changing other rich-text segments', () => {
  const richText = [
    { type: 'mention', mention_type: 22, mention_token: 'doc_single', text: 'Task one' },
    { type: 'text', text: '\n别名：one' },
    { type: 'mention', mention_type: 0, mention_token: 'user_1', text: 'Owner', notify: false },
  ];

  assert.deepEqual(
    worklog.resolveMentions(richText, { documentBaseUrl: 'https://tenant.example/wiki/' }),
    [
      {
        type: 'mention',
        mention_type: 22,
        mention_token: 'doc_single',
        text: 'Task one',
        link: 'https://tenant.example/wiki/doc_single',
      },
      { type: 'text', text: '\n别名：one' },
      { type: 'mention', mention_type: 0, mention_token: 'user_1', text: 'Owner', notify: false },
    ],
  );
  assert.throws(
    () => worklog.resolveMentions(richText),
    (error) => error.code === 'UNRESOLVED_MENTION_LINK',
  );
});

test('status writes preserve single and multiple document mentions and omit styles', () => {
  const cellsGet = {
    ok: true,
    data: {
      ranges: [{
        row_indices: [8, 9, 10],
        col_indices: ['A'],
        cells: [
          [{
            value: 'Single task',
            rich_text: [{ type: 'mention', mention_type: 22, mention_token: 'doc_1', text: 'Single task' }],
            cell_styles: { background_color: '#eeeeee' },
          }],
          [{
            value: 'Multi task',
            rich_text: [
              { type: 'mention', mention_type: 22, mention_token: 'doc_2', text: 'Main' },
              { type: 'text', text: ' / ' },
              { type: 'mention', mention_type: 22, mention_token: 'doc_3', text: 'PRD' },
              { type: 'text', text: '\n状态：挂起' },
              { type: 'mention', mention_type: 22, mention_token: 'doc_4', text: 'Design' },
            ],
            cell_styles: { background_color: '#ffffff' },
          }],
          [{ value: 'Plain task', cell_styles: { background_color: '#dddddd' } }],
        ],
      }],
    },
  };

  const plan = worklog.buildStatusWrites(cellsGet, {
    sheetId: 'sheet_1',
    rowStatuses: new Map([[8, '已完成'], [9, '已完成'], [10, '挂起']]),
    documentBaseUrl: 'https://tenant.example/wiki',
  });

  assert.deepEqual(plan.writes.map((write) => write.range), ['A8', 'A9', 'A10']);
  assert.equal(plan.writes.every((write) => !('cell_styles' in write.cells[0][0])), true);
  assert.deepEqual(
    plan.writes[1].cells[0][0].rich_text
      .filter((segment) => segment.type === 'mention')
      .map((segment) => [segment.mention_token, segment.link]),
    [
      ['doc_2', 'https://tenant.example/wiki/doc_2'],
      ['doc_3', 'https://tenant.example/wiki/doc_3'],
      ['doc_4', 'https://tenant.example/wiki/doc_4'],
    ],
  );
  assert.equal(
    plan.writes[1].cells[0][0].rich_text
      .filter((segment) => segment.type === 'text')
      .map((segment) => segment.text)
      .join('')
      .match(/状态：已完成/g)?.length,
    1,
  );
  assert.equal(plan.expectations[0].background_color, '#eeeeee');
  assert.equal(plan.expectations[1].mention_tokens.length, 3);
});

test('row status specifications support one status or per-range statuses', () => {
  assert.deepEqual(
    [...worklog.parseRowStatusSpec('6,7-9', '已完成')],
    [[6, '已完成'], [7, '已完成'], [8, '已完成'], [9, '已完成']],
  );
  assert.deepEqual(
    [...worklog.parseRowStatusSpec('6-7:已完成,8-9:挂起')],
    [[6, '已完成'], [7, '已完成'], [8, '挂起'], [9, '挂起']],
  );
});

test('status planning rejects incomplete cells-get responses', () => {
  const options = {
    sheetId: 'sheet_1',
    rowStatuses: new Map([[8, '已完成']]),
  };
  for (const incomplete of [
    { truncated: true },
    { has_more: true },
    { complete: false },
    { data: { ranges: [{ truncated: true }] } },
  ]) {
    assert.throws(
      () => worklog.buildStatusWrites(incomplete, options),
      (error) => error.code === 'INCOMPLETE_CELLS_GET',
    );
  }
});

test('set-status CLI emits a cells-set writes payload without style fields', () => {
  const input = {
    data: {
      ranges: [{
        row_indices: [6],
        col_indices: ['A'],
        cells: [[{
          value: 'Task',
          rich_text: [
            { type: 'mention', mention_type: 22, mention_token: 'doc_6', text: 'Task' },
            { type: 'text', text: '\n状态：挂起' },
          ],
          style: { background_color: '#abcdef' },
        }]],
      }],
    },
  };
  const result = spawnSync(process.execPath, [
    scriptPath,
    'set-status',
    '--sheet-id', 'sheet_1',
    '--rows', '6',
    '--status', '已完成',
    '--document-base-url', 'https://tenant.example/wiki',
    '--writes-only',
  ], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const writes = JSON.parse(result.stdout);
  assert.deepEqual(writes[0].range, 'A6');
  assert.equal('cell_styles' in writes[0].cells[0][0], false);
  assert.equal(
    writes[0].cells[0][0].rich_text.map((segment) => segment.text).join('').match(/状态：已完成/g)?.length,
    1,
  );
  assert.doesNotMatch(
    writes[0].cells[0][0].rich_text.map((segment) => segment.text).join(''),
    /\n\n状态：/,
  );
});
