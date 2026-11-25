'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { normalizeCurrentState } = require('../references/athlete-state.js');
const { planOutputAssets } = require('../references/output-routing.js');
const { assessTodayReadiness } = require('../references/readiness-engine.js');
const { inspectSafety, hasPositiveRedFlagText } = require('../references/safety-context.js');
const { assessResume, createCheckpoint, saveCheckpoint } = require('../references/training-continuity.js');
const { buildWorkflowDecision, classifyTrainingTask } = require('../references/training-orchestrator.js');

test('structured safety survives normalizing explicit codes and rejects empty records', () => {
  const state = normalizeCurrentState({
    red_flags: [{ code: 'recent_surgery' }, { metadata: 'not a flag' }],
    safety: { symptoms: [{ code: '明显气短' }, { description: '胸痛', present: false }] }
  });
  assert.deepEqual(state.red_flags, [{ code: 'recent_surgery' }]);
  assert.deepEqual(state.safety.symptoms, ['明显气短']);
  assert.equal(inspectSafety({ current_state: state }).reason, 'reported_red_flag');
  assert.equal(normalizeCurrentState({ symptoms: [null, { present: false, code: '胸痛' }] }).symptoms, undefined);
  assert.equal(inspectSafety({ red_flags: [0, NaN, Infinity, 'no unusual flag', ''] }).status, 'clear');
  assert.equal(inspectSafety({ safety: { redFlags: 1 } }).status, 'stop');
  assert.equal(inspectSafety({ pain: 1, symptoms: true }).status, 'clear');
  assert.equal(inspectSafety({ red_flags: 'emergency_unknown_code' }).status, 'stop');
  assert.equal(inspectSafety({ symptoms: { code: 'chest_pain' } }).status, 'stop');
  assert.equal(hasPositiveRedFlagText(), false);
  assert.equal(hasPositiveRedFlagText('昨天胸痛已经消失'), false);
  assert.equal(hasPositiveRedFlagText('明显气短'), true);
  const nested = { records: [{ red_flags: '明显气短' }] };
  nested.self = nested;
  assert.equal(inspectSafety(nested).status, 'stop');
});

test('portable route permits a confirmed mobile attachment and otherwise keeps a conversational default', () => {
  assert.deepEqual(planOutputAssets({ taskType: 'training_plan', capabilities: { mobile: true, can_write_files: true } }).artifacts, []);
  assert.deepEqual(planOutputAssets({
    taskType: 'today_workout', userInstruction: '保存刚才内容', capabilities: { mobile: true, can_write_files: true }
  }).artifacts, ['TODAY_WORKOUT.md']);
  assert.equal(assessTodayReadiness({
    program: { session_budget: { declared_minutes: 45 } }, currentState: { available_time_min: 22 }
  }).status, 'defer');
});

test('analysis and verification accept valid calendar ranges and clarify malformed or unavailable dates', () => {
  const capabilities = { xunji_connector: true, credentials_ready: true };
  const analyze = (input = {}) => buildWorkflowDecision({ taskType: 'xunji_analysis', capabilities, ...input }).data_source;
  const connect = (instruction) => buildWorkflowDecision({ instruction, capabilities }).connection;
  assert.deepEqual(analyze({ start_date: '2024-02-28', end_date: '2024-03-01' }), {
    status: 'read_pending', action: 'read_range', start_date: '2024-02-28', end_date: '2024-03-01'
  });
  for (const invalid of [
    { start_date: '2024-02-28' },
    { start_date: '2024-02-28', end_date: '2024-02-30' },
    { start_date: '2024-03-01', end_date: '2024-02-28' },
    { end_date: '2024-03-01' },
    { instruction: '分析训记 2024-03-01 到 2024-02-28' },
    { instruction: '分析训记 2024-02-30' },
    { instruction: '分析训记最近 99999999999 天', reference_date: '2024-02-28' },
    { instruction: '分析训记最近 0 天', reference_date: '2024-02-28' },
    { instruction: '分析训记最近 2 天', reference_date: '2024-02-30' },
    { instruction: '分析训记今天', now: NaN }
  ]) assert.equal(analyze(invalid).status, 'date_range_needed', JSON.stringify(invalid));
  assert.equal(analyze({ instruction: '分析训记今天', reference_date: '2024-02-29' }).start_date, '2024-02-29');
  assert.equal(analyze({ instruction: 'analyze Xunji for last 2 days', reference_date: '2024-03-01' }).start_date, '2024-02-29');
  assert.equal(analyze({ instruction: '分析训记 2024-02-28 至 2024-03-01' }).end_date, '2024-03-01');
  assert.equal(connect('连接训记 2024-02-29').date, '2024-02-29');
  assert.equal(connect('连接训记').next, 'ask_for_verification_date');
  assert.equal(connect('连接训记 2024-02-28 至 2024-03-01').next, 'ask_for_verification_date');
  assert.equal(analyze({ connector_result: { records: [{}] } }).status, 'read_complete');
  assert.equal(analyze({ connector_result: { records: [], missing_dates: 'bad' } }).status, 'read_failed');
  assert.equal(analyze({ connector_result: { records: [], partial: true, days: [{}] } }).action, 'report_partial_coverage');
  assert.equal(analyze({ connector_result: { records: [], error: { code: 'invalid_credentials' } } }).status, 'read_failed');
});

