'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { OperationStore, processIsAlive } = require('../src/operation-store.js');

test('independent journal instances cannot advance the same version twice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fitness-operations-'));
  try {
    const first = new OperationStore(root);
    const second = new OperationStore(root);
    const key = '1'.repeat(64);
    const initial = { outcome: 'unknown', version: randomUUID() };
    assert.equal(await first.transition(key, null, initial), true);
    const transitions = ['confirmed', 'not_submitted'].map((outcome) => ({ outcome, version: randomUUID() }));
    const results = await Promise.all([
      first.transition(key, initial.version, transitions[0]),
      second.transition(key, initial.version, transitions[1])
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.deepEqual(await first.get(key), transitions[results.indexOf(true)]);
    assert.equal(await second.transition(key, initial.version, transitions[0]), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a cyclic journal fails closed when loaded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fitness-operations-'));
  try {
    const journal = new OperationStore(root);
    const key = '2'.repeat(64);
    const state = { outcome: 'unknown', version: randomUUID() };
    await writeFile(journal.path(key), JSON.stringify(state));
    await writeFile(journal.path(key, state.version), JSON.stringify(state));
    await assert.rejects(journal.get(key), { code: 'cache_error' });
    assert.throws(() => journal.path(key, '../outside'));
    const obstructed = join(root, 'non-directory');
    await writeFile(obstructed, '');
    const blocked = new OperationStore(obstructed);
    await assert.rejects(blocked.transition(key, null, state));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an exited writer can be distinguished from a live or invalid PID', async () => {
  assert.equal(processIsAlive(process.pid), true);
  assert.equal(processIsAlive(undefined), true);
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await once(child, 'exit');
  assert.equal(processIsAlive(child.pid), false);
});
