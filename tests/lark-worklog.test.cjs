const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const scriptPath = path.resolve(__dirname, '../skills/lark-worklog/scripts/worklog-rules.cjs');
const cacheScriptPath = path.resolve(__dirname, '../skills/lark-worklog/scripts/worklog-cache.cjs');
const worklog = require(scriptPath);
const cache = require(cacheScriptPath);

function cacheCellsGet({ revision = 10, taskText = '[] cached todo' } = {}) {
  return {
    ok: true,
    data: {
      has_more: false,
      revision,
      ranges: [{
        actual_range: 'A1:B6',
        truncated: false,
        row_indices: [1, 2, 3, 4, 5, 6],
        col_indices: ['A', 'B'],
        cells: [
          [{}, { value: '2026/08/19 Wednesday' }],
          [{ value: '杂项' }, { value: taskText }],
          [{ value: 'Task one\n别名：one、first\nbackground note\n状态：挂起' }, { value: '[~] investigating' }],
          [{ value: 'Task two' }, {}],
          [{}, {}],
          [{}, {}],
        ],
      }],
    },
  };
}

function cacheMetadata(identityKey = 'tenant:user-one') {
  return {
    identityKey,
    workbookTitle: '工作日志 [worklog]',
    workbookToken: 'sheet_token',
    sheetId: 'sheet_id',
    date: '2026-08-19',
  };
}

