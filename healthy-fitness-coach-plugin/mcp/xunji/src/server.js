'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { OperationStore, memoryOperationStore, processIsAlive, versionOf } = require('./operation-store.js');
const { join } = require('node:path');
const { z } = require('zod');
const { FileCache, credentialFingerprint } = require('./cache.js');
const { FileDNAStore } = require('./dna-store.js');
const { readWindowsCredential } = require('./credentials.js');
const { connectorError, toPublicError } = require('./errors.js');
const { filterModelFacingRecords, parseTrainingRecords } = require('./parser.js');
const { assertDate } = require('./schemas.js');
const { renderTrainingDashboardHtml } = require('./dashboard.js');
const { buildVisualReportAssets } = require('./visual-report.js');
const { analyzeTrainingRange, buildReviewFirstTrainingDNA } = require('./trends.js');
const { compareTrainingDNA } = require('./training-dna.js');
const { matchesReturnedRecords, validateUpsertRecords } = require('./upsert.js');
const { decodeXunjiResponse, XunjiClient } = require('./xunji-client.js');

const REFRESH_WINDOW_MS = 90_000;
const MAX_RANGE_DAYS = 90;
const MAX_TOTAL_RANGE_DAYS = 366 * 5;

function currentShanghaiDate(time = Date.now()) {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(time)).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${values.year}-${values.month}-${values.day}`;
}

function dateRange(startDate, endDate) {
  assertDate(startDate);
  assertDate(endDate);
  if (startDate > endDate) throw Object.assign(new Error('invalid range'), { code: 'invalid_date' });
  const dates = [];
  for (let value = new Date(`${startDate}T00:00:00Z`), end = new Date(`${endDate}T00:00:00Z`); value <= end; value.setUTCDate(value.getUTCDate() + 1)) {
    dates.push(value.toISOString().slice(0, 10));
    if (dates.length > MAX_RANGE_DAYS) throw Object.assign(new Error('range too large'), { code: 'range_too_large' });
  }
  return dates;
}

function dateRangeChunks(startDate, endDate) {
  assertDate(startDate); assertDate(endDate);
  if (startDate > endDate) throw Object.assign(new Error('invalid range'), { code: 'invalid_date' });
  const totalDays = Math.floor((new Date(`${endDate}T00:00:00Z`) - new Date(`${startDate}T00:00:00Z`)) / 86400000) + 1;
  if (totalDays > MAX_TOTAL_RANGE_DAYS) throw Object.assign(new Error('range too large'), { code: 'range_too_large' });
  const chunks = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    const finishDate = new Date(`${cursor}T00:00:00Z`);
    finishDate.setUTCDate(finishDate.getUTCDate() + MAX_RANGE_DAYS - 1);
    const finish = finishDate.toISOString().slice(0, 10) < endDate ? finishDate.toISOString().slice(0, 10) : endDate;
    chunks.push(dateRange(cursor, finish));
    const next = new Date(`${finish}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1); cursor = next.toISOString().slice(0, 10);
  }
  return chunks;
}

function submissionOutcome(entry) {
  if (!entry) return 'not_submitted';
  if (entry.outcome !== 'submitting') return entry.outcome;
  return processIsAlive(entry.pid) ? 'submitting' : 'unknown';
}