test('explicit denial of reading honors a ready connector and writeback still asks for a preview input', () => {
  const capabilities = { xunji_connector: true, credentials_ready: true };
  const response = buildWorkflowDecision({ taskType: 'xunji_analysis', instruction: '不要从训记读数据，分析今天', capabilities });
  assert.equal(response.data_source.status, 'import_needed');
  assert.equal(classifyTrainingTask({ instruction: '不要写回，然后帮我制定训练计划' }), 'training_plan');
  assert.equal(classifyTrainingTask({ taskType: 'xunji_writeback', instruction: '请把这条记录写回' }), 'xunji_writeback');
  assert.equal(buildWorkflowDecision({ instruction: '帮我把这条记录写回训记好吗？' }).writeback.next, 'request_records_for_preview');
  assert.equal(classifyTrainingTask({ instruction: '训练计划同步一下？' }), 'training_plan');
});

test('checkpoints distinguish invalid calendar data, clock failures and consented file collisions', () => {
  for (const dates of [
    { updated_at: '2026-02-30' },
    { updated_at: 123 },
    { updated_at: '11/24/2026' },
    { valid_until: '2026-11-24T12:00:00' },
    { valid_until: 'invalid' },
    { timezone: '' },
    { timezone: 123 },
    { timezone: 'Unrecognized/Timezone' }
  ]) {
    assert.throws(() => createCheckpoint({ updated_at: '2026-11-24', valid_until: '2026-11-24', ...dates }), /expiry dates/);
  }
  const instant = createCheckpoint({
    updated_at: '2026-11-24T00:00:00-05:00', valid_until: '2026-11-24T12:00:00-05:00', timezone: 'America/New_York'
  });
  assert.equal(assessResume(instant, { now: NaN, state_confirmed: true }).status, 'confirm_current_state');
  assert.equal(assessResume(instant, { now: Date.parse('2026-11-24T17:00:00.001Z') }).status, 'stale');
  assert.equal(assessResume(null).status, 'invalid');
  assert.equal(assessResume({ schema_version: '2.0' }).status, 'invalid');
  assert.equal(assessResume({ ...instant, program: undefined }).status, 'invalid');
  assert.equal(assessResume({ ...instant, program: [] }).status, 'invalid');
  assert.equal(assessResume({ ...instant, program: { ...instant.program, minimum_version: 10 } }).status, 'invalid');
  assert.equal(assessResume({ ...instant, next_session: null }).status, 'invalid');
  assert.equal(assessResume({ ...instant, pending_questions: [false] }).status, 'invalid');
  const day = createCheckpoint({
    profile: { persisted: true }, updated_at: '2026-11-24', valid_until: '2026-11-24', timezone: 'America/New_York'
  });
  assert.equal(assessResume(day, { now: Date.parse('2026-11-25T04:59:59.999Z') }).status, 'confirm_current_state');
  assert.equal(assessResume(day, { now: Date.parse('2026-11-25T05:00:00.000Z') }).status, 'stale');
  assert.equal(assessResume(day, { now: Infinity }).status, 'invalid');
  const legacy = { schema_version: '1.0', valid_until: '2026-11-24' };
  legacy.checkpoint_id = createHash('sha256').update(JSON.stringify(legacy)).digest('hex');
  assert.equal(assessResume(legacy, { timezone: 'Unrecognized/Timezone' }).status, 'invalid');
  const dir = mkdtempSync(join(tmpdir(), 'fitness-checkpoint-edges-'));
  try {
    assert.throws(() => saveCheckpoint(dir, instant, { consent: true }), /consent/);
    assert.throws(() => saveCheckpoint(dir, { ...day, next_session: 'changed' }, { consent: true }), /Invalid checkpoint/);
    const saved = saveCheckpoint(dir, day, { consent: true });
    assert.equal(saveCheckpoint(dir, Object.fromEntries(Object.entries(day).reverse()), { consent: true }).current_pointer, saved.current_pointer);
    writeFileSync(saved.snapshot_path, '{}');
    assert.throws(() => saveCheckpoint(dir, day, { consent: true }), /Checkpoint conflict/);
    rmSync(saved.snapshot_path);
    rmSync(saved.current_pointer);
    mkdirSync(saved.current_pointer);
    assert.throws(() => saveCheckpoint(dir, day, { consent: true }));
    assert.ok(readdirSync(dir).every((filename) => !filename.endsWith('.tmp')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
