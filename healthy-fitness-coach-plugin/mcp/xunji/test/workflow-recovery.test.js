 'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTrainingService } = require('../src/server.js');
const { OperationStore } = require('../src/operation-store.js');
const { FileCache, credentialFingerprint } = require('../src/cache.js');
const records = ['2026-10-20,id:1,胸部训练,1.卧推,1组,60kg,10次,source:xunji'];
function cache() { const m=new Map(); return {async get(d){return m.get(d);},async set(d,v){m.set(d,v);}}; }
function fixture(options={}) {
 let clock=Date.parse('2026-10-21T01:00:00Z'), calls=0, reads=0;
 const service=createTrainingService({cache:cache(),credentialProvider:async()=>'SYNTHETIC_ACCOUNT_A',now:()=>clock,today:()=> '2026-10-21',client:{async fetchDay(){reads++;return {records};},async upsertRecords(){calls++;return {records};}},...options});
 return {service,advance(ms){clock+=ms;},get calls(){return calls;},get reads(){return reads;}};
}
async function submit(service, data=records) {const preview=await service.previewTrainingUpsert({records:data});return service.upsertTrainingRecords({records:data,confirm:true,preview_id:preview.preview_id});}
test('write requires matching preview; changed data and expired previews never reach network', async()=>{
 const f=fixture();
 assert.equal((await f.service.upsertTrainingRecords({records,confirm:true})).error.code,'preview_required');
 const p=await f.service.previewTrainingUpsert({records});
 assert.equal((await f.service.upsertTrainingRecords({records:['2026-10-20,id:2,title'],confirm:true,preview_id:p.preview_id})).error.code,'preview_required');
 f.advance(600001);
 assert.equal((await f.service.upsertTrainingRecords({records,confirm:true,preview_id:p.preview_id})).error.code,'preview_required');assert.equal(f.calls,0);
});
test('two confirmed previews for same batch yield only one network write',async()=>{
 const f=fixture(); const a=await f.service.previewTrainingUpsert({records}),b=await f.service.previewTrainingUpsert({records});
 const results=await Promise.all([a,b].map(p=>f.service.upsertTrainingRecords({records,confirm:true,preview_id:p.preview_id})));
 assert.equal(f.calls,1);assert.ok(results.some(r=>r.outcome==='confirmed'));assert.ok(results.some(r=>r.outcome==='reconciliation_required'));
});
test('confirmed server write remains confirmed after cache failure',async()=>{
 const f=fixture({cache:{async get(){return null;},async set(){throw new Error('disk');}}});
 const r=await submit(f.service);assert.equal(r.outcome,'confirmed');assert.equal(r.cache_saved,false);
 assert.equal((await submit(f.service)).outcome,'reconciliation_required');assert.equal(f.calls,1);
});
test('timeout blocks replay; fresh reconciliation and explicit user resolution permit a new preview',async()=>{
 let calls=0,reads=0;
 const f=fixture({client:{async upsertRecords(){calls++;throw Object.assign(new Error('timeout'),{code:'network_error'});},async fetchDay(){reads++;return {records:[]};}}});
 assert.equal((await submit(f.service)).outcome,'unknown');assert.equal((await submit(f.service)).outcome,'reconciliation_required');assert.equal(calls,1);
 assert.equal((await f.service.reconcileTrainingUpsert({records,confirm_not_applied:true})).outcome,'unknown');
 const proof=await f.service.reconcileTrainingUpsert({records}); assert.equal(reads,1);assert.ok(proof.verification_id);
 assert.equal((await f.service.reconcileTrainingUpsert({records,verification_id:proof.verification_id,confirm_not_applied:true})).outcome,'verified_not_applied');
 assert.equal((await submit(f.service)).outcome,'unknown');assert.equal(calls,2);
});
test('account change invalidates a preview',async()=>{
 let account='SYNTHETIC_A';const f=fixture({credentialProvider:async()=>account});
 const p=await f.service.previewTrainingUpsert({records});account='SYNTHETIC_B';
 assert.equal((await f.service.upsertTrainingRecords({records,confirm:true,preview_id:p.preview_id})).error.code,'preview_required');assert.equal(f.calls,0);
});
test('historical correction can refresh only the requested date and respects throttle',async()=>{
 const f=fixture();await f.service.getTrainingDay({date:'2026-10-20'});f.advance(91000);
 const r=await f.service.getTrainingRange({start_date:'2026-10-20',end_date:'2026-10-20',refresh_dates:['2026-10-20']});
 assert.equal(r.network_fetches,1);assert.equal(f.reads,2);
 assert.equal((await f.service.getTrainingRange({start_date:'2026-10-20',end_date:'2026-10-20',refresh_all:true})).error.code,'rate_limited');
});
test('recent window expires after five minutes without explicit refresh',async()=>{
 const f=fixture();await f.service.getTrainingDay({date:'2026-10-20'});f.advance(300001);
 const r=await f.service.getTrainingDay({date:'2026-10-20'});assert.equal(r.cache_hit,false);assert.equal(f.reads,2);
});
test('durable unknown submission survives service restart without training payload in journal',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'fitness-operations-'));
 try {
  let calls=0;const client={async upsertRecords(){calls++;throw new Error('timeout');}};
  const a=fixture({operationStore:new OperationStore(root),client});await submit(a.service);
  const b=fixture({operationStore:new OperationStore(root),client});assert.equal((await submit(b.service)).outcome,'reconciliation_required');assert.equal(calls,1);
  const files=await fs.readdir(root);const body=await fs.readFile(path.join(root,files[0]),'utf8');assert.equal(body.includes('SYNTHETIC'),false);assert.equal(body.includes('60kg'),false);
 } finally {await fs.rm(root,{recursive:true,force:true});}
});

