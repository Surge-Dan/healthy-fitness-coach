 'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildWorkflowDecision, classifyTrainingTask } = require('../references/training-orchestrator.js');
const { assessTodayReadiness } = require('../references/readiness-engine.js');
const { createCheckpoint, assessResume, saveCheckpoint } = require('../references/training-continuity.js');
const { createHash } = require('node:crypto');
test('phone without connector offers import without credentials or records prerequisite', () => {
  const result = buildWorkflowDecision({ instruction: '我想连接训记', capabilities: { mobile: true, can_write_files: false } });
  assert.equal(result.task_type, 'xunji_connect'); assert.equal(result.information_state, 'ready');
  assert.equal(result.connection.mode, 'manual_import'); assert.equal(result.connection.request_chat_key, false);
  assert.deepEqual(result.artifacts, []);
});
test('Xunji education, connection and writeback have different routes', () => {
  assert.equal(classifyTrainingTask({instruction:'生成训练接续摘要'}), 'training_handoff');
  assert.equal(classifyTrainingTask({instruction:'导入训练接续摘要'}), 'resume_training');
  assert.equal(classifyTrainingTask({instruction:'训记是什么？'}), 'knowledge_question');
  assert.equal(classifyTrainingTask({instruction:'连接训记'}), 'xunji_connect');
  assert.equal(classifyTrainingTask({instruction:'把今天记录写回训记'}), 'xunji_writeback');
  assert.equal(classifyTrainingTask({instruction:'分析训记最近4周'}), 'xunji_analysis');
});
test('entry and readiness agree on negative, historical and current symptoms', () => {
  const input = {instruction:'没有胸痛，没有晕厥，今天练什么？', currentState:{red_flags:'无'}};
  assert.equal(classifyTrainingTask(input), 'today_workout'); assert.equal(assessTodayReadiness(input).status, 'proceed');
  assert.equal(buildWorkflowDecision({instruction:'去年有胸痛，帮我制定训练计划'}).safety.status, 'clarify');
  assert.equal(classifyTrainingTask({instruction:'胸痛是什么？'}), 'knowledge_question');
  assert.equal(classifyTrainingTask({instruction:'没有胸痛，但现在呼吸困难'}), 'safety_routing');
});
test('mobile plan and dashboard requests deliver readable conversation, no fake files', () => {
  for (const instruction of ['帮我制定训练计划', '分析训记，生成趋势面板']) {
    const r = buildWorkflowDecision({instruction, capabilities:{mobile:true,can_write_files:false}});
    assert.equal(r.interaction_mode,'conversation'); assert.deepEqual(r.paths,[]);
  }
});
test('15 minute session selects minimum and asks only minimal feedback', () => {
  const r = assessTodayReadiness({currentState:{available_time_min:15}, program:{session_budget:{declared_minutes:45},minimum_version:'热身后完成两个主要动作'}});
  assert.equal(r.adjustment.variable,'session_scope'); assert.ok(r.minimum_task);
  assert.deepEqual(r.post_training_record_fields,['completed','rpe_or_rir','pain_or_aerobic_minutes']);
});
test('portable checkpoint excludes credential fields and distinguishes stale/conflicting imports', () => {
  const c=createCheckpoint({profile:{goal:'strength',api_key:'DO_NOT_COPY',persisted:true},program:{version:'v2',summary:'3 days'},updated_at:'2026-10-21',valid_until:'2026-11-21'});
  assert.equal(JSON.stringify(c).includes('DO_NOT_COPY'),false);
  assert.equal(assessResume(c,{now:Date.parse('2026-10-22')}).status,'confirm_current_state');
  assert.equal(assessResume(c,{now:Date.parse('2026-12-01')}).status,'stale');
  assert.equal(assessResume(c,{current_checkpoint_id:'other'}).status,'conflict');
  assert.equal(assessResume({...c,next_session:'tampered'}).status,'invalid');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fitness-checkpoint-'));
  try {
    assert.throws(()=>saveCheckpoint(dir,c),/consent/);
    const saved=saveCheckpoint(dir,c,{consent:true});
    assert.equal(JSON.parse(fs.readFileSync(saved.current_pointer)).checkpoint_id,c.checkpoint_id);
    const next=createCheckpoint({profile:{goal:'strength',persisted:true},program:{version:'v3'},updated_at:'2026-10-22',valid_until:'2026-11-22'});
    saveCheckpoint(dir,next,{consent:true}); assert.ok(fs.existsSync(saved.snapshot_path));
    assert.equal(JSON.parse(fs.readFileSync(saved.current_pointer)).checkpoint_id,next.checkpoint_id);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('only boolean true confirms the new session state', () => {
  const snapshot = createCheckpoint({ updated_at: '2026-11-24', valid_until: '2026-11-25' });
  const now = Date.parse('2026-11-24T12:00:00+08:00');
  for (const state_confirmed of [undefined, null, false, 'false', 'true', 1, {}, []]) {
    assert.equal(assessResume(snapshot, { now, state_confirmed }).status, 'confirm_current_state');
  }
  assert.equal(assessResume(snapshot, { now, state_confirmed: true }).status, 'ready');
});

test('canonical checkpoint survives reordering and expires at the end of its calendar day', () => {
  const snapshot = createCheckpoint({ updated_at: '2026-11-24', valid_until: '2026-11-24', timezone: 'Asia/Shanghai' });
  const reordered = Object.fromEntries(Object.entries(snapshot).reverse());
  const program = Object.fromEntries(Object.entries(snapshot.program).reverse());
  assert.equal(assessResume({ ...reordered, program }, { now: Date.parse('2026-11-24T23:59:59.999+08:00') }).status, 'confirm_current_state');
  assert.equal(assessResume(snapshot, { now: Date.parse('2026-11-25T00:00:00+08:00') }).status, 'stale');
  assert.equal(assessResume({ ...snapshot, next_session: 'changed' }).status, 'invalid');
});

test('old checkpoints still validate and exact timestamp expiry retains its original instant', () => {
  const legacy = { schema_version: '1.0', updated_at: '2026-11-24', valid_until: '2026-11-24T10:00:00-05:00', next_session: 'old plan' };
  legacy.checkpoint_id = createHash('sha256').update(JSON.stringify(legacy)).digest('hex');
  assert.equal(assessResume(legacy, { now: Date.parse('2026-11-24T15:00:00Z') }).status, 'confirm_current_state');
  assert.equal(assessResume(legacy, { now: Date.parse('2026-11-24T15:00:00.001Z') }).status, 'stale');
});

test('a matching checksum does not make an incomplete current-format checkpoint usable', () => {
  const data = { schema_version: '1.1', timezone: 'Asia/Shanghai', updated_at: '2026-11-24', valid_until: '2026-12-01' };
  const sorted = Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b)));
  const checkpoint_id = createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
  assert.equal(assessResume({ ...data, checkpoint_id }, {
    now: Date.parse('2026-11-25T00:00:00Z'), state_confirmed: true
  }).status, 'invalid');
});

