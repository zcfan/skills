const assert = require('node:assert/strict');
const path = require('node:path');
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

test('daily carry removes completed lines and preserves todos, progress, and legacy text', () => {
  assert.equal(
    worklog.carryDailyText('[] todo\n[x] done\n[X] also done\n[~] progress\nlegacy note'),
    '[] todo\n[~] progress\nlegacy note',
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
