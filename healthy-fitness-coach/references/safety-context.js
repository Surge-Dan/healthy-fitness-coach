'use strict';

// Keep these symptom groups aligned with the red flags in safety-screening.md.
const RED_FLAGS = [
  /\bchest (?:pain|pressure|tightness)\b|胸(?:部|口)?(?:疼痛|疼|很痛|痛)|胸(?:部|口)(?:有)?压迫感/iu,
  /\b(?:shortness of breath|short of breath|difficulty breathing|cannot breathe|can't breathe|breathlessness|dyspnea)\b|呼吸困难|(?:明显|异常|严重|很)气短|气短|喘不(?:上|过)气/iu,
  /\b(?:(?:near[- ]?)?(?:faint(?:ed|ing)?|syncope)|presyncope|dizz(?:y|iness))\b|晕厥|晕倒|明显头晕/iu,
  /\bpalpitations?\b|异常心悸/iu,
  /\bprogressive (?:numbness|weakness)\b|进行性(?:麻木(?:[、和与或/]*无力)?|无力)|大小便功能异常|(?:bowel or bladder|bowel and bladder) (?:dysfunction|changes?)/iu,
  /\b(?:severe pain|acute (?:severe )?(?:injury|trauma)|unable to bear weight|cannot bear weight|severe swelling|obvious deformity)\b|剧烈疼痛|急性(?:严重)?(?:外伤|损伤)|无法负重|严重肿胀|明显畸形/iu,
  /\b(?:rapid(?:ly)? worsen\w*|recent surgery|pregnan\w*|post[- ]?partum)\b|快速恶化|情况紧急|近期手术|妊娠|产后/iu
];
const RED_FLAG_PATTERN = new RegExp(RED_FLAGS.map(({ source }) => source).join('|'), 'iu');
const SAFE_MARKER_PATTERN = /^(?:none|no(?:\s+(?:pain|flags?))?|false|0|无(?:红旗)?|没有(?:红旗)?|未报告|未提供|unknown|未知)$/iu;
const NEGATION = /(?:没有|没|未曾|未有|未见|否认|否定|未发生|未出现|不再|无|\b(?:no|not|without|den(?:y|ies|ied)|never)\b)\s*(?:出现|感到|任何|发生|报告|明显|异常|再|有|(?:any|experiencing|have|having|signs? of|reported|feel(?:ing)?)\b\s*)*$/iu;
const DOUBLE_NEGATION = /(?:并非|不是|不能说|不代表)\s*(?:完全)?\s*(?:没|无|未)|\b(?:not|isn't) (?:without|true that .*? (?:no|not))\b/iu;
const LIST_SEPARATOR = /^(?:(?:\s|[、,，/&])|或者|以及|或|和|及|与|也无|\b(?:or|and|nor|neither)\b)+$/iu;
const BARE_COMMA = /^\s*[,，]\s*$/u;
const EXPLICIT_LIST_TAIL = /^[^.!?;。！？；]*[,，]\s*(?:\b(?:or|and|nor)\b|或|和)/iu;
const CONFIRMED_AFTER = /^(?:\s*(?:了|发作|持续|加重|恶化|越来越|又出现)|\s+(?:(?:is|are|has|have) )?(?:worsen\w*|persist\w*|continu\w*|now\b))/iu;
const CLAUSE_BOUNDARY = /[。.!！?？;；\n]+|(?:但(?:是)?|(?<!喘)不过|然而|可是|而是|如今|\b(?:but|however|yet)\b)/iu;
const HISTORICAL = /以前|曾经|去年|上(?:次|周|月)|数月前|\b(?:previously|ago|last (?:year|month|week)|history of|used to)\b/iu;
const CURRENT = /今天|现在|正在|刚刚|此刻|目前|\b(?:now|currently|today|right now)\b/iu;
const UNCERTAIN = /不确定|可能|疑似|会不会|是否|不知道是不是|\b(?:maybe|might|possibly|not sure|unsure|could be)\b/iu;
const EDUCATIONAL = new RegExp(`^(?:(?:请解释|解释一下|什么是|什么叫|what is|what does)\\s*(?:${RED_FLAG_PATTERN.source})(?: mean)?|(?:${RED_FLAG_PATTERN.source})(?:是什么|是什么意思))[？?。.!！\\s]*$`, 'iu');
const SEVERITY = { clear: 0, clarify: 1, stop: 2 };

function symptomStatus(value, pattern = RED_FLAG_PATTERN) {
  let status = 'clear';
  const matcher = new RegExp(pattern.source, 'giu');
  for (const clause of value.normalize('NFKC').split(CLAUSE_BOUNDARY)) {
    let previousEnd = 0;
    let previousStatus = null;
    for (const match of clause.matchAll(matcher)) {
      const prefix = clause.slice(previousEnd, match.index);
      const remaining = clause.slice(match.index + match[0].length);
      const following = remaining.split(/[,，、]/u, 1)[0];
      const context = prefix.split(/[,，、]/u).at(-1);
      let next = 'stop';
      if (previousStatus !== null && LIST_SEPARATOR.test(prefix) && !CONFIRMED_AFTER.test(following)) {
        next = previousStatus === 'clear' && BARE_COMMA.test(prefix) && !EXPLICIT_LIST_TAIL.test(remaining)
          ? 'clarify' : previousStatus;
      }
      else if ((NEGATION.test(context) && !DOUBLE_NEGATION.test(context))
        || /^(?:\s*(?:已经)?(?:消失|没有了|已缓解)|\s+(?:has |have )?(?:resolved|gone away))/iu.test(following)) next = 'clear';
      else if ((HISTORICAL.test(context + ' ' + following) && !CURRENT.test(context + ' ' + following))
        || (UNCERTAIN.test(context) && !/疑似急性(?:严重)?(?:外伤|损伤)/u.test(context + match[0]))) next = 'clarify';
      if (SEVERITY[next] > SEVERITY[status]) status = next;
      previousEnd = match.index + match[0].length;
      previousStatus = next;
    }
  }
  return status;
}

function structuredStatus(value, explicit) {
  if (value === true || typeof value === 'number') {
    return explicit && (value === true || (Number.isFinite(value) && value !== 0)) ? 'stop' : 'clear';
  }
  if (typeof value === 'string') {
    const text = value.trim().replaceAll('_', ' ');
    if (!text || SAFE_MARKER_PATTERN.test(text)) return 'clear';
    if (explicit && !RED_FLAG_PATTERN.test(text)) {
      return NEGATION.test(text.split(/\s/u)[0]) ? 'clear' : 'stop';
    }
    return symptomStatus(text);
  }
  if (!value || typeof value !== 'object') return 'clear';
  if (value.present === false) return 'clear';
  if (explicit && Object.hasOwn(value, 'code')) return structuredStatus(value.code, true);
  return highestStatus(Object.values(value).map((item) => structuredStatus(item, explicit)));
}

function highestStatus(statuses) {
  return statuses.reduce((highest, status) => SEVERITY[status] > SEVERITY[highest] ? status : highest, 'clear');
}

function explicitStatuses(source, seen = new WeakSet()) {
  if (!source || typeof source !== 'object' || seen.has(source)) return [];
  seen.add(source);
  return Object.entries(source).flatMap(([key, value]) => /^red[_-]?flags?$/iu.test(key)
    ? [structuredStatus(value, true)] : explicitStatuses(value, seen));
}

function inspectSafety(input = {}) {
  const state = input.currentState || input.current_state || {};
  const structured = highestStatus([input, input.safety, state, state.safety].filter(Boolean).flatMap((source) => [
    structuredStatus(source.pain, false),
    structuredStatus(source.symptoms, false)
  ]).concat(explicitStatuses(input)));
  if (structured === 'stop') return { status: 'stop', reason: 'reported_red_flag' };
  const instruction = String(input.instruction || input.userInstruction || '').trim();
  const educational = EDUCATIONAL.test(instruction);
  const status = highestStatus([structured, educational ? 'clear' : symptomStatus(instruction)]);
  if (status === 'stop') return { status, reason: 'current_red_flag' };
  if (status === 'clarify') return { status, reason: 'confirm_current_symptoms' };
  return { status, reason: educational ? 'educational_question' : 'no_positive_red_flag' };
}

function hasPositiveRedFlagText(value) {
  return symptomStatus(String(value || '')) !== 'clear';
}

module.exports = { inspectSafety, hasPositiveRedFlagText, symptomStatus };
