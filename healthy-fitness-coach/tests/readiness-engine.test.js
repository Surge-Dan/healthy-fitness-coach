'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { assessTodayReadiness } = require('../references/readiness-engine.js');
const { normalizeCurrentState } = require('../references/athlete-state.js');
const { buildTodayReadinessGuidance } = require('../references/training-guidance.js');
const { buildWorkflowDecision } = require('../references/training-orchestrator.js');

const program = {
  status: 'ready',
  session_budget: { declared_minutes: 30 },
  session_slots: [{
    id: 'session_1',
    minimum_version: 'keep_first_two_movement_slots_with_one_to_2_work_sets_each'
  }]
};

test('stops without an executable training prescription when a current-state red flag is present', () => {
  const result = assessTodayReadiness({
    currentState: { red_flags: ['chest pain'] },
    program
  });

  assert.equal(result.status, 'stop');
  assert.ok(result.reason_codes.includes('red_flag'));
  assert.equal(result.minimum_task, null);
  assert.equal(Object.hasOwn(result, 'session'), false);
  assert.equal(Object.hasOwn(result, 'training_prescription'), false);
  assert.ok(result.stop_conditions.some((item) => item.code === 'seek_appropriate_assessment'));
});

test('stops when a red flag arrives through nested current-state safety data', () => {
  const result = assessTodayReadiness({
    currentState: { safety: { red_flags: ['chest pain'] } },
    program
  });

  assert.equal(result.status, 'stop');
  assert.ok(result.reason_codes.includes('red_flag'));
  assert.equal(result.minimum_task, null);
});

test('keeps nested red flags when current state is normalized before readiness assessment', () => {
  const currentState = normalizeCurrentState({ safety: { red_flags: ['chest pain'] } });
  const result = assessTodayReadiness({ currentState, program });

  assert.deepEqual(currentState.safety.red_flags, ['chest pain']);
  assert.equal(result.status, 'stop');
  assert.equal(result.minimum_task, null);
});

test('honors the camelCase redFlags alias in nested safety data', () => {
  const result = assessTodayReadiness({
    currentState: { safety: { redFlags: ['recent_surgery'] } },
    program
  });

  assert.equal(result.status, 'stop');
  assert.ok(result.reason_codes.includes('red_flag'));
});

test('stops for every natural-language red flag listed by safety screening', () => {
  for (const symptoms of ['接近晕厥', '大小便功能异常', '明显畸形', '无法负重', '严重肿胀']) {
    const result = assessTodayReadiness({ currentState: { symptoms }, program });

    assert.equal(result.status, 'stop', symptoms);
    assert.equal(result.minimum_task, null, symptoms);
  }
});

test('does not treat an explicitly negative chest-pain answer as a red flag', () => {
  const result = assessTodayReadiness({ currentState: { symptoms: '没有胸痛' }, program });

  assert.equal(result.status, 'proceed');
});

test('keeps top-level red flag aliases when current state is normalized before readiness assessment', () => {
  for (const field of ['red_flags', 'redFlags']) {
    const currentState = normalizeCurrentState({ [field]: ['chest pain'] });
    const result = assessTodayReadiness({ currentState, program });

    assert.deepEqual(currentState[field], ['chest pain']);
    assert.equal(result.status, 'stop');
  }
});

test('uses a conservative pain variant and asks for a 24 to 48 hour reassessment without diagnosing', () => {
  const result = assessTodayReadiness({
    currentState: { pain: 'shoulder discomfort' },
    program
  });

  assert.equal(result.status, 'regress');
  assert.ok(result.reason_codes.includes('pain_feedback'));
  assert.equal(result.adjustment.variable, 'movement_variant');
  assert.equal(result.minimum_task.source, 'program_minimum_version');
  assert.ok(result.stop_conditions.some((item) => item.code === 'reassess_pain_in_24_to_48_hours'));
  assert.equal(JSON.stringify(result).includes('diagnosis'), false);
});

test('treats nonzero or unqualified pain reports as conservative pain feedback', () => {
  for (const pain of [4, '肩部紧']) {
    const result = assessTodayReadiness({ currentState: { pain }, program });

    assert.equal(result.status, 'regress');
    assert.ok(result.reason_codes.includes('pain_feedback'));
    assert.equal(result.adjustment.variable, 'movement_variant');
  }
});

