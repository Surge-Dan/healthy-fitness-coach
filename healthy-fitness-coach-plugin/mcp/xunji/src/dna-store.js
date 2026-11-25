'use strict';

const { randomBytes } = require('node:crypto');
const { mkdir, readFile, rename, rm, writeFile } = require('node:fs/promises');
const { dirname, join, resolve, sep } = require('node:path');
const { connectorError } = require('./errors.js');

class FileDNAStore {
  constructor({ root, fingerprint }) {
    this.root = resolve(root);
    this.fingerprint = String(fingerprint);
    if (!/^[a-f0-9]{64}$/.test(this.fingerprint)) throw connectorError('cache_error');
  }

  path() {
    const destination = resolve(this.root, `${this.fingerprint}.json`);
    if (!destination.startsWith(`${this.root}${sep}`)) throw connectorError('cache_error');
    return destination;
  }

  async get() {
    try {
      return JSON.parse(await readFile(this.path(), 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw connectorError('cache_error');
    }
  }

  async writeAtomically(destination, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw connectorError('cache_error');
    const temporary = `${destination}.${process.pid}.${Date.now()}.${randomBytes(12).toString('hex')}.tmp`;
    try {
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw connectorError('cache_error');
    }
  }

  async enqueue(action) {
    const destination = this.path();
    const prior = FileDNAStore.pending.get(destination) || Promise.resolve();
    const operation = prior.catch(() => {}).then(() => action(destination));
    FileDNAStore.pending.set(destination, operation);
    try { return await operation; } finally { if (FileDNAStore.pending.get(destination) === operation) FileDNAStore.pending.delete(destination); }
  }

  async update(transform) {
    await this.enqueue(async (destination) => {
      const next = transform(await this.get());
      if (next !== undefined) await this.writeAtomically(destination, next);
    });
  }

  async set(value) {
    await this.enqueue((destination) => this.writeAtomically(destination, value));
  }
}

FileDNAStore.pending = new Map();

module.exports = { FileDNAStore };
