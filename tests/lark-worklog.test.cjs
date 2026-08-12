const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const scriptPath = path.resolve(__dirname, '../skills/lark-worklog/scripts/worklog-rules.cjs');
const skillPath = path.resolve(__dirname, '../skills/lark-worklog/SKILL.md');
const formatPath = path.resolve(__dirname, '../skills/lark-worklog/references/worklog-format.md');
const readmePath = path.resolve(__dirname, '../README.md');
const readmeZhPath = path.resolve(__dirname, '../README.zh-CN.md');
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

test('the helper is stateless and contains no Lark CLI adapter', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');
  assert.doesNotMatch(source, /child_process|spawnSync|execFile|execSync|lark-cli/);
  assert.doesNotMatch(source, /writeFile|mkdir|rename|configDirectory|configPath|LARK_WORKLOG_CONFIG_DIR/);
  assert.doesNotMatch(source, /default_spreadsheet_url|timeZone\s*:/);
});

test('the skill declares every official dependency and the official installation path', () => {
  const source = fs.readFileSync(skillPath, 'utf8');
  for (const dependency of ['lark-shared', 'lark-drive', 'lark-sheets', 'lark-doc']) {
    assert.match(source, new RegExp('`' + dependency + '`'));
  }
  assert.match(source, /https:\/\/github\.com\/larksuite\/cli#installation--quick-start/);
  assert.match(source, /npx @larksuite\/cli@latest install/);
  assert.match(source, /offer to follow the official guide and perform the installation and verification/);
  assert.match(source, /do not run the installer until they agree/);
});

test('target discovery searches only current-user-created sheets with the literal marker', () => {
  const skill = fs.readFileSync(skillPath, 'utf8');
  const format = fs.readFileSync(formatPath, 'utf8');
  for (const source of [skill, format]) {
    assert.match(source, /drive \+search --query '\[worklog\]' --only-title/);
    assert.match(source, /--doc-types sheet --created-by-me/);
    assert.match(source, /literal, case-sensitive substring `\[worklog\]`/);
    assert.match(source, /first exact match/);
    assert.match(source, /exactly one.*stable/si);
  }
  assert.match(format, /original-creator semantics/);
  assert.match(skill, /Never silently switch to a later result/);
  assert.match(skill, /Do not call Drive search again in that conversation/);
  assert.match(format, /Discover the workbook once per conversation/);
});

test('the workflow persists no local configuration and uses the required new-workbook title', () => {
  const sources = [skillPath, formatPath, readmePath, readmeZhPath].map((file) => fs.readFileSync(file, 'utf8'));
  for (const source of sources) {
    assert.doesNotMatch(source, /worklog-state\.cjs|default_spreadsheet_url|LARK_WORKLOG_CONFIG_DIR/);
  }
  assert.match(sources[0], /Keep no persistent local configuration/);
  assert.match(sources[1], /titled `工作日志 \[worklog\]`/);
  assert.match(sources[2], /fixed title `工作日志 \[worklog\]`/);
  assert.match(sources[3], /标题固定为 `工作日志 \[worklog\]`/);
  assert.match(sources[2], /\[简体中文\]\(README\.zh-CN\.md\)/);
  assert.match(sources[3], /\[English\]\(README\.md\)/);
});

test('the documented workflow retains rollover and task-creation safety invariants', () => {
  const source = fs.readFileSync(formatPath, 'utf8');
  assert.match(source, /require the exact previous month/);
  assert.match(source, /never select an older month/);
  assert.match(source, /Do not create columns for skipped dates/);
  assert.match(source, /状态：已完成/);
  assert.match(source, /create a document in `my_library` before touching the sheet/);
  assert.match(source, /Never create a second document or delete the first one automatically/);
  assert.match(source, /Background colors are migration candidates, never task status/);
  assert.match(source, /--position B --count 1 --inherit-style after/);
  assert.match(source, /Never use `--position A` or `--position C`/);
  assert.match(source, /never use `\+range-move` or `\+dim-delete`/);
  assert.match(source, /automatic date\/month rollover.*slightly slower/si);
});
