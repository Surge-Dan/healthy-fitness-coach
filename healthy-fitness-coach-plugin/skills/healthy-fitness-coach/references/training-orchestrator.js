'use strict';

const { inspectSafety } = require('./safety-context.js');
const { connectionDecision } = require('./connection-capabilities.js');
const { planOutputAssets } = require('./output-routing.js');

const SUPPORTED_TASKS = new Set([
  'knowledge_question',
  'safety_routing',
  'training_plan',
  'today_workout',
  'training_review',
  'training_system',
  'xunji_connect',
  'xunji_writeback',
  'resume_training',
  'training_handoff',
  'xunji_analysis',
  'share_output'
]);

const REQUIRED_FIELDS = {
  knowledge_question: [],
  safety_routing: [],
  training_plan: ['goal', 'experience_level', 'training_days_per_week', 'available_equipment', 'injury_or_medical_constraints'],
  today_workout: [],
  training_review: ['records'],
  training_system: ['goal', 'experience_level', 'training_days_per_week', 'available_equipment', 'injury_or_medical_constraints'],
  xunji_connect: [],
  xunji_writeback: ['records'],
  resume_training: ['source_assets'],
  training_handoff: [],
  xunji_analysis: ['records'],
  share_output: ['source_assets']
};

const INSTRUCTION_TASKS = [
  ['share_output', /(?:分享图|分享卡|海报|晒训练|share\s*(?:card|image|output)?)/iu],
  ['training_system', /(?:训练系统|建立.*训练dna|建立.*训练体系|长期训练)/iu],
  ['xunji_analysis', /(?:训记|xunji|训练数据分析|分析.{0,14}(?:训练)?(?:导出|记录|数据))/iu],
  ['training_review', /(?:复盘|训练回顾|review)/iu],
  ['today_workout', /(?:今天.*(?:练|训练)|今日.*(?:练|训练)|today.*workout)/iu],
  ['training_plan', /(?:训练计划|计划.*训练|(?:给我|帮我|为我|请).{0,6}(?:制定|做|设计|生成|安排).{0,20}(?:计划|方案|训练)|(?:制定|做|设计|生成).{0,20}(?:计划|方案)|(?:安排|规划|排).{0,12}(?:下周|下星期|下个星期|未来).{0,12}(?:训练|锻炼)|program(?:me)?\b)/iu]
];