const date = '2026-10-20';
const changed = ['2026-10-20,id:2,胸部训练,1.卧推,1组,65kg,10次,source:xunji'];

function createdRecords(batch) {
  return batch.map((row, index) => row.replace(`${date},`, `${date},id:new-${index + 1},`));
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('a read started before a confirmed write returns the winning cache entry', async () => {
  const started = deferred();
  const release = deferred();
  const { service } = fixture({
    client: {
      async fetchDay() {
        started.resolve();
        await release.promise;
        return { records };
      },
      async upsertRecords() { return { records: changed }; }
    }
  });
  const reading = service.getTrainingDay({ date });
  await started.promise;
  const written = await submit(service, changed);
  release.resolve();
  assert.equal(written.outcome, 'confirmed');
  assert.deepEqual((await reading).records.map((record) => record.id), ['2']);
  assert.deepEqual((await service.getTrainingDay({ date })).records.map((record) => record.id), ['2']);
});

test('a read begun during a write waits for the winning same-day cache entry', async () => {
  const started = deferred();
  const release = deferred();
  let reads = 0;
  const { service } = fixture({
    client: {
      async fetchDay() { reads += 1; return { records }; },
      async upsertRecords() {
        started.resolve();
        await release.promise;
        return { records: changed };
      }
    }
  });
  const writing = submit(service, changed);
  await started.promise;
  const reading = service.getTrainingDay({ date });
  await new Promise(setImmediate);
  release.resolve();
  assert.equal((await writing).outcome, 'confirmed');
  assert.deepEqual((await reading).records.map((record) => record.id), ['2']);
  assert.equal(reads, 0);
});

test('confirmed write with a failed cache update invalidates a readable old snapshot', async () => {
  const store = cache();
  const set = store.set;
  let reads = 0;
  const { service } = fixture({
    cache: store,
    client: {
      async fetchDay() { reads += 1; return { records: reads === 1 ? records : changed }; },
      async upsertRecords() { return { records: changed }; }
    }
  });
  await service.getTrainingDay({ date });
  store.set = async () => { throw new Error('disk'); };
  const written = await submit(service, changed);
  assert.equal(written.outcome, 'confirmed');
  assert.equal(written.cache_saved, false);
  const checked = await service.getTrainingDay({ date });
  assert.deepEqual(checked.records.map((record) => record.id), ['2']);
  assert.equal(reads, 2);
  assert.ok(checked.warnings.includes('read_cache_save_failed'));
  store.set = set;
  await service.getTrainingDay({ date });
  assert.equal((await service.getTrainingDay({ date })).cache_hit, true);
  assert.equal(reads, 3);
});

test('different writes for the same day send in order and retain the latest result', async () => {
  const started = deferred();
  const release = deferred();
  const sent = [];
  const { service } = fixture({
    client: {
      async upsertRecords(batch) {
        sent.push(batch);
        if (batch[0] === records[0]) {
          started.resolve();
          await release.promise;
        }
        return { records: batch };
      }
    }
  });
  const first = submit(service, records);
  await started.promise;
  const second = submit(service, changed);
  await new Promise(setImmediate);
  const callsWhileFirstWasPending = sent.length;
  release.resolve();
  const results = await Promise.all([first, second]);
  assert.equal(callsWhileFirstWasPending, 1);
  assert.deepEqual(results.map((result) => result.outcome), ['confirmed', 'confirmed']);
  assert.deepEqual(sent, [records, changed]);
  assert.deepEqual((await service.getTrainingDay({ date })).records.map((record) => record.id), ['2']);
});

test('a confirmed operation never issues a proof or allows another send', async () => {
  const f = fixture();
  const { service } = f;
  assert.equal((await submit(service)).outcome, 'confirmed');
  const verification = await service.reconcileTrainingUpsert({ records });
  assert.equal(verification.outcome, 'confirmed');
  assert.equal(verification.verification_id, undefined);
  assert.equal(f.reads, 0);
  assert.equal((await submit(service)).outcome, 'reconciliation_required');
  assert.equal(f.calls, 1);
});

test('an in-flight write cannot be cleared in a second service sharing the journal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fitness-operations-'));
  const started = deferred();
  const release = deferred();
  try {
    let reads = 0;
    const client = {
      async upsertRecords() {
        started.resolve();
        await release.promise;
        return { records };
      },
      async fetchDay() { reads += 1; return { records: [] }; }
    };
    const first = fixture({ operationStore: new OperationStore(root), client });
    const second = fixture({ operationStore: new OperationStore(root), client });
    const writing = submit(first.service);
    await started.promise;
    try {
      const verification = await second.service.reconcileTrainingUpsert({ records });
      assert.equal(verification.outcome, 'submitting');
      assert.equal(verification.verification_id, undefined);
      assert.equal(reads, 0);
    } finally {
      release.resolve();
      assert.equal((await writing).outcome, 'confirmed');
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('only one proof can clear an unknown attempt and stale proofs cannot clear its successor', async () => {
  const { service } = fixture({
    client: {
      async fetchDay() { return { records: [] }; },
      async upsertRecords() { throw new Error('timeout'); }
    }
  });
  await submit(service);
  const first = await service.reconcileTrainingUpsert({ records });
  const second = await service.reconcileTrainingUpsert({ records });
  const extra = await service.reconcileTrainingUpsert({ records });
  const stalePreview = await service.previewTrainingUpsert({ records });
  const clear = (proof) => service.reconcileTrainingUpsert({ records, verification_id: proof.verification_id, confirm_not_applied: true });
  const cleared = await Promise.all([clear(first), clear(second)]);
  assert.equal(cleared.filter((result) => result.outcome === 'verified_not_applied').length, 1);
  assert.equal((await service.upsertTrainingRecords({ records, confirm: true, preview_id: stalePreview.preview_id })).error.code, 'preview_required');
  assert.equal((await submit(service)).outcome, 'unknown');
  assert.equal((await clear(extra)).error.code, 'reconciliation_required');
  assert.equal((await submit(service)).outcome, 'reconciliation_required');
});

test('reordering the same batch requires its own preview and cannot resend that batch', async () => {
  const sent = [];
  const { service } = fixture({
    client: {
      async upsertRecords(batch) { sent.push(batch); return { records: createdRecords(batch) }; }
    }
  });
  const batch = [`${date},深蹲,train_time:08:00`, `${date},深蹲,train_time:09:00`];
  const reordered = [...batch].reverse();
  const preview = await service.previewTrainingUpsert({ records: batch });
  const wrongPreview = await service.upsertTrainingRecords({ records: reordered, confirm: true, preview_id: preview.preview_id });
  assert.equal(wrongPreview.error.code, 'preview_required');
  assert.equal((await service.upsertTrainingRecords({ records: batch, confirm: true, preview_id: preview.preview_id })).outcome, 'confirmed');
  assert.equal((await submit(service, reordered)).outcome, 'reconciliation_required');
  const separateNewRecord = [`${date},深蹲,train_time:10:00`];
  assert.equal((await submit(service, separateNewRecord)).outcome, 'confirmed');
  assert.deepEqual(sent, [batch, separateNewRecord]);
});

test('multiple update rows for the same ID fail before any submission', async () => {
  const f = fixture();
  const batch = [`${date},id:1,早上`, `${date},id:1,晚上`];
  const preview = await f.service.previewTrainingUpsert({ records: batch });
  assert.equal(preview.error?.code, 'invalid_upsert');
  assert.equal(f.calls, 0);
});

test('an upsert response missing the requested existing ID remains unconfirmed', async () => {
  const f = fixture({ client: { async upsertRecords() { return { records: changed }; } } });
  const result = await submit(f.service, records);
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.error.code, 'writeback_unknown');
  assert.equal((await submit(f.service, records)).outcome, 'reconciliation_required');
});

test('a same-day response with an unrelated row cannot confirm a new-record request', async () => {
  const f = fixture({ client: { async upsertRecords() { return { records: changed }; } } });
  const result = await submit(f.service, [`${date},散步,train_time:16:00`]);
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.error.code, 'writeback_unknown');
});

