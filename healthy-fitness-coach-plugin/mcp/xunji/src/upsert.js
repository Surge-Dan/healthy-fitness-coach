'use strict';

const { connectorError } = require('./errors.js');
const { parseTrainingRecords } = require('./parser.js');
const { assertDate } = require('./schemas.js');

function normalizeRecordDate(line) {
  const first = String(line).trim().split(',')[0].trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(first)) {
    return assertDate(first);
  }
  if (/^\d{6}$/.test(first)) {
    const expanded = `20${first.slice(0, 2)}-${first.slice(2, 4)}-${first.slice(4, 6)}`;
    return assertDate(expanded);
  }
  throw connectorError('invalid_upsert');
}

function parseUpsertLine(line) {
  const raw = String(line);
  const date = normalizeRecordDate(raw);
  const tokens = raw.split(',').slice(1).map((token) => token.trim());
  const idToken = tokens.find((token) => /^id:.+/i.test(token));
  const timeToken = tokens.find((token) => /^train_time:.+/i.test(token));
  return {
    raw,
    date,
    ...(idToken ? { id: idToken.slice(3).trim() } : {}),
    ...(timeToken ? { train_time: timeToken.slice('train_time:'.length).trim() } : {})
  };
}

function validateUpsertRecords(records) {
  if (!Array.isArray(records) || records.length === 0) throw connectorError('invalid_upsert');
  if (records.length > 12) throw connectorError('record_limit');
  if (records.some((record) => typeof record !== 'string' || record.length > 1500)) throw connectorError('record_too_long');
  const parsed = records.map(parseUpsertLine);
  const date = parsed[0].date;
  if (parsed.some((record) => record.date !== date)) throw connectorError('mixed_dates');
  const ids = parsed.flatMap((record) => record.id ? [record.id] : []);
  if (new Set(ids).size !== ids.length) throw connectorError('invalid_upsert');
  return {
    date,
    records: records.slice(),
    parsed,
    existing_ids: ids.length,
    new_records: records.length - ids.length
  };
}

const comparableFields = ['title', 'sets', 'reps', 'total_reps', 'weight', 'duration_min', 'distance_km', 'avg_hr'];

function normalizeClock(time) {
  return time?.replace(/^\d{4}-\d{2}-\d{2}[ T]/, '').replace(/^(\d{2}:\d{2}):00$/, '$1');
}

function matchesReturnedRecords(validated, returned) {
  const requested = parseTrainingRecords(validated.records);
  const match = (source, result) =>
    comparableFields.every((field) => source[field] === undefined || source[field] === result[field]) &&
    (source.train_time === undefined || normalizeClock(source.train_time) === normalizeClock(result.train_time));
  const knownIds = new Set(validated.parsed.flatMap((row) => row.id ? [row.id] : []));
  const newCandidates = [];
  for (const [index, source] of requested.entries()) {
    const id = validated.parsed[index].id;
    if (id) {
      if (!returned.some((result) => result.id === id && match(source, result))) return false;
    } else {
      if (!source.title) return false;
      newCandidates.push(returned.filter((result) => result.id && !knownIds.has(result.id) && match(source, result)));
    }
  }
  for (const candidates of newCandidates.sort((a, b) => a.length - b.length)) {
    const candidate = candidates.find((result) => !knownIds.has(result.id));
    if (!candidate) return false;
    knownIds.add(candidate.id);
  }
  return true;
}

module.exports = { matchesReturnedRecords, normalizeRecordDate, parseUpsertLine, validateUpsertRecords };