const EXPLANATORY_PLAN_QUESTION_PATTERN = /(?:(?:训练计划|计划|方案).{0,12}(?:怎么制定|如何制定|包含哪些(?:内容)?|哪些内容|是什么|有哪些原则)|(?:怎么制定|如何制定|包含哪些(?:内容)?|哪些内容|是什么|有哪些原则).{0,12}(?:训练计划|计划|方案))/iu;
const DIRECT_PLAN_REQUEST_PATTERN = /(?:给我|帮我|为我|请).{0,6}(?:制定|做|设计|生成|安排)/iu;
const SIDE_EFFECT_TASKS = {
  xunji_connect: /连接|绑定|授权|连不上|(?<!不)连训记|\bconnect(?:ion)?\b/iu,
  xunji_writeback: /写回|同步|上传|保存至|保存到|\b(?:write\s*back|upload|sync)\b/iu
};
const XUNJI_NAME = /训记|\bxunji\b/iu;
const NEGATED_ACTION = /不要|不想|不打算|不需要|不必|不用|不(?:要)?(?:连|写|同步|绑定|上传|保存)|(?:先|请)?别|暂不|禁止|仅|只(?:做|看|读|查|分析)|\b(?:do not|don't|never|without|only|avoid|no need to|not)\b/iu;
const ACTION_EXPLANATION = /怎么|如何|是否|是什么|什么叫|教程|示例|功能介绍|介绍.{0,10}功能|\b(?:how|what|why|whether)\b/iu;
const QUESTION = /[?？]|能否|能不能|可以.{0,20}吗|\b(?:can|could)\b/iu;
const DIRECT_ASSISTANCE = /(?:帮我|替我|为我)(?:把|将)|\b(?:can|could) you (?:please )?(?:write|upload|sync)\b/iu;
const REPORTED_ACTION = /(?:说|写道|提到|写着|跟我说|用户问|对方问|建议|指令|转述|举例|如果|假如|与其|想了解|不确定)(?:\s*[:：])?|\b(?:said|says|reported|wrote|quoted|if|for example)\b/iu;
const DENIED_READ = /(?:不要|别|禁止|不必|不用|不从).{0,10}(?:训记|xunji).{0,12}(?:读|拉取|查|取数)|(?:不要|别|禁止|不必|不用).{0,10}(?:读|拉取|查|取数).{0,12}(?:训记|xunji)|\b(?:do not|don't|never)\s+(?:read|fetch|query|pull)\b[^,.;]{0,24}\bxunji\b/iu;
const DATE_TEXT = /\d{4}-\d{2}-\d{2}/gu;
const DAY_MS = 86_400_000;
const MAX_XUNJI_DAYS = 366 * 5;
const XUNJI_CALENDAR = new Intl.DateTimeFormat('en', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
});

function sideEffectIntent(instruction, requestedTask = null) {
  const unquoted = instruction.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"|\x60[^\x60]*\x60/gu, '');
  const clauses = unquoted.split(/[,，;；。！!\r\n]+|(?<=[?？])|但(?:是)?|不过|然后|接着|而是|(?=(?:只|仅|直接)(?:帮我|给我|制定|分析|做|先))|\b(?:but|however|then)\b/iu);
  const intents = {};
  const unhandled = [];
  for (const clause of clauses) {
    const namePresent = XUNJI_NAME.test(clause);
    const matches = Object.entries(SIDE_EFFECT_TASKS).filter(([task, pattern]) => {
      if (!pattern.test(clause)) return false;
      return namePresent || requestedTask === task || NEGATED_ACTION.test(clause);
    });
    if (!matches.length) {
      unhandled.push(clause);
      continue;
    }
    for (const [task, pattern] of matches) {
      const actionIndex = clause.search(pattern);
      const prefix = clause.slice(0, actionIndex);
      const negated = NEGATED_ACTION.test(prefix) || /不\s*$/u.test(prefix) || /不能|连不上/u.test(clause);
      if (negated) intents[task] = 'denied';
      else if (ACTION_EXPLANATION.test(clause) || REPORTED_ACTION.test(prefix)
        || (QUESTION.test(clause) && !DIRECT_ASSISTANCE.test(clause))) intents[task] = 'discussed';
      else intents[task] = 'requested';
    }
  }
  return { intents, remaining: unhandled.join('，') };
}

function normalizeTaskType(value) {
  const taskType = String(value || '').trim().toLowerCase();
  return SUPPORTED_TASKS.has(taskType) ? taskType : null;
}

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function hasRedFlag(input = {}) { return inspectSafety(input).status !== 'clear'; }

function classifyTrainingTask(input = {}) {
  if (hasRedFlag(input)) return 'safety_routing';

  const explicitTask = normalizeTaskType(input.taskType || input.task_type);
  const instruction = String(input.instruction || input.userInstruction || '');
  const { intents, remaining } = sideEffectIntent(instruction, explicitTask);
  if (explicitTask && (!Object.hasOwn(SIDE_EFFECT_TASKS, explicitTask)
    || !instruction.trim() || intents[explicitTask] === 'requested')) return explicitTask;
  if (intents.xunji_writeback === 'requested') return 'xunji_writeback';
  if (intents.xunji_connect === 'requested') return 'xunji_connect';
  if (/^(?:训记|xunji)(?:是什么|是什么软件|怎么用)[？?。\s]*$/iu.test(instruction)) return 'knowledge_question';
  if (/(?:生成|导出|保存).{0,12}(?:训练接续摘要|训练摘要)/iu.test(remaining)) return 'training_handoff';
  if (/(?:恢复|继续|导入).{0,12}(?:训练(?:接续)?摘要|接续摘要)|换(?:手机|设备)|新聊天继续/iu.test(remaining)) return 'resume_training';
  if (EXPLANATORY_PLAN_QUESTION_PATTERN.test(remaining) && !DIRECT_PLAN_REQUEST_PATTERN.test(remaining)) {
    return 'knowledge_question';
  }
  for (const [taskType, pattern] of INSTRUCTION_TASKS) {
    if (pattern.test(remaining)) return taskType;
  }
  return 'knowledge_question';
}

function validDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(date)
    && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
}

function xunjiReferenceDate(input) {
  if (input.reference_date !== undefined) return input.reference_date;
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now)) return null;
  const parts = Object.fromEntries(XUNJI_CALENDAR.formatToParts(now).map(({ type, value }) => [type, value]));
  return [parts.year.padStart(4, '0'), parts.month, parts.day].join('-');
}