test('routes an ordinary symptoms report through the conservative pain branch', () => {
  const result = assessTodayReadiness({
    currentState: { symptoms: 'shoulder tightness' },
    program
  });

  assert.equal(result.status, 'regress');
  assert.ok(result.reason_codes.includes('pain_feedback'));
  assert.equal(result.adjustment.variable, 'movement_variant');
  assert.ok(result.stop_conditions.some((item) => item.code === 'reassess_pain_in_24_to_48_hours'));
});

test('routes an array of ordinary symptoms through the conservative pain branch', () => {
  const result = assessTodayReadiness({
    currentState: { symptoms: ['肩部紧', '膝盖酸'] },
    program
  });

  assert.equal(result.status, 'regress');
  assert.ok(result.reason_codes.includes('pain_feedback'));
  assert.equal(result.adjustment.variable, 'movement_variant');
  assert.ok(result.stop_conditions.some((item) => item.code === 'reassess_pain_in_24_to_48_hours'));
});

test('treats one poor sleep report as a temporary regression rather than overtraining', () => {
  const result = assessTodayReadiness({
    currentState: { sleep: 'poor' },
    program
  });

  assert.equal(result.status, 'regress');
  assert.ok(result.reason_codes.includes('single_night_poor_sleep'));
  assert.equal(result.adjustment.variable, 'intensity');
  assert.equal(JSON.stringify(result).toLowerCase().includes('overtraining'), false);
});

test('compresses a short session to the selected program minimum version', () => {
  const result = assessTodayReadiness({
    currentState: { available_time_min: 15 },
    program
  });

  assert.equal(result.status, 'regress');
  assert.ok(result.reason_codes.includes('time_constrained'));
  assert.equal(result.adjustment.variable, 'session_scope');
  assert.deepEqual(result.minimum_task, {
    source: 'program_minimum_version',
    session_id: 'session_1',
    instruction: 'keep_first_two_movement_slots_with_one_to_2_work_sets_each'
  });
});

test('gives time compression priority over fatigue while changing one primary variable', () => {
  const result = assessTodayReadiness({
    currentState: { fatigue: 'high', available_time_min: 15 },
    program
  });

  assert.equal(result.status, 'regress');
  assert.ok(result.reason_codes.includes('time_constrained'));
  assert.equal(result.adjustment.variable, 'session_scope');
  assert.equal(result.adjustment.primary_variables_changed, 1);
  assert.deepEqual(result.minimum_task, {
    source: 'program_minimum_version',
    session_id: 'session_1',
    instruction: 'keep_first_two_movement_slots_with_one_to_2_work_sets_each'
  });
});

test('gives time compression priority over one poor sleep report', () => {
  const result = assessTodayReadiness({
    currentState: { sleep: 'poor', available_time_min: 15 },
    program
  });

  assert.equal(result.status, 'regress');
  assert.ok(result.reason_codes.includes('time_constrained'));
  assert.equal(result.adjustment.variable, 'session_scope');
  assert.equal(result.adjustment.primary_variables_changed, 1);
  assert.ok(result.minimum_task);
});

test('keeps pain as the sole adjustment while marking a time minimum as plan baseline', () => {
  const result = assessTodayReadiness({
    currentState: { pain: 'shoulder discomfort', available_time_min: 15 },
    program
  });

  assert.equal(result.status, 'regress');
  assert.ok(result.reason_codes.includes('pain_feedback'));
  assert.equal(result.adjustment.variable, 'movement_variant');
  assert.equal(result.adjustment.primary_variables_changed, 1);
  assert.equal(result.minimum_task.instruction, 'keep_first_two_movement_slots_with_one_to_2_work_sets_each');
  assert.equal(result.minimum_task_semantics, 'plan_baseline_not_additional_adjustment');
});

test('normalizes numeric strings for time and sleep instead of proceeding silently', () => {
  const shortTime = assessTodayReadiness({
    currentState: { available_time_min: '15' },
    program
  });
  const poorSleep = assessTodayReadiness({
    currentState: { sleep: '5' },
    program
  });

  assert.equal(shortTime.status, 'regress');
  assert.ok(shortTime.reason_codes.includes('time_constrained'));
  assert.equal(poorSleep.status, 'regress');
  assert.ok(poorSleep.reason_codes.includes('single_night_poor_sleep'));
});

