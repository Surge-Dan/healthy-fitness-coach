'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Script } = require('node:vm');

const skill = 'healthy-fitness-coach/references';
const xunji = 'healthy-fitness-coach-plugin/mcp/xunji/src';
const mutants = [
  {
    name: 'annual heatmap threshold',
    source: `${skill}/visuals.js`,
    original: 'if (totalDays > 90)',
    replacement: 'if (totalDays > 0)',
    observe: ({ renderTrainingHeatmapSvg }) => renderTrainingHeatmapSvg({
      dates: ['2026-01-01'], startDate: '2026-01-01', endDate: '2026-01-07'
    }).includes('data-heatmap="year"'),
    expected: false
  },
  {
    name: 'main exercise performance value',
    source: `${xunji}/trends.js`,
    original: 'const value = weight > 0 ? weight : volume > 0 ? volume : 0;',
    replacement: 'const value = 0;',
    observe: ({ analyzeTrainingRange }) => analyzeTrainingRange({
      dates: ['2026-08-01', '2026-08-02'],
      records: [
        { record_date: '2026-08-01', title: '卧推', sets: 3, reps: 8, weight: '60kg', volume: 1440 },
        { record_date: '2026-08-02', title: '卧推', sets: 3, reps: 8, weight: '62.5kg', volume: 1500 }
      ]
    }).exercise_performance.map(({ value }) => value),
    expected: [60, 62.5]
  },
  {
    name: 'visual input multi-photo routing',
    source: `${skill}/visual-dna.js`,
    original: 'if (photoCount > 1)',
    replacement: 'if (photoCount > 99)',
    observe: ({ routeVisualInput }) => routeVisualInput({ photos: ['a.jpg', 'b.jpg'] }).kind,
    expected: 'multi-photo'
  },
  {
    name: 'derived prompt forbids generated numbers',
    source: `${skill}/visual-prompt-compiler.js`,
    original: 'No text. No letters. No numbers.',
    replacement: 'No text. No letters.',
    observe: ({ compileDerivedLayerPrompt }) => compileDerivedLayerPrompt({}).prompt.includes('No numbers.'),
    expected: true
  },
  {
    name: 'write-back rejects mixed dates',
    source: `${xunji}/upsert.js`,
    original: "if (parsed.some((record) => record.date !== date)) throw connectorError('mixed_dates');",
    replacement: '',
    observe: ({ validateUpsertRecords }) => {
      try {
        validateUpsertRecords(['2026-08-01,id:1,胸部训练', '2026-08-02,id:2,背部训练']);
        return 'accepted';
      } catch (error) {
        if (error.code !== 'mixed_dates') throw error;
        return error.code;
      }
    },
    expected: 'mixed_dates'
  },
  {
    name: 'write-back requires explicit confirmation',
    source: `${xunji}/server.js`,
    original: 'if (confirm !== true) return',
    replacement: 'if (false) return',
    observe: async ({ createTrainingService }) => {
      let networkCalls = 0;
      const service = createTrainingService({
        cache: { get: async () => null, set: async () => {} },
        credentialProvider: async () => 'MUTATION_SYNTHETIC_CREDENTIAL',
        client: {
          upsertRecords: async () => { networkCalls += 1; return { records: [] }; }
        }
      });
      const records = ['2026-08-01,id:1,胸部训练'];
      const { preview_id } = await service.previewTrainingUpsert({ records });
      const response = await service.upsertTrainingRecords({ records, preview_id });
      return [response.outcome, response.error?.code, networkCalls];
    },
    expected: ['not_submitted', 'writeback_not_confirmed', 0]
  },
  {
    name: 'current red flag outranks prior history',
    source: `${skill}/safety-context.js`,
    original: "let next = 'stop';",
    replacement: "let next = 'clarify';",
    observe: ({ inspectSafety }) => inspectSafety({
      instruction: '上周有气短，但今天胸部压迫感明显'
    }).status,
    expected: 'stop'
  },
  {
    name: 'resuming a training plan requires boolean confirmation',
    source: `${skill}/training-continuity.js`,
    original: 'return state_confirmed === true && Number.isFinite(Number(now))',
    replacement: 'return Boolean(state_confirmed) && Number.isFinite(Number(now))',
    observe: ({ assessResume, createCheckpoint }) => {
      const snapshot = createCheckpoint({
        updated_at: '2026-11-24T09:00:00+08:00',
        valid_until: '2026-11-24T23:59:59+08:00'
      });
      return assessResume(snapshot, { now: Date.parse('2026-11-24T12:00:00+08:00'), state_confirmed: 'false' }).status;
    },
    expected: 'confirm_current_state'
  },
  {
    name: 'a stale read cannot replace a confirmed server write',
    source: `${xunji}/server.js`,
    original: 'if ((dayVersions.get(key) || 0) !== version) return { superseded: true };',
    replacement: '',
    observe: async ({ createTrainingService }) => {
      const date = '2026-10-20';
      const old = [`${date},id:1,胸部训练,1.卧推,1组,60kg,10次,source:xunji`];
      const records = [`${date},id:2,胸部训练,1.卧推,1组,65kg,10次,source:xunji`];
      let resolveStarted;
      let resolveRead;
      const started = new Promise((resolve) => { resolveStarted = resolve; });
      const release = new Promise((resolve) => { resolveRead = resolve; });
      let cacheEntry;
      const service = createTrainingService({
        cache: { get: async () => cacheEntry, set: async (_date, entry) => { cacheEntry = entry; } },
        credentialProvider: async () => 'MUTATION_SYNTHETIC_CREDENTIAL',
        client: {
          async fetchDay() { resolveStarted(); await release; return { records: old }; },
          async upsertRecords() { return { records }; }
        }
      });
      const reading = service.getTrainingDay({ date });
      await started;
      const { preview_id } = await service.previewTrainingUpsert({ records });
      const written = await service.upsertTrainingRecords({ records, preview_id, confirm: true });
      resolveRead();
      const concurrent = await reading;
      const cached = await service.getTrainingDay({ date });
      return [written.outcome, concurrent.records?.[0]?.id, cached.records?.[0]?.id];
    },
    expected: ['confirmed', '2', '2']
  },
  {
    name: 'confirmed write remains confirmed during reconciliation',
    source: `${xunji}/server.js`,
    original: "if (submission === 'confirmed') return { outcome: 'confirmed', writeback: false, confirmed_at: entry.confirmed_at };",
    replacement: '',
    observe: async ({ createTrainingService }) => {
      const records = ['2026-10-20,id:1,胸部训练,1.卧推,1组,60kg,10次,source:xunji'];
      let reads = 0;
      let writes = 0;
      const service = createTrainingService({
        cache: { get: async () => null, set: async () => {} },
        credentialProvider: async () => 'MUTATION_SYNTHETIC_CREDENTIAL',
        client: {
          async fetchDay() { reads += 1; return { records }; },
          async upsertRecords() { writes += 1; return { records }; }
        }
      });
      const { preview_id } = await service.previewTrainingUpsert({ records });
      const written = await service.upsertTrainingRecords({ records, preview_id, confirm: true });
      const reconciled = await service.reconcileTrainingUpsert({ records });
      return [written.outcome, reconciled.outcome, reconciled.verification_id, reads, writes];
    },
    expected: ['confirmed', 'confirmed', undefined, 0, 1]
  },
  {
    name: 'an unchanged DNA result retains the saved version',
    source: `${xunji}/server.js`,
    original: 'version = savedVersion;',
    replacement: 'version = 1;',
    observe: async ({ createTrainingService }) => {
      let artifact;
      let saveCount = 0;
      const values = new Map();
      const service = createTrainingService({
        cache: { get: async (date) => values.get(date), set: async (date, entry) => values.set(date, entry) },
        credentialProvider: async () => 'MUTATION_SYNTHETIC_CREDENTIAL',
        dnaStore: {
          async get() { return artifact; },
          async set(value) { artifact = value; saveCount += 1; }
        },
        client: { async fetchDay(date) { return { records: [`${date},id:${date},卧推,1组,60kg,8次`] }; } }
      });
      const first = await service.getTrainingDNA({ start_date: '2026-08-01', end_date: '2026-08-01' });
      const range = { start_date: '2026-08-01', end_date: '2026-08-02' };
      const [second, repeated] = await Promise.all([service.getTrainingDNA(range), service.getTrainingDNA(range)]);
      return [[first, second, repeated].map((result) => result.training_dna?.version), saveCount];
    },
    expected: [[1, 2, 2], 2]
  }
];

