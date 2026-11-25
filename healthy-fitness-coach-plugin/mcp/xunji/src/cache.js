'use strict';

const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { mkdir, readFile, rename, rm, writeFile } = require('node:fs/promises');
const { dirname, join, resolve, sep } = require('node:path');
const { connectorError } = require('./errors.js');
const { OperationStore, processIsAlive, versionOf } = require('./operation-store.js');
const { assertCacheEntry, assertDate } = require('./schemas.js');

function credentialFingerprint(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

const activeWrites = new Set();

function isWriting(revision) {
  if (!revision?.writer_pid) return false;
  return revision.writer_pid === process.pid ? activeWrites.has(revision.version) : processIsAlive(revision.writer_pid);
}

class FileCache {
  constructor({ root, fingerprint }) {
    this.root = resolve(root);
    this.fingerprint = String(fingerprint);
    if (!/^[a-f0-9]{64}$/.test(this.fingerprint)) throw connectorError('cache_error');
    this.writeQueues = new Map();
    this.revisions = new OperationStore(join(this.root, this.fingerprint, 'day-revisions'));
  }

  pathFor(date, revision = null) {
    assertDate(date);
    const [year, month] = date.split('-');
    if (revision && !/^[a-f0-9-]{36}$/.test(revision)) throw connectorError('cache_error');
    return join(this.root, this.fingerprint, year, month, `${date}${revision ? `.${revision}` : ''}.json`);
  }

  async get(date, revision) {
    try {
      const content = await readFile(this.pathFor(date, revision), 'utf8');
      return assertCacheEntry(JSON.parse(content));
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      if (error && error.code === 'invalid_date') throw error;
      throw connectorError('cache_error');
    }
  }

  async set(date, entry, revision) {
    const validated = assertCacheEntry(entry);
    const destination = this.pathFor(date, revision);
    const previous = this.writeQueues.get(destination) || Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.writeAtomically(destination, validated));
    this.writeQueues.set(destination, operation);
    try {
      await operation;
    } finally {
      if (this.writeQueues.get(destination) === operation) this.writeQueues.delete(destination);
    }
  }

  async withWriteRevision(date, action) {
    const key = credentialFingerprint(assertDate(date));
    const previous = await this.revisions.get(key);
    if (isWriting(previous)) throw connectorError('date_write_in_progress');
    const version = randomUUID();
    activeWrites.add(version);
    try {
      const started = await this.revisions.transition(key, versionOf(previous), { version, writer_pid: process.pid });
      if (!started) throw connectorError('date_write_in_progress');
      const result = await action(version);
      const finished = await this.revisions.transition(key, version, { version: randomUUID(), cache_revision: version }).catch(() => false);
      if (!finished) result.warnings = [...(result.warnings || []), 'write_cache_coordination_failed'];
      await this.delete(date, previous?.cache_revision || versionOf(previous)).catch(() => {});
      return result;
    } finally {
      activeWrites.delete(version);
    }
  }

  async readSnapshot(date, ignoreEntry) {
    const key = credentialFingerprint(assertDate(date));
    while (true) {
      const revision = await this.revisions.get(key);
      if (isWriting(revision)) throw connectorError('date_write_in_progress');
      const version = versionOf(revision);
      const cacheRevision = revision?.cache_revision || version;
      const entry = ignoreEntry ? null : await this.get(date, cacheRevision);
      if (await this.isSnapshotCurrent(date, version)) return { entry, version, cacheRevision };
    }
  }

  async isSnapshotCurrent(date, version) {
    return versionOf(await this.revisions.get(credentialFingerprint(assertDate(date)))) === version;
  }

  async saveSnapshot(date, entry, snapshot) {
    // Obsolete reads can only write their own epoch, even if another process
    // publishes a newer epoch between the version check and the disk write.
    let failure;
    try {
      await this.set(date, entry, snapshot.cacheRevision);
    } catch (error) {
      failure = error;
    }
    const current = await this.revisions.get(credentialFingerprint(date));
    if (versionOf(current) !== snapshot.version) {
      // Completing a previously interrupted write may publish the same cache
      // revision. Leave it intact unless this read's file is actually obsolete.
      if ((current?.cache_revision || versionOf(current)) !== snapshot.cacheRevision)
        await this.delete(date, snapshot.cacheRevision).catch(() => {});
      return false;
    }
    if (failure) throw failure;
    return true;
  }

  async writeAtomically(destination, validated) {
    const directory = dirname(destination);
    const temporary = `${destination}.${process.pid}.${Date.now()}.${randomBytes(12).toString('hex')}.tmp`;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, JSON.stringify(validated), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw connectorError('cache_error');
    }
  }

  async delete(date, revision) {
    await rm(this.pathFor(date, revision), { force: true }).catch(() => { throw connectorError('cache_error'); });
  }

  async deleteAll() {
    const target = resolve(this.root, this.fingerprint);
    if (!target.startsWith(`${this.root}${sep}`)) throw connectorError('cache_error');
    await rm(target, { recursive: true, force: true }).catch(() => { throw connectorError('cache_error'); });
  }
}

module.exports = { credentialFingerprint, FileCache };
