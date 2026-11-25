'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const {
  buildWorkflowDecision,
  classifyTrainingTask,
  evaluateInformationState,
  requiredFieldsForTask
} = require('../references/training-orchestrator.js');

const REQUIRED_DECISION_FIELDS = [
  'task_type',
  'interaction_mode',
  'required_fields',
  'missing_fields',
  'information_state',
  'artifact_mode',
  'artifacts',
  'index',
  'paths',
  'reason_codes'
];

const COMPLETE_PROFILE = {
  goal: 'build strength',
  experience_level: 'intermediate',
  training_days_per_week: 3,
  available_equipment: ['barbell', 'bench'],
  injury_or_medical_constraints: 'none'
};

test('routes each supported training task to an auditable decision', () => {
  const cases = [
    ['knowledge_question', { instruction: 'What is progressive overload?' }, 'conversation', 'none'],
    ['safety_routing', { instruction: 'I have chest pain during a set.' }, 'conversation', 'none'],
    ['training_plan', { taskType: 'training_plan', profile: COMPLETE_PROFILE }, 'markdown', 'multi_asset_bundle'],
    ['today_workout', { taskType: 'today_workout', profile: {} }, 'conversation', 'none'],
    ['training_review', { taskType: 'training_review', records: [{ date: '2026-08-30' }] }, 'markdown', 'multi_asset_bundle'],
    ['training_system', { taskType: 'training_system', profile: COMPLETE_PROFILE }, 'markdown', 'multi_asset_bundle'],
    ['xunji_analysis', { taskType: 'xunji_analysis', records: [{ date: '2026-08-30' }] }, 'markdown', 'single_markdown'],
    ['share_output', { taskType: 'share_output', currentState: { source_assets: ['progress.jpg'] } }, 'conversation', 'multi_asset_bundle']
  ];

  for (const [expectedTask, input, expectedInteraction, expectedArtifactMode] of cases) {
    const decision = buildWorkflowDecision(input);
    assert.equal(decision.task_type, expectedTask);
    assert.equal(decision.interaction_mode, expectedInteraction);
    assert.equal(decision.artifact_mode, expectedArtifactMode);
    for (const field of REQUIRED_DECISION_FIELDS) assert.ok(Object.hasOwn(decision, field), `${expectedTask} includes ${field}`);
    assert.ok(Array.isArray(decision.required_fields));
    assert.ok(Array.isArray(decision.missing_fields));
    assert.ok(Array.isArray(decision.artifacts));
    assert.ok(Array.isArray(decision.reason_codes));
  }
});

test('classifies red flags before explicit commands or requested training work', () => {
  assert.equal(classifyTrainingTask({
    taskType: 'training_plan',
    instruction: '直接出报告；我深蹲时胸痛和呼吸困难',
    currentState: { red_flags: ['chest_pain'] }
  }), 'safety_routing');
});

test('classifies an instruction to establish training DNA as a training system, not a Xunji analysis', () => {
  assert.equal(classifyTrainingTask({ instruction: '帮我建立训练DNA和长期训练体系' }), 'training_system');
});

test('red flags suppress report, share and plan artifacts in final workflow decisions', () => {
  for (const input of [
    { taskType: 'training_plan', instruction: '直接出报告，我胸痛', currentState: { red_flags: ['chest_pain'] } },
    { taskType: 'share_output', instruction: '做分享图，我呼吸困难', currentState: { red_flags: ['shortness_of_breath'] } },
    { taskType: 'training_plan', instruction: '给我训练计划，我晕厥过', currentState: { red_flags: ['fainting'] } }
  ]) {
    const decision = buildWorkflowDecision(input);
    assert.equal(decision.task_type, 'safety_routing');
    assert.equal(decision.interaction_mode, 'conversation');
    assert.equal(decision.artifact_mode, 'none');
    assert.deepEqual(decision.artifacts, []);
  }
});

test('nested safety red flags override plan, explicit report and share routes', () => {
  const cases = [
    { taskType: 'training_plan', safety: { red_flags: ['chest_pain'] } },
    { taskType: 'today_workout', instruction: '直接出报告', currentState: { safety: { red_flags: ['recent_surgery'] } } },
    { taskType: 'share_output', currentState: { safety: { red_flags: ['acute_injury'] } } }
  ];

  for (const input of cases) {
    const decision = buildWorkflowDecision(input);
    assert.equal(decision.task_type, 'safety_routing');
    assert.equal(decision.interaction_mode, 'conversation');
    assert.equal(decision.artifact_mode, 'none');
    assert.deepEqual(decision.artifacts, []);
  }
});