test('explicit supported attachments still work on mobile; handoff has a copyable fallback', () => {
  const cases = [
    ['分析训记，生成趋势面板', 'training-dashboard.html'],
    ['请生成训练分享图', 'SHARE_CARD.png'],
    ['导出训练接续摘要', 'TRAINING_CHECKPOINT.json']
  ];
  for (const [instruction, filename] of cases) {
    const mobile = buildWorkflowDecision({ instruction, capabilities: { mobile: true, can_write_files: true } });
    assert.ok(mobile.artifacts.includes(filename), instruction);
    for (const can_write_files of [false, undefined]) {
      const portable = buildWorkflowDecision({ instruction, capabilities: { mobile: true, can_write_files } });
      assert.equal(portable.interaction_mode, 'conversation');
      assert.deepEqual(portable.artifacts, []);
      assert.deepEqual(buildWorkflowDecision({ instruction, capabilities: { mobile: false, can_write_files } }).artifacts, []);
    }
  }
  const desktop = buildWorkflowDecision({ instruction: '导出训练接续摘要', capabilities: { can_write_files: true } });
  assert.deepEqual(desktop.artifacts, ['TRAINING_CHECKPOINT.json', 'TRAINING_HANDOFF.md']);
  assert.deepEqual(buildWorkflowDecision({ instruction: '导出训练接续摘要' }).artifacts, []);
});