test('marks an invalid numeric time value unknown rather than treating it as normal', () => {
  const result = assessTodayReadiness({
    currentState: { available_time_min: 'fifteen' },
    program
  });

  assert.equal(result.status, 'regress');
  assert.ok(result.reason_codes.includes('current_state_unknown'));
  assert.equal(result.minimum_task, null);
  assert.equal(result.adjustment.variable, 'state_confirmation');
});

test('does not substitute another session minimum when an explicit session ID is unknown', () => {
  const result = assessTodayReadiness({
    currentState: { available_time_min: 15 },
    session_id: 'session_99',
    program: {
      ...program,
      session_slots: [
        ...program.session_slots,
        { id: 'session_2', minimum_version: 'keep_one_set_of_each_selected_movement' }
      ]
    }
  });

  assert.equal(result.status, 'regress');
  assert.ok(result.reason_codes.includes('session_not_found'));
  assert.equal(result.minimum_task, null);
  assert.equal(result.adjustment.variable, 'session_selection');
});

test('reduces exactly one primary variable for high fatigue without a red flag', () => {
  const result = assessTodayReadiness({
    currentState: { fatigue: 'high' },
    program
  });

  assert.equal(result.status, 'regress');
  assert.ok(result.reason_codes.includes('high_fatigue'));
  assert.equal(result.adjustment.variable, 'sets');
  assert.equal(result.adjustment.primary_variables_changed, 1);
});

test('proceeds with the current session when no readiness concern is reported', () => {
  const result = assessTodayReadiness({ currentState: {}, program });

  assert.equal(result.status, 'proceed');
  assert.ok(result.reason_codes.includes('current_state_clear'));
  assert.equal(result.adjustment.variable, 'none');
  assert.equal(result.minimum_task, null);
  assert.ok(result.post_training_record_fields.includes('completed'));
  assert.ok(result.post_training_record_fields.includes('rpe_or_rir'));
  assert.ok(result.post_training_record_fields.includes('pain_or_aerobic_minutes'));
});

test('returns the complete executable result contract for every readiness status', () => {
  const inputs = [
    { currentState: { red_flags: ['chest pain'] }, expected: 'stop' },
    { currentState: { pain: 'shoulder discomfort' }, expected: 'regress' },
    { currentState: {}, expected: 'proceed' }
  ];

  for (const { currentState, expected } of inputs) {
    const result = assessTodayReadiness({ currentState, program });

    assert.equal(result.status, expected);
    for (const field of ['facts', 'reason_codes', 'adjustment', 'minimum_task', 'stop_conditions', 'post_training_record_fields']) {
      assert.ok(Object.hasOwn(result, field), `${expected} result is missing ${field}`);
    }
    assert.ok(result.post_training_record_fields.includes('completed'));
    assert.ok(result.post_training_record_fields.includes('rpe_or_rir'));
  }
});

test('routes today guidance through the readiness engine with current state and current program', () => {
  const result = buildTodayReadinessGuidance({
    currentState: { available_time_min: 15 },
    currentProgram: program
  });

  assert.equal(result.status, 'regress');
  assert.ok(result.reason_codes.includes('time_constrained'));
  assert.equal(result.minimum_task.instruction, 'keep_first_two_movement_slots_with_one_to_2_work_sets_each');
});

test('today guidance adapts a top-level symptoms alias into the readiness current state', () => {
  const result = buildTodayReadinessGuidance({
    symptoms: 'shoulder tightness',
    current_program: program
  });

  assert.equal(result.status, 'regress');
  assert.ok(result.reason_codes.includes('pain_feedback'));
  assert.ok(result.stop_conditions.some((item) => item.code === 'reassess_pain_in_24_to_48_hours'));
});

test('documented current red flags override plan, report, handoff and share requests', () => {
  for (const symptoms of [
    '胸痛', '胸部压迫感', '明显气短', '呼吸困难', '晕厥', '接近晕厥', '原因不明的明显头晕',
    '异常心悸伴不适', '进行性麻木', '进行性无力', '大小便功能异常', '明显畸形', '无法负重',
    '严重肿胀', '疑似急性严重外伤', '症状快速恶化', '情况紧急', '近期手术', '妊娠', '产后'
  ]) {
    for (const request of ['帮我制定训练计划', '直接出报告', '导出训练接续摘要', '生成分享图']) {
      const input = { instruction: `今天我出现${symptoms}，${request}`, capabilities: { can_write_files: true, mobile: true } };
      const decision = buildWorkflowDecision(input);
      assert.equal(decision.safety.status, 'stop', input.instruction);
      assert.deepEqual(decision.artifacts, [], input.instruction);
      assert.equal(assessTodayReadiness(input).status, 'stop', input.instruction);
    }
  }
});