test('ignores empty red-flag entries instead of creating a false safety route', () => {
  assert.equal(classifyTrainingTask({
    taskType: 'training_plan',
    currentState: { red_flags: [false, ''] }
  }), 'training_plan');
});

test('does not create profile questions or file artifacts for a simple knowledge question', () => {
  const decision = buildWorkflowDecision({ instruction: 'How much protein should I eat after training?' });
  assert.deepEqual(decision.required_fields, []);
  assert.deepEqual(decision.missing_fields, []);
  assert.equal(decision.information_state, 'ready');
  assert.deepEqual(decision.artifacts, []);
});

test('classifies explicit hypertrophy, multi-week and next-week requests as plans without misclassifying a knowledge question', () => {
  for (const instruction of ['给我制定一个增肌计划', '帮我做 8 周力量方案', '安排下周训练']) {
    assert.equal(classifyTrainingTask({ instruction }), 'training_plan');
  }
  assert.equal(classifyTrainingTask({ instruction: '增肌训练有哪些基本原则？' }), 'knowledge_question');
});

test('keeps explanatory training-plan questions as knowledge while honoring a direct plan request', () => {
  for (const instruction of ['训练计划怎么制定？', '训练计划包含哪些内容？']) {
    const decision = buildWorkflowDecision({ instruction });
    assert.equal(decision.task_type, 'knowledge_question');
    assert.deepEqual(decision.required_fields, []);
    assert.deepEqual(decision.missing_fields, []);
    assert.equal(decision.artifact_mode, 'none');
    assert.deepEqual(decision.artifacts, []);
  }
  assert.equal(classifyTrainingTask({ instruction: '给我制定训练计划' }), 'training_plan');
});

test('uses existing complete plan fields without repeating questions', () => {
  const decision = buildWorkflowDecision({ taskType: 'training_plan', profile: COMPLETE_PROFILE });
  assert.deepEqual(decision.missing_fields, []);
  assert.equal(decision.information_state, 'ready');
});

test('asks only structural or safety-changing gaps and otherwise permits execution assumptions', () => {
  const plan = buildWorkflowDecision({
    taskType: 'training_plan',
    profile: { goal: 'build strength', experience_level: 'beginner' }
  });
  assert.deepEqual(plan.missing_fields, ['training_days_per_week', 'available_equipment', 'injury_or_medical_constraints']);
  assert.equal(plan.information_state, 'ask');

  const workout = buildWorkflowDecision({ taskType: 'today_workout', profile: {} });
  assert.deepEqual(workout.missing_fields, []);
  assert.equal(workout.information_state, 'assume');
  assert.ok(workout.reason_codes.includes('safe_execution_assumption'));
});

test('reuses output-routing explicit commands unless safety has already won', () => {
  const decision = buildWorkflowDecision({
    taskType: 'today_workout',
    instruction: '直接出报告'
  });
  assert.equal(decision.interaction_mode, 'markdown');
  assert.ok(decision.reason_codes.includes('explicit_command'));
});

test('uses the output asset plan when today workout is explicitly saved', () => {
  const outputDirectory = join(mkdtempSync(join(tmpdir(), 'healthy-fitness-today-workout-')), 'fitness-reports');
  mkdirSync(outputDirectory);

  const decision = buildWorkflowDecision({
    taskType: 'today_workout',
    instruction: '保存刚才内容',
    outputDirectory
  });

  assert.equal(decision.interaction_mode, 'markdown');
  assert.equal(decision.artifact_mode, 'single_markdown');
  assert.deepEqual(decision.artifacts, ['TODAY_WORKOUT.md']);
  assert.equal(decision.index, null);
  assert.deepEqual(decision.paths, [join(outputDirectory, 'TODAY_WORKOUT.md')]);
  rmSync(join(outputDirectory, '..'), { recursive: true, force: true });
});

test('places plan, review, and share indexes first with predictable conflict suffixes', () => {
  const root = mkdtempSync(join(tmpdir(), 'healthy-fitness-orchestrator-indexes-'));
  const outputDirectory = join(root, 'fitness-reports');
  mkdirSync(outputDirectory);
  const cases = [
    ['training_plan', 'TRAINING_PLAN_INDEX.md', { profile: COMPLETE_PROFILE }],
    ['training_review', 'TRAINING_REVIEW_INDEX.md', { records: [{ date: '2026-08-30' }] }],
    ['share_output', 'SHARE_OUTPUT_INDEX.md', { currentState: { source_assets: ['progress.jpg'] } }]
  ];

  for (const [taskType, index, input] of cases) {
    writeFileSync(join(outputDirectory, index), 'existing');
    const decision = buildWorkflowDecision({ taskType, outputDirectory, ...input });
    assert.equal(decision.index, index, taskType);
    assert.equal(decision.paths[0], join(outputDirectory, index.replace('.md', '-2.md')), taskType);
    assert.equal(decision.paths.length, decision.artifacts.length + 1, taskType);
  }

  rmSync(root, { recursive: true, force: true });
});