function analysisDateRange(input, instruction) {
  if (input.start_date !== undefined || input.end_date !== undefined) {
    const { start_date, end_date } = input;
    return boundedDateRange(start_date, end_date);
  }
  const dates = [...instruction.matchAll(DATE_TEXT)].map(([date]) => date);
  if (dates.length === 1 && validDate(dates[0])) return { start_date: dates[0], end_date: dates[0] };
  if (dates.length === 2) return boundedDateRange(...dates);
  if (dates.length) return null;
  const referenceDate = xunjiReferenceDate(input);
  if (!validDate(referenceDate)) return null;
  const relative = /(?:最近|过去|last|past)\s*(\d+)\s*(周|星期|天|weeks?\b|days?\b)/iu.exec(instruction);
  const days = relative ? Number(relative[1]) * (/周|星期|week/iu.test(relative[2]) ? 7 : 1)
    : /今天|\btoday\b/iu.test(instruction) ? 1 : 0;
  if (days > MAX_XUNJI_DAYS) return null;
  const start = new Date(Date.parse(referenceDate) - (days - 1) * DAY_MS);
  if (!days || !Number.isFinite(start.getTime())) return null;
  const start_date = start.toISOString().slice(0, 10);
  return validDate(start_date) ? { start_date, end_date: referenceDate } : null;
}

function boundedDateRange(start_date, end_date) {
  if (!validDate(start_date) || !validDate(end_date) || start_date > end_date
    || Date.parse(end_date) - Date.parse(start_date) >= MAX_XUNJI_DAYS * DAY_MS) return null;
  return { start_date, end_date };
}

function connectForRequest(input) {
  const connection = connectionDecision(input.capabilities);
  if (connection.mode !== 'connector') return connection;
  const range = analysisDateRange(input, String(input.instruction || input.userInstruction || ''));
  if (range && range.start_date === range.end_date) return { ...connection, date: range.start_date };
  return { ...connection, next: 'ask_for_verification_date' };
}

function analysisSource(input) {
  if (hasValue(input.records)) return { status: 'imported', action: 'analyze_records' };
  const instruction = String(input.instruction || input.userInstruction || '');
  const { intents } = sideEffectIntent(instruction);
  const importOnly = intents.xunji_connect === 'denied' || DENIED_READ.test(instruction)
    || /(?:只|仅|直接)分析.{0,12}(?:导出|这份文件|附件)|\bonly analy[sz]e\b/iu.test(instruction);
  const connection = connectionDecision(input.capabilities);
  if (importOnly || connection.mode === 'manual_import') {
    return { status: 'import_needed', action: 'offer_manual_import' };
  }
  if (connection.mode === 'configure') {
    return { status: 'configure_credentials', action: connection.next };
  }
  if (input.connector_result !== undefined) {
    const result = input.connector_result;
    if (['missing_credentials', 'invalid_credentials'].includes(result?.error?.code) && input.capabilities?.protected_credential_input === true) {
      return { status: 'configure_credentials', action: 'open_protected_credential_input' };
    }
    const missing_dates = result?.missing_dates ?? [];
    if (!Array.isArray(result?.records) || result.error || !Array.isArray(missing_dates)) {
      return { status: 'read_failed', action: 'offer_retry_or_import' };
    }
    if (missing_dates.length || result.partial === true) {
      const incomplete = result.records.length > 0 || (Array.isArray(result.days) && result.days.length > 0);
      return {
        status: incomplete ? 'partial' : 'read_failed',
        action: incomplete
          ? (result.records.length ? 'analyze_with_missing_dates' : 'report_partial_coverage')
          : 'offer_retry_or_import',
        missing_dates
      };
    }
    return result.records.length
      ? { status: 'read_complete', action: 'analyze_records' }
      : { status: 'empty', action: 'report_no_records' };
  }
  const range = analysisDateRange(input, instruction);
  if (!range) return { status: 'date_range_needed', action: 'ask_for_date_range' };
  return { status: 'read_pending', action: 'read_range', ...range };
}

function requiredFieldsForTask(taskType) {
  const normalized = normalizeTaskType(taskType) || 'knowledge_question';
  return [...REQUIRED_FIELDS[normalized]];
}