test('a read in another service sharing FileCache cannot replace a confirmed write', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fitness-cache-'));
  const started = deferred();
  const release = deferred();
  const cacheOptions = { root, fingerprint: credentialFingerprint('SYNTHETIC_ACCOUNT_A') };
  try {
    const reader = fixture({
      cache: new FileCache(cacheOptions),
      client: {
        async fetchDay() {
          started.resolve();
          await release.promise;
          return { records };
        }
      }
    });
    const writer = fixture({
      cache: new FileCache(cacheOptions),
      client: { async upsertRecords() { return { records: changed }; } }
    });
    const reading = reader.service.getTrainingDay({ date });
    await started.promise;
    try {
      assert.equal((await submit(writer.service, changed)).outcome, 'confirmed');
    } finally {
      release.resolve();
      const result = await reading;
      assert.deepEqual(result.records.map((record) => record.id), ['2']);
    }
    assert.deepEqual((await reader.service.getTrainingDay({ date })).records.map((record) => record.id), ['2']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('another connector instance cannot submit a different write during an active same-day write', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fitness-cache-'));
  const started = deferred();
  const release = deferred();
  const options = { root, fingerprint: credentialFingerprint('SYNTHETIC_ACCOUNT_A') };
  const first = fixture({
    cache: new FileCache(options),
    client: { async upsertRecords() { started.resolve(); await release.promise; return { records }; } }
  });
  const second = fixture({
    cache: new FileCache(options),
    client: { async upsertRecords() { return { records: changed }; } }
  });
  const writing = submit(first.service);
  await started.promise;
  try {
    assert.equal((await second.service.getTrainingDay({ date })).error.code, 'date_write_in_progress');
    const blocked = await submit(second.service, changed);
    assert.equal(blocked.outcome, 'not_submitted');
    assert.equal(blocked.error.code, 'date_write_in_progress');
  } finally {
    release.resolve();
    await writing;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a new service rechecks a confirmed day when the revised file could not be saved', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fitness-cache-'));
  const options = { root, fingerprint: credentialFingerprint('SYNTHETIC_ACCOUNT_A') };
  try {
    const cache = new FileCache(options);
    const writer = fixture({
      cache,
      client: {
        async fetchDay() { return { records }; },
        async upsertRecords() { return { records: changed }; }
      }
    });
    await writer.service.getTrainingDay({ date });
    cache.set = async () => { throw new Error('disk denied this date entry'); };
    const written = await submit(writer.service, changed);
    assert.equal(written.outcome, 'confirmed');
    assert.equal(written.cache_saved, false);
    const reader = fixture({
      cache: new FileCache(options),
      client: { async fetchDay() { return { records: changed }; } }
    });
    const checked = await reader.service.getTrainingDay({ date });
    assert.deepEqual(checked.records.map((record) => record.id), ['2']);
    assert.equal(checked.network_fetches, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('recovery reads the old exact digest and refuses expired or other-account proofs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fitness-operations-'));
  const batch = [`${date},散步,train_time:09:00`, `${date},散步,train_time:08:00`];
  let credential = 'SYNTHETIC_ACCOUNT_A';
  const legacyDigest = createHash('sha256')
    .update(JSON.stringify([credentialFingerprint(credential), batch])).digest('hex');
  try {
    const journal = new OperationStore(root);
    await fs.writeFile(journal.path(legacyDigest), JSON.stringify({ outcome: 'unknown', date, submitted_at: 1 }));
    let sends = 0;
    const f = fixture({
      operationStore: journal,
      credentialProvider: async () => credential,
      client: {
        async fetchDay() { return { records: [] }; },
        async upsertRecords(batch) { sends += 1; return { records: createdRecords(batch) }; }
      }
    });
    assert.equal((await submit(f.service, batch)).outcome, 'reconciliation_required');
    assert.equal(sends, 0);
    const clear = (proof) => f.service.reconcileTrainingUpsert({ records: batch, verification_id: proof.verification_id, confirm_not_applied: true });
    const proof = await f.service.reconcileTrainingUpsert({ records: batch });
    credential = 'SYNTHETIC_ACCOUNT_B';
    assert.equal((await clear(proof)).error.code, 'reconciliation_required');
    credential = 'SYNTHETIC_ACCOUNT_A';
    f.advance(300001);
    assert.equal((await clear(proof)).error.code, 'reconciliation_required');
    const renewed = await f.service.reconcileTrainingUpsert({ records: batch });
    assert.equal((await clear(renewed)).outcome, 'verified_not_applied');
    assert.equal((await submit(f.service, batch)).outcome, 'confirmed');
    assert.equal((await submit(f.service, [...batch].reverse())).outcome, 'reconciliation_required');
    assert.equal(sends, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a definite rejection leaves no pending operation and requires a new preview', async () => {
  let sends = 0;
  const { service } = fixture({
    client: {
      async upsertRecords() {
        sends += 1;
        if (sends === 1) throw Object.assign(new Error('membership'), { code: 'membership_required' });
        return { records };
      }
    }
  });
  const preview = await service.previewTrainingUpsert({ records });
  const args = { records, confirm: true, preview_id: preview.preview_id };
  const rejected = await service.upsertTrainingRecords(args);
  assert.equal(rejected.outcome, 'not_submitted');
  assert.equal(rejected.error.code, 'membership_required');
  assert.equal((await service.reconcileTrainingUpsert({ records })).outcome, 'not_submitted');
  assert.equal((await service.upsertTrainingRecords(args)).error.code, 'preview_required');
  assert.equal((await submit(service)).outcome, 'confirmed');
  assert.equal(sends, 2);
});
