'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { connectorError } = require('./errors.js');

const versionOf = (entry) => entry ? (entry.version || 'legacy') : null;

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

class OperationStore {
  constructor(root) { this.root = root; }

  path(key, version = null) {
    if (!/^[a-f0-9]{64}$/.test(key) || (version && !/^(legacy|[a-f0-9-]{36})$/.test(version)))
      throw new Error('Invalid operation key or version');
    return join(this.root, version ? `${key}.${version}.json` : `${key}.json`);
  }

  async get(key) {
    let previous = null;
    const seen = new Set();
    while (true) {
      try {
        previous = JSON.parse(await fs.readFile(this.path(key, versionOf(previous)), 'utf8'));
        const version = versionOf(previous);
        if (!previous || typeof previous !== 'object' || Array.isArray(previous) || seen.has(version))
          throw connectorError('cache_error');
        seen.add(version);
      } catch (error) {
        if (error.code === 'ENOENT') return previous;
        throw error;
      }
    }
  }

  async transition(key, expectedVersion, value) {
    if (versionOf(await this.get(key)) !== expectedVersion) return false;
    const destination = this.path(key, expectedVersion);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await fs.mkdir(this.root, { recursive: true });
    try {
      await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      // Each version has exactly one successor. Publishing a complete file
      // with a hard link makes the compare-and-set exclusive across processes.
      await fs.link(temporary, destination);
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
}

function memoryOperationStore() {
  const entries = new Map();
  return {
    async get(key) { return entries.get(key) || null; },
    async transition(key, expectedVersion, value) {
      if (versionOf(entries.get(key)) !== expectedVersion) return false;
      entries.set(key, value);
      return true;
    }
  };
}

module.exports = { OperationStore, memoryOperationStore, processIsAlive, versionOf };
