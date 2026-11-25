'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, relative, resolve } = require('node:path');

const root = resolve(__dirname, '..');
const sourceGroups = {
  Skill: ['healthy-fitness-coach/references', 'healthy-fitness-coach/scripts'],
  Connector: ['healthy-fitness-coach-plugin/mcp/xunji/src']
};

const floors = require('./coverage-baseline.json');
const changedFloors = { lines: 95, branches: 90 };
if (process.env.GITHUB_ACTIONS === 'true') {
  assert.ok(process.env.QUALITY_BASE_SHA, 'CI must provide the changed-coverage base commit');
}

function coverageCounts(records) {
  const counts = {};
  for (const [metric, key] of Object.entries({ lines: 's', branches: 'b', functions: 'f' })) {
    const values = records.flatMap((record) => Object.values(record[key]).flat());
    counts[metric] = { total: values.length, covered: values.filter((value) => value > 0).length };
  }
  return counts;
}

function checkCoverage(label, counts, thresholds) {
  for (const [metric, minimum] of Object.entries(thresholds)) {
    const { total, covered } = counts[metric];
    const rate = total ? covered / total * 100 : 100;
    console.log(`${label} ${metric}: ${covered}/${total} (${rate.toFixed(2)}%), minimum ${minimum}%`);
    if (rate < minimum) process.exitCode = 1;
  }
}

function changedLines(base) {
  assert.match(base, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i, 'QUALITY_BASE_SHA must be a full commit hash');
  const pathspec = Object.values(sourceGroups).flat();
  const diff = execFileSync('git', [
    '-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-renames', '--unified=0',
    base, '--', ...pathspec
  ], { cwd: root, encoding: 'utf8' });
  const result = new Map();
  let filename;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) filename = undefined;
    if (line.startsWith('+++ b/')) {
      filename = line.slice('+++ b/'.length).replace(/\t$/, '');
      result.set(filename, new Set());
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!filename || !hunk) continue;
    const start = Number(hunk[1]);
    const count = Number(hunk[2] ?? 1);
    for (let number = start; number < start + count; number++) result.get(filename).add(number);
  }
  const tracked = execFileSync('git', [
    'diff', '--no-renames', '--name-only', '--diff-filter=ACMRTUXB', '-z', base, '--', ...pathspec
  ], { cwd: root, encoding: 'utf8' });
  for (const file of tracked.split('\0').filter(Boolean)) {
    // Quoted or binary diff headers may have no usable hunk locations.
    if (!result.has(file)) result.set(file, null);
  }
  const untracked = execFileSync('git', ['ls-files', '-z', '--others', '--exclude-standard', '--', ...pathspec],
    { cwd: root, encoding: 'utf8' });
  for (const file of untracked.split('\0').filter(Boolean)) result.set(file, null);
  return result;
}

function changedCounts(coverage, changes) {
  const lines = [];
  const branches = [];
  const uncovered = { lines: new Set(), branches: new Set() };
  for (const [file, edited] of changes) {
    if (!file.endsWith('.js') || !existsSync(join(root, file))) continue;
    const record = coverage.get(file);
    assert.ok(record, `Changed source has no coverage record: ${file}`);
    for (const [id, location] of Object.entries(record.statementMap)) {
      if (!edited || edited.has(location.start.line)) {
        lines.push(record.s[id]);
        if (!record.s[id]) uncovered.lines.add(`${file}:${location.start.line}`);
      }
    }
    for (const [id, branch] of Object.entries(record.branchMap)) {
      for (const [index, location] of branch.locations.entries()) {
        if (!edited || edited.has(location.start.line)) {
          branches.push(record.b[id][index]);
          if (!record.b[id][index]) uncovered.branches.add(`${file}:${location.start.line}:${Math.max(1, location.start.column + 1)}`);
        }
      }
    }
  }
  const count = (values) => ({ total: values.length, covered: values.filter((value) => value > 0).length });
  for (const [metric, locations] of Object.entries(uncovered)) {
    const values = metric === 'lines' ? lines : branches;
    if (values.length && count(values).covered / values.length * 100 < changedFloors[metric]) {
      console.error(`Uncovered changed ${metric}:\n${[...locations].join('\n')}`);
    }
  }
  return { lines: count(lines), branches: count(branches) };
}

const temporary = mkdtempSync(join(tmpdir(), 'fitness-quality-coverage-'));
try {
  const c8 = join(dirname(require.resolve('c8')), 'bin', 'c8.js');
  const include = Object.values(sourceGroups).flatMap((paths) => paths.map((path) => `--include=${path}/**/*.js`));
  const child = spawnSync(process.execPath, [
    c8, '--all', '--reporter=json', '--reports-dir', temporary, '--temp-directory', join(temporary, 'raw'),
    ...include, process.execPath, join(__dirname, 'run-node-tests.js')
  ], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    console.error('Source tests or coverage collection failed');
    process.exitCode = 1;
  }
  const report = JSON.parse(readFileSync(join(temporary, 'coverage-final.json'), 'utf8'));
  const coverage = new Map(Object.entries(report).map(([file, counters]) => [relative(root, file).replaceAll('\\', '/'), counters]));
  for (const [group, paths] of Object.entries(sourceGroups)) {
    const records = [...coverage].filter(([file]) => paths.some((path) => file.startsWith(`${path}/`))).map(([, record]) => record);
    assert.ok(records.length > 0, `No production coverage reported for ${group}`);
    const counts = coverageCounts(records);
    assert.ok(Object.values(counts).every(({ total }) => total > 0), `Empty coverage metric in ${group}`);
    checkCoverage(group, counts, floors[group]);
  }
  if (process.env.QUALITY_BASE_SHA) {
    checkCoverage('Changed JavaScript source', changedCounts(coverage, changedLines(process.env.QUALITY_BASE_SHA)), changedFloors);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
