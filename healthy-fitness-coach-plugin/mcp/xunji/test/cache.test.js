'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const { FileCache, credentialFingerprint } = require('../src/cache.js');
const VALID_FINGERPRINT = 'a'.repeat(64);

test('file cache uses a one-way credential fingerprint and atomic date entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xunji-cache-test-'));
  try {
    const fingerprint = credentialFingerprint('FAKE_TEST_CREDENTIAL');
    assert.equal(fingerprint.includes('FAKE_TEST_CREDENTIAL'), false);
    const cache = new FileCache({ root, fingerprint });
    await cache.set('2026-08-01', { fetched_at: 1, records: [], warnings: [] });
    const value = await cache.get('2026-08-01');
    assert.equal(value.fetched_at, 1);
    const onDisk = await readFile(cache.pathFor('2026-08-01'), 'utf8');
    assert.equal(onDisk.includes('FAKE_TEST_CREDENTIAL'), false);
    await cache.delete('2026-08-01');
    assert.equal(await cache.get('2026-08-01'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cache rejects invalid dates and malformed entries before writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xunji-cache-test-'));
  try {
    const cache = new FileCache({ root, fingerprint: VALID_FINGERPRINT });
    await assert.rejects(cache.set('2026-02-30', { fetched_at: 1, records: [] }), { code: 'invalid_date' });
    await assert.rejects(cache.set('2026-08-01', { records: 'not-array' }), { code: 'cache_error' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('corrupt cache reads are cache_error rather than a network-miss signal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xunji-cache-test-'));
  try {
    const cache = new FileCache({ root, fingerprint: VALID_FINGERPRINT });
    await cache.set('2026-08-01', { fetched_at: 1, records: [], warnings: [] });
    await writeFile(cache.pathFor('2026-08-01'), '{corrupt', 'utf8');
    await assert.rejects(cache.get('2026-08-01'), { code: 'cache_error' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent writes use collision-safe temporary names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xunji-cache-test-'));
  try {
    const cache = new FileCache({ root, fingerprint: VALID_FINGERPRINT });
    await Promise.all(Array.from({ length: 20 }, (_, index) => cache.set('2026-08-01', { fetched_at: index, records: [], warnings: [] })));
    assert.ok(Number.isInteger((await cache.get('2026-08-01')).fetched_at));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cache retains safe operation metadata without credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xunji-cache-test-'));
  try {
    const cache = new FileCache({ root, fingerprint: VALID_FINGERPRINT });
    await cache.set('2026-08-01', { fetched_at: 1, records: [], warnings: [], last_operation: 'upsert' });
    assert.equal((await cache.get('2026-08-01')).last_operation, 'upsert');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cache rejects a fingerprint that could escape its account namespace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xunji-cache-test-'));
  try {
    assert.throws(() => new FileCache({ root, fingerprint: '../outside' }), { code: 'cache_error' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('writing a snapshot from an obsolete revision cannot recreate visible stale data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xunji-cache-test-'));
  const date = '2026-08-01';
  const old = { fetched_at: 1, records: [] };
  const fresh = { fetched_at: 2, records: [] };
  try {
    const writer = new FileCache({ root, fingerprint: VALID_FINGERPRINT });
    const reader = new FileCache({ root, fingerprint: VALID_FINGERPRINT });
    const snapshot = await reader.readSnapshot(date);
    await writer.withWriteRevision(date, async (revision) => {
      await writer.set(date, fresh, revision);
      return {};
    });
    assert.equal(await reader.saveSnapshot(date, old, snapshot), false);
    assert.equal(await reader.get(date), null);
    assert.equal((await reader.readSnapshot(date)).entry.fetched_at, 2);
    const activeSnapshot = await reader.readSnapshot(date);
    reader.set = async () => { throw new Error('blocked'); };
    await assert.rejects(reader.saveSnapshot(date, old, activeSnapshot), /blocked/);
    assert.throws(() => reader.pathFor(date, '../outside'), { code: 'cache_error' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed coordination completion leaves the latest epoch readable and reports the degraded state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xunji-cache-test-'));
  const date = '2026-08-01';
  try {
    const writer = new FileCache({ root, fingerprint: VALID_FINGERPRINT });
    const transition = writer.revisions.transition.bind(writer.revisions);
    writer.revisions.transition = async (key, version, value) => {
      if (value.cache_revision) throw new Error('disk busy');
      return transition(key, version, value);
    };
    const written = await writer.withWriteRevision(date, async (revision) => {
      await writer.set(date, { fetched_at: 2, records: [] }, revision);
      return { outcome: 'confirmed' };
    });
    assert.deepEqual(written, { outcome: 'confirmed', warnings: ['write_cache_coordination_failed'] });
    const reopened = new FileCache({ root, fingerprint: VALID_FINGERPRINT });
    assert.equal((await reopened.readSnapshot(date)).entry.fetched_at, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