function createTrainingService({ operationStore = null, cache = null, cacheFactory, dnaStore = null, client = new XunjiClient(), credentialProvider = readWindowsCredential, logger = null, now = Date.now, today = null, localAppData = process.env.LOCALAPPDATA } = {}) {
  const previews = new Map();
  const verifications = new Map();
  const operations = operationStore || (cache ? memoryOperationStore() : new OperationStore(join(localAppData || '.', 'HealthyFitnessCoach', 'write-operations')));
  const digest = (credential, records) => createHash('sha256').update(JSON.stringify([credentialFingerprint(credential), records])).digest('hex');
  const pending = new Map();
  const dayQueues = new Map();
  const dayVersions = new Map();
  const invalidatedDays = new Set();
  const accountCaches = new Map();
  const accountDnaStores = new Map();
  const dnaPending = new Map();
  const dayKey = (credential, date) => `${credentialFingerprint(credential)}:${date}`;

  async function findSubmission(credential, records) {
    // Compare submission batches as multisets. Keep the exact sequence for
    // preview confirmation and the remote request.
    const exactKey = digest(credential, records);
    const batchKey = digest(credential, [...records].sort());
    const entry = await operations.get(batchKey);
    if (entry || exactKey === batchKey) return { batchKey, key: batchKey, entry };
    // Older journals stored only the digest of the exact sequence.
    const legacyEntry = await operations.get(exactKey);
    return legacyEntry ? { batchKey, key: exactKey, entry: legacyEntry } : { batchKey, key: batchKey, entry: null };
  }

  async function withDay(key, action) {
    const operation = (dayQueues.get(key) || Promise.resolve()).catch(() => {}).then(action);
    dayQueues.set(key, operation);
    try { return await operation; } finally { if (dayQueues.get(key) === operation) dayQueues.delete(key); }
  }

  async function saveUpsertEntry(date, key, store, entry, cacheRevision) {
    dayVersions.set(key, (dayVersions.get(key) || 0) + 1);
    try {
      await store.set(date, entry, cacheRevision);
      invalidatedDays.delete(key);
      return true;
    } catch (_) {
      invalidatedDays.add(key);
      entry.warnings.push('write_confirmed_cache_failed');
      try { await store.delete?.(date, cacheRevision); } catch (_) { /* Recheck this date even if deletion fails. */ }
      return false;
    }
  }

  const getCache = async (credential) => {
    // `cache` is a test-only single-store injection. Production always keys its
    // stores by the one-way credential fingerprint below.
    if (cache) return cache;
    if (!localAppData) throw connectorError('cache_error');
    const fingerprint = credentialFingerprint(credential);
    if (accountCaches.has(fingerprint)) return accountCaches.get(fingerprint);
    const root = join(localAppData, 'HealthyFitnessCoach', 'xunji-cache');
    const storePromise = cacheFactory ? Promise.resolve().then(() => cacheFactory(credential)) : Promise.resolve(new FileCache({ root, fingerprint }));
    accountCaches.set(fingerprint, storePromise);
    try {
      return await storePromise;
    } catch (error) {
      if (accountCaches.get(fingerprint) === storePromise) accountCaches.delete(fingerprint);
      throw error;
    }
  };

  const getDNAStore = async (credential) => {
    if (dnaStore) return dnaStore;
    if (!localAppData) return null;
    const fingerprint = credentialFingerprint(credential);
    if (accountDnaStores.has(fingerprint)) return accountDnaStores.get(fingerprint);
    const store = new FileDNAStore({ root: join(localAppData, 'HealthyFitnessCoach', 'training-dna'), fingerprint });
    accountDnaStores.set(fingerprint, store);
    return store;
  };

  const resultFromEntry = (date, entry, cacheHit, networkFetches) => {
    const filtered = filterModelFacingRecords(entry.records || []);
    const records = filtered.filter((record) => !record.warnings?.includes('invalid_date') && record.record_date === date);
    const crossDate = filtered.length - records.length;
    return {
      date,
      fetched_at: entry.fetched_at,
      cache_hit: cacheHit,
      cache_hits: cacheHit ? 1 : 0,
      network_fetches: networkFetches,
      dates: [date],
      records,
      warnings: [...(entry.warnings || []), ...filtered.warnings, ...(crossDate ? [`cross_date_records_dropped:${crossDate}`] : [])],
      data_freshness: cacheHit ? 'cached' : 'network'
    };
  };

  async function fetchMissing(date, credential, store, key, version, snapshot) {
    const pendingKey = `${key}:${version}:${snapshot.version}`;
    if (pending.has(pendingKey)) return pending.get(pendingKey);
    const operation = (async () => {
      let entry, fetchError;
      try {
        const response = await client.fetchDay(date, credential);
        const decoded = response && Array.isArray(response.records) ? response : decodeXunjiResponse(response);
        const parsed = parseTrainingRecords(decoded.records);
        const filtered = filterModelFacingRecords(parsed);
        const safeRecords = filtered.filter((record) => !record.warnings?.includes('invalid_date') && record.record_date === date);
        const warnings = [...filtered.warnings, ...parsed.flatMap((record) => record.warnings || []), ...(safeRecords.length !== filtered.length ? [`cross_date_records_dropped:${filtered.length - safeRecords.length}`] : [])];
        entry = { fetched_at: now(), records: safeRecords, warnings };
      } catch (error) {
        fetchError = error;
      }
      return withDay(key, async () => {
        if ((dayVersions.get(key) || 0) !== version) return { superseded: true };
        if (store.isSnapshotCurrent && !await store.isSnapshotCurrent(date, snapshot.version)) return { superseded: true };
        if (fetchError) return { error: toPublicError(fetchError) };
        try {
          if (store.saveSnapshot) {
            if (!await store.saveSnapshot(date, entry, snapshot)) return { superseded: true };
          } else {
            await store.set(date, entry);
          }
          invalidatedDays.delete(key);
        } catch (_) {
          entry.warnings.push('read_cache_save_failed');
        }
        if (logger && typeof logger.info === 'function') logger.info('xunji_training_day_fetched', { date });
        return resultFromEntry(date, entry, false, 1);
      });
    })();
    pending.set(pendingKey, operation);
    try { return await operation; } finally { pending.delete(pendingKey); }
  }

  async function getTrainingDay({ date, refresh = false, credentialOverride = null } = {}) {
    try {
      assertDate(date);
      const credential = credentialOverride || await credentialProvider();
      const store = await getCache(credential);
      const key = dayKey(credential, date);
      let discardedFetches = 0;
      while (true) {
        const { snapshot, version } = await withDay(key, async () => {
          const invalidated = invalidatedDays.has(key);
          const snapshot = store.readSnapshot
            ? await store.readSnapshot(date, invalidated)
            : { entry: invalidated ? null : await store.get(date), version: null };
          return { snapshot, version: dayVersions.get(key) || 0 };
        });
        const { entry } = snapshot;
        if (entry) {
          const elapsed = now() - entry.fetched_at;
          if (refresh && elapsed >= 0 && elapsed < REFRESH_WINDOW_MS) {
            return { error: toPublicError(Object.assign(new Error('rate limited'), { code: 'rate_limited', retry_after_seconds: (REFRESH_WINDOW_MS - elapsed) / 1000 })) };
          }
          const todayDate = today ? today() : currentShanghaiDate(now());
          const ageDays = (Date.parse(todayDate) - Date.parse(date)) / 86400000;
          const recentExpired = ageDays >= 0 && ageDays < 7 && elapsed >= 300000;
          if (!refresh && !recentExpired) return resultFromEntry(date, entry, true, discardedFetches);
        }
        const refreshed = await fetchMissing(date, credential, store, key, version, snapshot);
        if (refreshed.superseded) {
          discardedFetches += 1;
          refresh = false;
          continue;
        }
        if (entry && refreshed.error && !['missing_credentials', 'invalid_credentials', 'membership_required'].includes(refreshed.error.code)) {
          const fallback = resultFromEntry(date, entry, true, discardedFetches);
          fallback.warnings = [...fallback.warnings, 'refresh_failed_using_cache'];
          return fallback;
        }
        return refreshed.error ? refreshed : { ...refreshed, network_fetches: refreshed.network_fetches + discardedFetches };
      }
    } catch (error) {
      return { error: toPublicError(error) };
    }
  }

  async function getTrainingRange({ start_date, end_date, refresh_today = false, refresh_dates = [], refresh_all = false, credentialOverride = null } = {}) {
    let dates;
    try { dates = dateRangeChunks(start_date, end_date).flat(); if (!Array.isArray(refresh_dates)) throw connectorError('invalid_date'); refresh_dates.forEach(assertDate); if (refresh_dates.some(date => !dates.includes(date))) throw connectorError('invalid_date'); } catch (error) { return { error: toPublicError(error) }; }
    let credential;
    try { credential = credentialOverride || await credentialProvider(); } catch (error) { return { error: toPublicError(error) }; }
    const aggregate = { cache_hits: 0, network_fetches: 0, dates, days: [], records: [], missing_dates: [], warnings: [], data_freshness: 'mixed', partial: false };
    let firstError = null;
    const todayDate = today ? today() : currentShanghaiDate(now());
    for (const date of dates) {
      const day = await getTrainingDay({ date, refresh: refresh_all || refresh_dates.includes(date) || (refresh_today && date === todayDate), credentialOverride: credential });
      if (day.error) {
        if (!firstError) firstError = day.error;
        aggregate.missing_dates.push(date);
        aggregate.warnings.push(`missing_date:${date}:${day.error.code}`);
        continue;
      }
      aggregate.cache_hits += day.cache_hits;
      aggregate.network_fetches += day.network_fetches;
      aggregate.days.push(day);
      aggregate.records.push(...day.records);
      aggregate.warnings.push(...day.warnings);
    }
    if (aggregate.days.length === 0) return { error: firstError };
    aggregate.partial = aggregate.missing_dates.length > 0;
    if (aggregate.network_fetches === 0) aggregate.data_freshness = 'cached';
    if (aggregate.cache_hits === 0) aggregate.data_freshness = 'network';
    return aggregate;
  }

  async function previewTrainingUpsert({ records } = {}) {
    try {
      const validated = validateUpsertRecords(records);
      const credential = await credentialProvider();
      const fingerprint = digest(credential, validated.records);
      const { key, entry } = await findSubmission(credential, validated.records);
      const outcome = submissionOutcome(entry);
      for (const [id, preview] of previews) if (preview.expires_at <= now()) previews.delete(id);
      const preview_id = randomUUID();
      const expires_at = now() + 600000;
      previews.set(preview_id, { fingerprint, key, version: versionOf(entry), expires_at });
      return { date: validated.date, record_count: records.length, existing_ids: validated.existing_ids,
        new_records: validated.new_records, records: validated.records, parsed: validated.parsed,
        preview_id, expires_at, requires_confirmation: true,
        previous_submission: outcome === 'not_submitted' ? null : {
          outcome, date: entry.date, submitted_at: entry.submitted_at, confirmed_at: entry.confirmed_at
        } };
    } catch (error) { return { error: toPublicError(error) }; }
  }

  async function upsertTrainingRecords({ records, confirm = false, preview_id } = {}) {
    if (confirm !== true) return { outcome: 'not_submitted', error: toPublicError(connectorError('writeback_not_confirmed')) };
    try {
      const validated = validateUpsertRecords(records);
      const credential = await credentialProvider();
      const preview = previews.get(preview_id);
      if (!preview || preview.fingerprint !== digest(credential, validated.records) || preview.expires_at <= now()) throw connectorError('preview_required');
      const store = await getCache(credential);
      const date = validated.date;
      const cacheKey = dayKey(credential, date);
      return await withDay(cacheKey, async () => {
        if (preview.expires_at <= now()) throw connectorError('preview_required');
        const { batchKey, key, entry: previous } = await findSubmission(credential, validated.records);
        if (submissionOutcome(previous) !== 'not_submitted')
          return { outcome: 'reconciliation_required', error: toPublicError(connectorError('reconciliation_required')) };
        if (preview.key !== key || preview.version !== versionOf(previous)) throw connectorError('preview_required');
        const expectedVersion = batchKey === key ? versionOf(previous) : null;
        const write = (epoch) => sendTrainingUpsert({ validated, credential, batchKey, expectedVersion, store, cacheKey, epoch });
        return store.withWriteRevision ? store.withWriteRevision(date, write) : write();
      });
    } catch (error) {
      return { outcome: 'not_submitted', error: toPublicError(error) };
    }
  }

  async function sendTrainingUpsert({ validated, credential, batchKey, expectedVersion, store, cacheKey, epoch }) {
    const { date, records } = validated;
    // Durable claim happens before sending; a crash cannot make a retry safe.
    const attempt = { outcome: 'submitting', date, submitted_at: now(), version: randomUUID(), pid: process.pid };
    if (!await operations.transition(batchKey, expectedVersion, attempt))
      return { outcome: 'reconciliation_required', error: toPublicError(connectorError('reconciliation_required')) };
    const settle = (outcome) => operations.transition(batchKey, attempt.version, {
      outcome, date, version: randomUUID(), submitted_at: attempt.submitted_at,
      ...(outcome === 'confirmed' ? { confirmed_at: now() } : {})
    });
    let parsed, safeRecords;
    try {
      const response = await client.upsertRecords(records, credential);
      const decoded = response && Array.isArray(response.records) ? response : decodeXunjiResponse(response);
      parsed = parseTrainingRecords(decoded.records);
      if (!parsed.length || parsed.some(record => record.record_date !== date || record.warnings?.includes('invalid_date'))) throw connectorError('invalid_response');
      if (!matchesReturnedRecords(validated, parsed)) throw connectorError('invalid_response');
      safeRecords = filterModelFacingRecords(parsed);
    } catch (error) {
      const rejected = ['invalid_credentials', 'membership_required', 'rate_limited'].includes(error?.code);
      const outcome = rejected ? 'not_submitted' : 'unknown';
      await settle(outcome).catch(() => {});
      return { outcome, error: toPublicError(rejected ? error : connectorError('writeback_unknown')) };
    }
    const warnings = [...safeRecords.warnings, ...parsed.flatMap(record => record.warnings || [])];
    const entry = { fetched_at: now(), records: safeRecords, warnings, last_operation: 'upsert' };
    if (!await settle('confirmed').catch(() => false)) warnings.push('write_confirmed_journal_update_failed');
    const cache_saved = await saveUpsertEntry(date, cacheKey, store, entry, epoch);
    return { ...resultFromEntry(date, entry, false, 1), outcome: 'confirmed', writeback: true,
      cache_saved, upserted_records: records.length, server_records: safeRecords };
  }

  async function reconcileTrainingUpsert({ records, verification_id, confirm_not_applied = false } = {}) {
    try {
      const validated = validateUpsertRecords(records);
      const credential = await credentialProvider();
      const { key, entry } = await findSubmission(credential, validated.records);
      const submission = submissionOutcome(entry);
      if (submission === 'confirmed') return { outcome: 'confirmed', writeback: false, confirmed_at: entry.confirmed_at };
      if (submission === 'submitting') return { outcome: 'submitting', writeback: false };
      const version = versionOf(entry);
      if (confirm_not_applied === true) {
        const proof = verifications.get(verification_id);
        if (submission !== 'unknown' || !proof || proof.key !== key || proof.version !== version || proof.expires_at <= now())
          throw connectorError('reconciliation_required');
        verifications.delete(verification_id);
        if (!await operations.transition(key, version, { outcome: 'not_submitted', date: validated.date, version: randomUUID() }))
          throw connectorError('reconciliation_required');
        return { outcome: 'verified_not_applied', next: 'create_new_preview_and_confirm', writeback: false };
      }
      if (submission !== 'unknown') return { outcome: 'not_submitted', writeback: false };
      // Reconciliation must read the server, not a possibly stale cache.
      const response = await client.fetchDay(validated.date, credential);
      const decoded = response && Array.isArray(response.records) ? response : decodeXunjiResponse(response);
      const parsed = parseTrainingRecords(decoded.records);
      if (parsed.some(record => record.record_date !== validated.date || record.warnings?.includes('invalid_date'))) throw connectorError('invalid_response');
      const safeRecords = filterModelFacingRecords(parsed);
      if (safeRecords.warnings.length || parsed.some(record => record.warnings?.length))
        return { outcome: 'needs_manual_verification', records: safeRecords, can_clear_submission: false };
      if (versionOf(await operations.get(key)) !== version) throw connectorError('reconciliation_required');
      for (const [id, proof] of verifications) if (proof.expires_at <= now()) verifications.delete(id);
      const id = randomUUID();
      verifications.set(id, { key, version, expires_at: now() + 300000 });
      return { outcome: 'needs_user_verification', date: validated.date, records: safeRecords,
        verification_id: id, fetched_at: now(), next: 'compare_records_do_not_automatically_resubmit' };
    } catch (error) { return { error: toPublicError(error), outcome: 'unknown' }; }
  }

  async function getTrainingTrends({ start_date, end_date, refresh_today = false, refresh_dates = [], refresh_all = false, planned_sessions_per_week, profile } = {}) {
    const range = await getTrainingRange({ start_date, end_date, refresh_today, refresh_dates, refresh_all });
    if (range.error) return range;
    const trends = analyzeTrainingRange({ ...range, planned_sessions_per_week, profile });
    return { range, trends, dashboard_html: renderTrainingDashboardHtml({ range, trends }), visual_assets: buildVisualReportAssets({ trends }) };
  }

  async function getTrainingDNAUnlocked({ start_date, end_date, refresh_today = false, refresh_dates = [], refresh_all = false, planned_sessions_per_week, profile, persist = true }, credential) {
    const range = await getTrainingRange({ start_date, end_date, refresh_today, refresh_dates, refresh_all, credentialOverride: credential });
    if (range.error) return range;
    const current = buildReviewFirstTrainingDNA({ range, planned_sessions_per_week, profile, previous_dna: null });
    let persisted = false;
    let version = null;
    let savedVersion;
    let previousVersion;
    let changes = { changed_dimensions: [], changes: [] };
    if (persist === true) {
      const prepareUpdate = (previous) => {
        const comparable = (value) => JSON.stringify({ data_range: value?.data_range, data_quality: value?.data_quality, metrics: value?.metrics, dimensions: value?.dimensions, unknowns: value?.unknowns, warnings: value?.warnings });
        if (previous) {
          const stored = Number(previous.version);
          savedVersion = Number.isSafeInteger(stored) && stored > 0 ? stored : 1;
          if (comparable(previous.training_dna) === comparable(current)) {
            version = savedVersion;
            return undefined;
          }
          previousVersion = savedVersion;
          changes = compareTrainingDNA(previous.training_dna, current);
        }
        version = (savedVersion || 0) + 1;
        const updated_at = now();
        const history = Array.isArray(previous?.history) ? previous.history.slice(-11) : [];
        return { version, updated_at, training_dna: current, changes,
          history: [...history, { version, updated_at, data_range: current.data_range, changes }] };
      };
      try {
        const store = await getDNAStore(credential);
        if (store) {
          if (store.update) {
            await store.update(prepareUpdate);
          } else {
            const next = prepareUpdate(await store.get());
            if (next) await store.set(next);
          }
          persisted = true;
        }
      } catch (_) {
        current.warnings = [...(current.warnings || []), 'training_dna_persistence_failed'];
      }
    }
    return { range, training_dna: { ...current, version: persisted ? version : null,
      ...(previousVersion ? { previous_version: previousVersion } : {}),
      ...(!persisted && savedVersion ? { saved_version: savedVersion } : {}), changes, persisted } };
  }

  async function getTrainingDNA(args = {}) {
    let credential;
    try { credential = await credentialProvider(); } catch (error) { return { error: toPublicError(error) }; }
    if (args.persist === false) return getTrainingDNAUnlocked(args, credential);
    const lockKey = credentialFingerprint(credential);
    const previous = dnaPending.get(lockKey) || Promise.resolve();
    const operation = previous.catch(() => {}).then(() => getTrainingDNAUnlocked(args, credential));
    dnaPending.set(lockKey, operation);
    try { return await operation; } finally { if (dnaPending.get(lockKey) === operation) dnaPending.delete(lockKey); }
  }

  return { getTrainingDay, getTrainingRange, getTrainingTrends, getTrainingDNA, previewTrainingUpsert, upsertTrainingRecords, reconcileTrainingUpsert };
}