async function probe(mutant, mode) {
  const path = join(__dirname, '..', mutant.source);
  let product;
  if (mode === 'mutant') {
    const source = readFileSync(path, 'utf8');
    if (source.split(mutant.original).length !== 2) {
      return { status: 'mutation_error', error: 'Mutation must replace exactly one source fragment' };
    }
    const mutated = source.replace(mutant.original, () => mutant.replacement);
    try {
      new Script(mutated, { filename: path });
    } catch (error) {
      return { status: 'syntax_error', error: error.message };
    }

    // Keep the actual module path so relative imports and package dependencies
    // resolve identically to the control run. The hook lives in this worker.
    const loadJs = require.extensions['.js'];
    require.extensions['.js'] = (module, filename) => {
      if (filename === path) return module._compile(mutated, filename);
      return loadJs(module, filename);
    };
    try {
      product = require(path);
    } catch (error) {
      return { status: 'load_error', error: error.message };
    } finally {
      require.extensions['.js'] = loadJs;
    }
  } else {
    try {
      product = require(path);
    } catch (error) {
      return { status: 'load_error', error: error.message };
    }
  }

  let observed;
  try {
    observed = await mutant.observe(product);
  } catch (error) {
    return { status: 'execution_error', error: error.message };
  }
  try {
    assert.deepEqual(observed, mutant.expected);
    return { status: 'pass' };
  } catch (error) {
    return { status: 'assertion_failure', error: error.message };
  }
}