function valueForField(field, { profile = {}, currentState = {}, records, source_assets, sourceAssets } = {}) {
  if (field === 'records') return records;
  if (field === 'source_assets') return source_assets || sourceAssets || currentState.source_assets || currentState.sourceAssets;
  return currentState[field] !== undefined ? currentState[field] : profile[field];
}

function evaluateInformationState(input = {}) {
  const { taskType, profile = {}, currentState = {}, records, source_assets, sourceAssets } = input;
  const normalized = normalizeTaskType(taskType) || 'knowledge_question';
  if (normalized === 'xunji_analysis') {
    const data_source = analysisSource(input);
    const missing_fields = data_source.status === 'import_needed' ? ['records']
      : data_source.status === 'date_range_needed' ? ['date_range'] : [];
    const required_fields = data_source.status === 'imported' ? ['records']
      : data_source.status === 'read_pending' ? ['date_range'] : missing_fields;
    return { state: missing_fields.length ? 'ask' : 'ready', required_fields, missing_fields, data_source };
  }
  const fields = requiredFieldsForTask(normalized);
  const missing_fields = fields.filter((field) => !hasValue(valueForField(field, { profile, currentState, records, source_assets, sourceAssets })));

  if (normalized === 'today_workout' && missing_fields.length === 0) {
    const hasExecutionContext = hasValue(profile.available_time_min) || hasValue(currentState.available_time_min)
      || hasValue(profile.available_equipment) || hasValue(currentState.available_equipment);
    return { state: hasExecutionContext ? 'ready' : 'assume', missing_fields };
  }
  return { state: missing_fields.length > 0 ? 'ask' : 'ready', missing_fields };
}

function classificationReason(input, taskType) {
  if (taskType === 'safety_routing' && hasRedFlag(input)) return 'red_flag_detected';
  if (normalizeTaskType(input.taskType || input.task_type) === taskType) return 'explicit_task_type';
  return taskType === 'knowledge_question' ? 'simple_knowledge_question' : 'instruction_classification';
}

function artifactModeForPlan(assetPlan) {
  if (assetPlan.mode === 'dashboard') return 'dashboard';
  if (assetPlan.artifacts.length === 0) return 'none';
  if (assetPlan.index || assetPlan.artifacts.length > 1) return 'multi_asset_bundle';
  if (/\.md$/iu.test(assetPlan.artifacts[0])) return 'single_markdown';
  if (/\.(?:png|jpe?g|webp|gif|svg)$/iu.test(assetPlan.artifacts[0])) return 'single_image';
  return 'single_asset';
}

function buildWorkflowDecision(input = {}) {
  const task_type = classifyTrainingTask(input);
  const currentState = input.currentState || input.current_state || {};
  const information = evaluateInformationState({
    ...input,
    taskType: task_type,
    profile: input.profile || {},
    currentState,
    records: input.records,
    source_assets: input.source_assets,
    sourceAssets: input.sourceAssets
  });
  const assetPlan = planOutputAssets({
    taskType: task_type,
    userInstruction: input.instruction || input.userInstruction,
    outputDirectory: input.outputDirectory,
    existingPaths: input.existingPaths,
    capabilities: input.capabilities
  });
  const artifact_mode = artifactModeForPlan(assetPlan);
  const reason_codes = [classificationReason(input, task_type), assetPlan.reason];
  if (information.state === 'assume') reason_codes.push('safe_execution_assumption');
  if (information.missing_fields.length > 0) reason_codes.push('structural_information_missing');

  return {
    task_type,
    safety: inspectSafety(input),
    connection: task_type === 'xunji_connect' ? connectForRequest(input) : null,
    data_source: information.data_source ?? null,
    writeback: task_type === 'xunji_writeback' ? {
      next: information.missing_fields.length ? 'request_records_for_preview' : 'preview_then_request_explicit_confirmation',
      confirmed: false
    } : null,
    interaction_mode: assetPlan.mode,
    required_fields: information.required_fields ?? requiredFieldsForTask(task_type),
    missing_fields: information.missing_fields,
    information_state: information.state,
    artifact_mode,
    artifacts: assetPlan.artifacts,
    index: assetPlan.index,
    paths: assetPlan.paths,
    reason_codes: [...new Set(reason_codes)]
  };
}

module.exports = {
  classifyTrainingTask,
  requiredFieldsForTask,
  evaluateInformationState,
  buildWorkflowDecision
};
