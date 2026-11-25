'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { normalizeAthleteProfile } = require('./athlete-state.js');
const text = value => typeof value === 'string' ? value.slice(0, 2000) : '';
const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
const EXACT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/iu;

function canonicalJson(value) {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
  });
}

function digest(data, legacy = false) {
  return createHash('sha256').update(legacy ? JSON.stringify(data) : canonicalJson(data)).digest('hex');
}

function validDate(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  if (EXACT_TIMESTAMP.test(value)) return validDate(value.slice(0, 10));
  return DATE_ONLY.test(value) && new Date(value).toISOString().slice(0, 10) === value;
}

function localDate(instant, timezone) {
  const formatter = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = Object.fromEntries(formatter.formatToParts(instant).map(({ type, value }) => [type, value]));
  return [parts.year.padStart(4, '0'), parts.month, parts.day].join('-');
}

function isExpired(validUntil, timezone, now) {
  return DATE_ONLY.test(validUntil)
    ? localDate(now, timezone) > validUntil
    : now > Date.parse(validUntil);
}

function validDates({ updated_at, valid_until, timezone }) {
  if (!validDate(updated_at) || !validDate(valid_until) || typeof timezone !== 'string' || !timezone) return false;
  try {
    localDate(0, timezone);
    if (DATE_ONLY.test(updated_at)) {
      const expiryDay = DATE_ONLY.test(valid_until) ? valid_until : localDate(Date.parse(valid_until), timezone);
      return updated_at <= expiryDay;
    }
    return !isExpired(valid_until, timezone, Date.parse(updated_at));
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

function hasCheckpointFields(data) {
  const groups = [
    [data.profile, []],
    [data.program, ['version', 'summary', 'minimum_version']],
    [data.last_session, ['date', 'summary']]
  ];
  return groups.every(([group, keys]) => group && typeof group === 'object' && !Array.isArray(group)
    && keys.every((key) => typeof group[key] === 'string'))
    && typeof data.next_session === 'string' && Array.isArray(data.pending_questions)
    && data.pending_questions.every((question) => typeof question === 'string');
}

function createCheckpoint({ profile = {}, program = {}, last_session = {}, next_session = '', pending_questions = [], updated_at, valid_until, timezone = DEFAULT_TIMEZONE } = {}) {
  if (!validDates({ updated_at, valid_until, timezone })) throw new Error('Valid update and expiry dates required');
  const safeProfile = normalizeAthleteProfile(profile);
  const snapshot = { schema_version: '1.1', updated_at, valid_until, timezone, profile: safeProfile,
    program: { version: text(program.version), summary: text(program.summary), minimum_version: text(program.minimum_version) },
    last_session: { date: text(last_session.date), summary: text(last_session.summary) },
    next_session: text(next_session), pending_questions: pending_questions.filter(v => typeof v === 'string').map(text).slice(0, 10) };
  snapshot.checkpoint_id = digest(snapshot);
  return snapshot;
}
function assessResume(snapshot, { current_checkpoint_id, now = Date.now(), state_confirmed = false, timezone = DEFAULT_TIMEZONE } = {}) {
  if (!snapshot || !['1.0', '1.1'].includes(snapshot.schema_version)) return { status: 'invalid', next: 'request_training_summary' };
  const { checkpoint_id, ...data } = snapshot;
  const legacy = snapshot.schema_version === '1.0';
  const effectiveTimezone = legacy ? timezone : snapshot.timezone;
  const valid = legacy ? Number.isFinite(Date.parse(snapshot.valid_until)) : hasCheckpointFields(data) && validDates(data);
  if (!valid || checkpoint_id !== digest(data, legacy)) return { status: 'invalid', next: 'review_edited_summary' };
  if (current_checkpoint_id && current_checkpoint_id !== checkpoint_id) return { status: 'conflict', next: 'choose_current_plan_do_not_merge_silently' };
  try {
    if (isExpired(snapshot.valid_until, effectiveTimezone, Number(now))) return { status: 'stale', next: 'confirm_goal_schedule_and_current_symptoms' };
  } catch (error) {
    if (error instanceof RangeError) return { status: 'invalid', next: 'review_edited_summary' };
    throw error;
  }
  return state_confirmed === true && Number.isFinite(Number(now))
    ? { status: 'ready', next: 'continue_next_session' }
    : { status: 'confirm_current_state', next: 'confirm_current_symptoms_time_and_equipment' };
}
function saveCheckpoint(directory, snapshot, { consent = false } = {}) {
  if (consent !== true || snapshot.profile?.persisted !== true) throw new Error('Explicit persistence consent required');
  if (assessResume(snapshot).status === 'invalid') throw new Error('Invalid checkpoint');
  fs.mkdirSync(directory, { recursive: true });
  const filename = 'TRAINING_CHECKPOINT-' + snapshot.checkpoint_id + '.json';
  const target = path.join(directory, filename);
  try { fs.writeFileSync(target, JSON.stringify(snapshot, null, 2), { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (canonicalJson(existing) !== canonicalJson(snapshot)) throw new Error('Checkpoint conflict');
  }
  const pointer = path.join(directory, 'CURRENT_TRAINING.json');
  const temporary = pointer + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify({ checkpoint_id: snapshot.checkpoint_id, file: filename, updated_at: snapshot.updated_at }));
    fs.renameSync(temporary, pointer);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return { snapshot_path: target, current_pointer: pointer, persisted: true };
}
module.exports = { createCheckpoint, assessResume, saveCheckpoint };