function runProbe(index, mode) {
  const child = spawnSync(process.execPath, [__filename, '--probe', String(index), mode], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true
  });
  if (child.error?.code === 'ETIMEDOUT') return { status: 'timeout' };
  if (child.error || child.status !== 0) {
    return { status: 'worker_error', error: child.stderr?.trim() || child.error?.message || child.signal };
  }
  try {
    return JSON.parse(child.stdout);
  } catch {
    return { status: 'worker_error', error: 'Worker did not return a result' };
  }
}

if (process.argv[2] === '--probe') {
  probe(mutants[Number(process.argv[3])], process.argv[4]).then((result) => {
    process.stdout.write(JSON.stringify(result));
  }).catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
} else {
  let killed = 0;
  for (const [index, mutant] of mutants.entries()) {
    const control = runProbe(index, 'control');
    if (control.status !== 'pass') {
      console.error(`CONTROL FAILED ${mutant.name} [${control.status}] ${control.error || ''}`);
      continue;
    }
    const result = runProbe(index, 'mutant');
    if (result.status === 'assertion_failure') {
      killed += 1;
      console.log(`KILLED ${mutant.name}`);
    } else if (result.status === 'pass') {
      console.error(`SURVIVED ${mutant.name}`);
    } else {
      console.error(`INVALID ${mutant.name} [${result.status}] ${result.error || ''}`);
    }
  }
  console.log(`Critical mutants killed by behavior assertions: ${killed}/${mutants.length}`);
  if (killed !== mutants.length) process.exitCode = 1;
}