function withCacheDirectory(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-worklog-cache-'));
  try {
    return callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

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

test('cache snapshots contain only the current A:B read model and trim trailing rows', () => {
  const snapshot = cache.buildSnapshot(
    cacheCellsGet(),
    cacheMetadata(),
    new Date('2026-08-19T09:00:00.000Z'),
  );

  assert.equal(snapshot.state, 'clean');
  assert.equal(snapshot.prepared_date, '2026-08-19');
  assert.equal(snapshot.actual_range, 'A1:B4');
  assert.equal(snapshot.rows.length, 3);
  assert.deepEqual(snapshot.rows[0].daily_items, [{ type: 'open', text: 'cached todo' }]);
  assert.deepEqual(snapshot.rows[1], {
    row: 3,
    title: 'Task one',
    aliases: ['one', 'first'],
    status: '挂起',
    notes: ['background note'],
    daily_text: '[~] investigating',
    daily_items: [{ type: 'progress', text: 'investigating' }],
  });
  assert.equal(JSON.stringify(snapshot).includes('mention_token'), false);
});

test('same-day cache reads hit without an identity when exactly one entry exists', () => {
  withCacheDirectory((root) => {
    cache.replaceCache({
      root,
      identityKey: 'tenant:user-one',
      cellsGet: cacheCellsGet(),
      metadata: cacheMetadata(),
      now: new Date('2026-08-19T09:00:00.000Z'),
    });

    const hit = cache.cacheReadResult({ root, date: '2026-08-19' });
    assert.equal(hit.status, 'hit');
    assert.equal(hit.snapshot.target.workbook_token, 'sheet_token');
    assert.equal(hit.snapshot.rows[0].title, '杂项');
    assert.deepEqual(
      cache.cacheReadResult({ root, date: '2026-08-20' }),
      {
        status: 'miss',
        reason: 'date_mismatch',
        prepared_date: '2026-08-19',
        expected_date: '2026-08-20',
        target: {
          workbook_title: '工作日志 [worklog]',
          workbook_token: 'sheet_token',
          sheet_id: 'sheet_id',
          month: '202608',
        },
      },
    );

    if (process.platform !== 'win32') {
      const mode = fs.statSync(root).mode & 0o777;
      assert.equal(mode, 0o700);
      const entry = fs.readdirSync(root).find((file) => file.endsWith('.json'));
      assert.equal(fs.statSync(path.join(root, entry)).mode & 0o777, 0o600);
    }
  });
});

test('write leases make cache reads miss until a verified full snapshot replaces it', () => {
  withCacheDirectory((root) => {
    cache.replaceCache({
      root,
      identityKey: 'tenant:user-one',
      cellsGet: cacheCellsGet(),
      metadata: cacheMetadata(),
    });
    const lease = cache.acquireLease({
      root,
      identityKey: 'tenant:user-one',
      owner: 'writer-one',
      now: new Date('2026-08-19T10:00:00.000Z'),
    });
    assert.equal(lease.owner, 'writer-one');
    assert.deepEqual(
      cache.cacheReadResult({ root, date: '2026-08-19', identityKey: 'tenant:user-one' }),
      { status: 'miss', reason: 'write_in_progress' },
    );
    assert.throws(
      () => cache.acquireLease({ root, identityKey: 'tenant:user-one', owner: 'writer-two' }),
      (error) => error.code === 'CACHE_LOCKED',
    );

    cache.replaceCache({
      root,
      identityKey: 'tenant:user-one',
      owner: 'writer-one',
      cellsGet: cacheCellsGet({ revision: 11, taskText: '[] refreshed todo' }),
      metadata: cacheMetadata(),
      now: new Date('2026-08-19T10:01:00.000Z'),
    });
    const hit = cache.cacheReadResult({ root, date: '2026-08-19', identityKey: 'tenant:user-one' });
    assert.equal(hit.status, 'hit');
    assert.equal(hit.snapshot.revision, 11);
    assert.equal(hit.snapshot.rows[0].daily_items[0].text, 'refreshed todo');
  });
});

test('aborted writes leave the cache dirty and multiple identities require disambiguation', () => {
  withCacheDirectory((root) => {
    cache.replaceCache({
      root,
      identityKey: 'tenant:user-one',
      cellsGet: cacheCellsGet(),
      metadata: cacheMetadata(),
    });
    cache.acquireLease({ root, identityKey: 'tenant:user-one', owner: 'writer-one' });
    cache.abortWrite({
      root,
      identityKey: 'tenant:user-one',
      owner: 'writer-one',
      reason: 'verification_failed',
    });
    assert.deepEqual(
      cache.cacheReadResult({ root, date: '2026-08-19', identityKey: 'tenant:user-one' }),
      {
        status: 'miss',
        reason: 'verification_failed',
        target: {
          workbook_title: '工作日志 [worklog]',
          workbook_token: 'sheet_token',
          sheet_id: 'sheet_id',
          month: '202608',
        },
      },
    );

    cache.replaceCache({
      root,
      identityKey: 'tenant:user-two',
      cellsGet: cacheCellsGet({ revision: 12 }),
      metadata: cacheMetadata('tenant:user-two'),
    });
    assert.deepEqual(
      cache.cacheReadResult({ root, date: '2026-08-19' }),
      { status: 'miss', reason: 'identity_ambiguous', entry_count: 2 },
    );
  });
});

test('explicit invalidation requires refresh and stale leases recover only from a full live snapshot', () => {
  withCacheDirectory((root) => {
    cache.replaceCache({
      root,
      identityKey: 'tenant:user-one',
      cellsGet: cacheCellsGet(),
      metadata: cacheMetadata(),
    });
    cache.markDirty({
      root,
      identityKey: 'tenant:user-one',
      reason: 'manual_edit_reported',
      now: new Date('2026-08-19T09:00:00.000Z'),
    });
    const invalidated = cache.cacheReadResult({
      root,
      date: '2026-08-19',
      identityKey: 'tenant:user-one',
    });
    assert.equal(invalidated.status, 'miss');
    assert.equal(invalidated.reason, 'manual_edit_reported');
    assert.equal(invalidated.target.workbook_token, 'sheet_token');

    cache.replaceCache({
      root,
      identityKey: 'tenant:user-one',
      cellsGet: cacheCellsGet(),
      metadata: cacheMetadata(),
    });
    cache.acquireLease({
      root,
      identityKey: 'tenant:user-one',
      owner: 'crashed-writer',
      now: new Date('2026-08-19T10:00:00.000Z'),
    });
    assert.throws(
      () => cache.replaceCache({
        root,
        identityKey: 'tenant:user-one',
        cellsGet: cacheCellsGet({ revision: 13 }),
        metadata: cacheMetadata(),
        recover: true,
        now: new Date('2026-08-19T10:10:00.000Z'),
      }),
      (error) => error.code === 'CACHE_LOCKED',
    );
    cache.replaceCache({
      root,
      identityKey: 'tenant:user-one',
      cellsGet: cacheCellsGet({ revision: 13, taskText: '[] recovered todo' }),
      metadata: cacheMetadata(),
      recover: true,
      now: new Date('2026-08-19T10:31:00.000Z'),
    });
    const recovered = cache.cacheReadResult({ root, date: '2026-08-19' });
    assert.equal(recovered.status, 'hit');
    assert.equal(recovered.snapshot.revision, 13);
    assert.equal(recovered.snapshot.rows[0].daily_items[0].text, 'recovered todo');
  });
});

test('cache replacement rejects clipped snapshots and non-today column B', () => {
  const clipped = cacheCellsGet();
  clipped.data.has_more = true;
  assert.throws(
    () => cache.buildSnapshot(clipped, cacheMetadata()),
    (error) => error.code === 'INCOMPLETE_CELLS_GET',
  );

  const wrongDate = cacheCellsGet();
  wrongDate.data.ranges[0].cells[0][1].value = '2026/08/18 Tuesday';
  assert.throws(
    () => cache.buildSnapshot(wrongDate, cacheMetadata()),
    (error) => error.code === 'DATE_HEADER_MISMATCH',
  );
});

test('cache refuses an existing POSIX directory visible to other users', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-worklog-cache-insecure-'));
  try {
    fs.chmodSync(root, 0o755);
    assert.throws(
      () => cache.replaceCache({
        root,
        identityKey: 'tenant:user-one',
        cellsGet: cacheCellsGet(),
        metadata: cacheMetadata(),
      }),
      (error) => error.code === 'INSECURE_CACHE_DIRECTORY',
    );
  } finally {
    fs.chmodSync(root, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cache CLI replaces and reads a same-day snapshot', () => {
  withCacheDirectory((root) => {
    const replace = spawnSync(process.execPath, [
      cacheScriptPath,
      'replace',
      '--cache-dir', root,
      '--identity-key', 'tenant:user-one',
      '--workbook-token', 'sheet_token',
      '--workbook-title', '工作日志 [worklog]',
      '--sheet-id', 'sheet_id',
      '--date', '2026-08-19',
    ], {
      input: JSON.stringify(cacheCellsGet()),
      encoding: 'utf8',
    });
    assert.equal(replace.status, 0, replace.stderr);

    const get = spawnSync(process.execPath, [
      cacheScriptPath,
      'get',
      '--cache-dir', root,
      '--date', '2026-08-19',
    ], { encoding: 'utf8' });
    assert.equal(get.status, 0, get.stderr);
    const output = JSON.parse(get.stdout);
    assert.equal(output.data.status, 'hit');
    assert.equal(output.data.snapshot.rows[0].daily_items[0].text, 'cached todo');
  });
});