function createMcpServer(options = {}) {
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const service = options.service || createTrainingService(options);
  const server = new McpServer({ name: 'healthy-fitness-xunji', version: '1.0.0' });
  const result = async (promise) => {
    const value = await promise;
    return value.error
      ? { isError: true, content: [{ type: 'text', text: JSON.stringify(value) }] }
      : { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
  };
  server.registerTool('xunji_get_training_day', {
    description: 'Read one day of local Xunji training data.',
    inputSchema: { date: z.string(), refresh: z.boolean().optional() },
    annotations: { readOnlyHint: true }
  }, ({ date, refresh }) => result(service.getTrainingDay({ date, refresh })));
  server.registerTool('xunji_get_training_range', {
    description: 'Read a local-date range of Xunji training data.',
    inputSchema: { start_date: z.string(), end_date: z.string(), refresh_today: z.boolean().optional(), refresh_dates: z.array(z.string()).optional(), refresh_all: z.boolean().optional() },
    annotations: { readOnlyHint: true }
  }, ({ start_date, end_date, refresh_today, refresh_dates, refresh_all }) => result(service.getTrainingRange({ start_date, end_date, refresh_today, refresh_dates, refresh_all })));
  server.registerTool('xunji_preview_training_upsert', {
    description: 'Validate and preview same-day Xunji training updates without writing.',
    inputSchema: { records: z.array(z.string()) },
    annotations: { readOnlyHint: true }
  }, ({ records }) => result(service.previewTrainingUpsert({ records })));
  server.registerTool('xunji_upsert_training_records', {
    description: 'Write confirmed same-day Xunji training records by ID and cache the server result.',
    inputSchema: { records: z.array(z.string()), confirm: z.boolean(), preview_id: z.string() },
    annotations: { readOnlyHint: false }
  }, ({ records, confirm, preview_id }) => result(service.upsertTrainingRecords({ records, confirm, preview_id })));
  server.registerTool('xunji_reconcile_training_upsert', {
    description: 'Read server records after an uncertain write. Only clear the submission lock after the user verifies it was not applied.',
    inputSchema: { records: z.array(z.string()), verification_id: z.string().optional(), confirm_not_applied: z.boolean().optional() },
    annotations: { readOnlyHint: false }
  }, args => result(service.reconcileTrainingUpsert(args)));
  server.registerTool('xunji_get_training_trends', {
    description: 'Analyze cached Xunji training range trends.',
    inputSchema: { start_date: z.string(), end_date: z.string(), refresh_today: z.boolean().optional(), refresh_dates: z.array(z.string()).optional(), refresh_all: z.boolean().optional(), planned_sessions_per_week: z.number().finite().nonnegative().max(14).optional(), profile: z.record(z.string(), z.unknown()).optional() },
    annotations: { readOnlyHint: true }
  }, ({ start_date, end_date, refresh_today, refresh_dates, refresh_all, planned_sessions_per_week, profile }) => result(service.getTrainingTrends({ start_date, end_date, refresh_today, refresh_dates, refresh_all, planned_sessions_per_week, profile })));
  server.registerTool('xunji_extract_training_dna', {
    description: 'Extract training DNA without changing Xunji records. Saves local DNA history by default. Set persist to false to skip DNA history; ordinary day-cache reads and refreshes still apply.',
    inputSchema: { start_date: z.string(), end_date: z.string(), refresh_today: z.boolean().optional(), refresh_dates: z.array(z.string()).optional(), refresh_all: z.boolean().optional(), planned_sessions_per_week: z.number().finite().nonnegative().max(14).optional(), profile: z.record(z.string(), z.unknown()).optional(), persist: z.boolean().optional() },
    annotations: { readOnlyHint: false }
  }, (args) => result(service.getTrainingDNA(args)));
  return { server, service };
}

async function startStdioServer() {
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
  const { server } = createMcpServer();
  await server.connect(new StdioServerTransport());
}

if (require.main === module) {
  startStdioServer().catch(() => { process.exitCode = 1; });
}

module.exports = { createMcpServer, createTrainingService, currentShanghaiDate, dateRange, dateRangeChunks, startStdioServer };