test('red-flag scope handles lists, contrast, history, uncertainty and structured answers', () => {
  const cases = [
    [{ instruction: '我没有胸痛或呼吸困难，今天练什么？' }, 'clear'],
    [{ currentState: { symptoms: '没有胸痛、异常气短或晕厥' } }, 'clear'],
    [{ currentState: { red_flags: { chest_pain: false, dizziness: false } } }, 'clear'],
    [{ currentState: { red_flags: { chest_pain: false, dyspnea: true } } }, 'stop'],
    [{ currentState: normalizeCurrentState({ red_flags: { chest_pain: false, dyspnea: true } }) }, 'stop'],
    [{ currentState: normalizeCurrentState({ safety: { symptoms: '明显气短' } }) }, 'stop'],
    [{ currentState: normalizeCurrentState({ red_flags: [{ code: 'chest_pain', present: false }] }) }, 'clear'],
    [{ instruction: '没有胸痛、异常气短，但现在感觉要晕倒' }, 'stop'],
    [{ instruction: '没有胸痛，呼吸困难持续加重' }, 'stop'],
    [{ instruction: '没有胸痛，明显气短了' }, 'stop'],
    [{ instruction: '没有胸痛，呼吸困难' }, 'clarify'],
    [{ instruction: '我现在突然喘不过气，今天练什么？' }, 'stop'],
    [{ profile: { red_flags: ['chest_pain'] } }, 'stop'],
    [{ current_state: { safety: { red_flags: false, redFlags: ['chest_pain'] } } }, 'stop'],
    [{ instruction: '并非没有胸痛' }, 'stop'],
    [{ instruction: 'I have no chest pain, dizziness, or shortness of breath.' }, 'clear'],
    [{ instruction: '去年有胸痛，今天练什么？' }, 'clarify'],
    [{ instruction: '去年有胸痛，今天又出现明显气短' }, 'stop'],
    [{ instruction: '我不确定是不是呼吸困难，帮我生成分享卡' }, 'clarify'],
    [{ instruction: '我现在可能有胸痛，还有明显气短' }, 'stop'],
    [{ instruction: '什么是明显气短？' }, 'clear'],
    [{ instruction: '什么是胸痛？我胸口现在很痛' }, 'stop'],
    [{ instruction: 'I have no chest pain or shortness of breath.' }, 'clear'],
    [{ instruction: 'I had chest pain last year, can I train today?' }, 'clarify'],
    [{ instruction: 'I have chest pain now similar to last year.' }, 'stop'],
    [{ currentState: { safety: { symptoms: { description: '今天胸部压迫感' } } } }, 'stop']
  ];
  for (const [input, expected] of cases) {
    assert.equal(buildWorkflowDecision(input).safety.status, expected, JSON.stringify(input));
    assert.equal(assessTodayReadiness(input).status, expected === 'clear' ? 'proceed' : 'stop', JSON.stringify(input));
  }
});

test('insufficient time removes executable tasks even with fatigue, discomfort or no plan', () => {
  const timedProgram = { ...program, session_slots: [{ ...program.session_slots[0], minimum_minutes: 12 }] };
  for (const [available_time_min, currentState, currentProgram] of [
    [0, { fatigue: 'high' }, timedProgram],
    [5, { pain: 'shoulder discomfort' }, timedProgram],
    [0, {}, {}],
    [5, {}, program],
    [11, {}, timedProgram]
  ]) {
    const result = assessTodayReadiness({ currentState: { ...currentState, available_time_min }, program: currentProgram });
    assert.equal(result.status, 'defer');
    assert.equal(result.minimum_task, null);
    assert.equal(result.adjustment.direction, 'reschedule_or_select_feasible_session');
  }
  for (const available_time_min of [12, 20]) {
    const result = assessTodayReadiness({ currentState: { available_time_min }, program: timedProgram });
    assert.equal(result.status, 'regress');
    assert.ok(result.minimum_task);
  }
});