test('uses the Xunji planner defaults and adds dashboard assets only on an explicit command', () => {
  const outputDirectory = join(mkdtempSync(join(tmpdir(), 'healthy-fitness-xunji-')), 'fitness-reports');
  mkdirSync(outputDirectory);
  const records = [{ date: '2026-08-30' }];

  const defaultDecision = buildWorkflowDecision({ taskType: 'xunji_analysis', records, outputDirectory });
  assert.equal(defaultDecision.interaction_mode, 'markdown');
  assert.deepEqual(defaultDecision.artifacts, ['TRAINING_ANALYSIS.md']);
  assert.equal(defaultDecision.index, null);
  assert.deepEqual(defaultDecision.paths, [join(outputDirectory, 'TRAINING_ANALYSIS.md')]);

  const dashboardDecision = buildWorkflowDecision({
    taskType: 'xunji_analysis',
    instruction: '生成趋势面板',
    records,
    outputDirectory
  });
  assert.equal(dashboardDecision.interaction_mode, 'dashboard');
  assert.deepEqual(dashboardDecision.artifacts, ['TRAINING_ANALYSIS.md', 'training-dashboard.html']);
  assert.equal(dashboardDecision.index, 'XUNJI_ANALYSIS_INDEX.md');
  assert.equal(dashboardDecision.paths[0], join(outputDirectory, 'XUNJI_ANALYSIS_INDEX.md'));

  rmSync(join(outputDirectory, '..'), { recursive: true, force: true });
});

test('derives artifact mode from the final plan, review, and default Xunji asset shapes', () => {
  const plan = buildWorkflowDecision({ taskType: 'training_plan', profile: COMPLETE_PROFILE });
  assert.deepEqual(plan.artifacts, ['ATHLETE_PROFILE.md', 'CURRENT_PROGRAM.md']);
  assert.equal(plan.index, 'TRAINING_PLAN_INDEX.md');
  assert.equal(plan.artifact_mode, 'multi_asset_bundle');

  const review = buildWorkflowDecision({
    taskType: 'training_review',
    records: [{ date: '2026-08-30' }]
  });
  assert.deepEqual(review.artifacts, ['WEEKLY_REVIEW.md', 'DECISION_LOG.md']);
  assert.equal(review.index, 'TRAINING_REVIEW_INDEX.md');
  assert.equal(review.artifact_mode, 'multi_asset_bundle');

  const xunji = buildWorkflowDecision({
    taskType: 'xunji_analysis',
    records: [{ date: '2026-08-30' }]
  });
  assert.deepEqual(xunji.artifacts, ['TRAINING_ANALYSIS.md']);
  assert.equal(xunji.index, null);
  assert.equal(xunji.artifact_mode, 'single_markdown');
});

test('marks dashboard deliveries as dashboard artifacts for every planned task', () => {
  const cases = [
    ['training_plan', { profile: COMPLETE_PROFILE }],
    ['training_review', { records: [{ date: '2026-08-30' }] }],
    ['training_system', { profile: COMPLETE_PROFILE }],
    ['xunji_analysis', { records: [{ date: '2026-08-30' }] }],
    ['share_output', { currentState: { source_assets: ['progress.jpg'] } }]
  ];

  for (const [taskType, input] of cases) {
    const decision = buildWorkflowDecision({ taskType, instruction: '生成趋势面板', ...input });
    assert.equal(decision.interaction_mode, 'dashboard', taskType);
    assert.equal(decision.artifact_mode, 'dashboard', taskType);
  }
});

test('exposes stable field requirements and information-state evaluation', () => {
  assert.deepEqual(requiredFieldsForTask('training_review'), ['records']);
  assert.equal(evaluateInformationState({ taskType: 'training_review', records: [] }).state, 'ask');
  assert.equal(evaluateInformationState({ taskType: 'today_workout', profile: {} }).state, 'assume');
});

test('negated, quoted, and capability questions cannot authorize a side-effect route', () => {
  const cases = [
    ['不要写回训记，只分析这份训练导出', 'xunji_analysis', 'xunji_writeback'],
    ['不连接训记，直接帮我制定训练计划', 'training_plan', 'xunji_connect'],
    ['同事说“写回训记”，请帮我复盘', 'training_review', 'xunji_writeback'],
    ['怎么连接训记？', 'knowledge_question', 'xunji_connect'],
    ['可以把记录写回训记吗？', 'knowledge_question', 'xunji_writeback'],
    ['训记写回功能介绍', 'knowledge_question', 'xunji_writeback'],
    ['用户问：写回训记', 'knowledge_question', 'xunji_writeback'],
    ['请问能帮我把记录写回训记吗？', 'xunji_writeback', 'xunji_writeback'],
    ['不要连接训记，只分析导出', 'xunji_analysis', 'xunji_connect']
  ];
  for (const [instruction, task, explicit] of cases) {
    assert.equal(classifyTrainingTask({ instruction }), task, instruction);
    assert.equal(classifyTrainingTask({ instruction, taskType: explicit }), task, instruction);
  }
  const write = buildWorkflowDecision({ instruction: '先别写回训记，但现在请把已核对的记录写回训记', records: [{}] });
  assert.equal(write.task_type, 'xunji_writeback');
  assert.equal(write.writeback.next, 'preview_then_request_explicit_confirmation');
});

test('Xunji analysis distinguishes exact read, import, credential setup, empty reads and failures', () => {
  const instruction = '分析训记最近 4 周';
  const date = '2026-11-24';
  const configured = { xunji_connector: true, credentials_ready: true };
  const input = { instruction, reference_date: date, capabilities: configured };
  const decision = buildWorkflowDecision(input);
  assert.equal(decision.information_state, 'ready');
  assert.deepEqual(decision.missing_fields, []);
  assert.deepEqual(decision.data_source, { status: 'read_pending', action: 'read_range', start_date: '2026-10-28', end_date: date });
  assert.deepEqual(buildWorkflowDecision({ instruction, now: Date.parse('2026-11-23T16:30:00Z'), capabilities: configured }).data_source, decision.data_source);
  assert.equal(buildWorkflowDecision({ ...input, instruction: '分析训记' }).data_source.status, 'date_range_needed');
  for (const [instruction, status] of [
    ['分析训记 2026-11-24', 'read_pending'],
    ['分析训记 2026-11-01 到 2026-11-24', 'read_pending'],
    ['分析训记 2026-11-31', 'date_range_needed'],
    ['分析训记 2026-11-24 到 2026-11-01', 'date_range_needed'],
    ['分析训记 2019-01-01 到 2026-11-24', 'date_range_needed'],
    ['分析今天训记', 'read_pending'],
    ['分析训记最近 0 天', 'date_range_needed']
  ]) {
    assert.equal(buildWorkflowDecision({ ...input, instruction }).data_source.status, status, instruction);
  }
  assert.equal(buildWorkflowDecision({ ...input, start_date: '2026-11-01', end_date: date }).data_source.status, 'read_pending');
  assert.equal(buildWorkflowDecision({ ...input, start_date: date }).data_source.status, 'date_range_needed');
  assert.equal(buildWorkflowDecision({ instruction }).data_source.status, 'import_needed');
  assert.equal(buildWorkflowDecision({ ...input, capabilities: { ...configured, credentials_ready: false, protected_credential_input: true } }).data_source.status, 'configure_credentials');
  assert.equal(buildWorkflowDecision({ ...input, records: [{ date }] }).data_source.status, 'imported');
  assert.equal(buildWorkflowDecision({ ...input, instruction: '不连接训记，只分析导出' }).data_source.status, 'import_needed');
  assert.equal(buildWorkflowDecision({
    ...input, instruction: '不要从训记读取 2025-11-24，只分析我发的训练记录'
  }).data_source.status, 'import_needed');
  assert.equal(buildWorkflowDecision({ ...input, connector_result: { records: [], missing_dates: [] } }).data_source.status, 'empty');
  assert.equal(buildWorkflowDecision({ ...input, connector_result: { records: [], missing_dates: [date] } }).data_source.status, 'read_failed');
  assert.equal(buildWorkflowDecision({ ...input, connector_result: { days: [{}], records: [], missing_dates: [date] } }).data_source.status, 'partial');
  assert.equal(buildWorkflowDecision({ ...input, connector_result: { records: [{}], missing_dates: [date] } }).data_source.status, 'partial');
  assert.equal(buildWorkflowDecision({ ...input, connector_result: { error: 'network' } }).data_source.status, 'read_failed');
  assert.equal(buildWorkflowDecision({ ...input, capabilities: { ...configured, protected_credential_input: true }, connector_result: { error: { code: 'invalid_credentials' } } }).data_source.status, 'configure_credentials');
});
