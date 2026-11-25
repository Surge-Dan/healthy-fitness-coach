'use strict';

const assert = require('node:assert/strict');
const { Given, When, Then } = require('@cucumber/cucumber');
const { buildWorkflowDecision } = require('../../healthy-fitness-coach/references/training-orchestrator.js');
const { assessResume, createCheckpoint } = require('../../healthy-fitness-coach/references/training-continuity.js');
const { createTrainingService } = require('../../healthy-fitness-coach-plugin/mcp/xunji/src/server.js');

const day = '2026-10-20';
const trainingLine = (id) => `${day},id:${id},胸部训练,1.卧推,1组,60kg,10次,source:xunji`;

function trainingService(client) {
  const cache = new Map();
  return createTrainingService({
    cache: { get: async (date) => cache.get(date), set: async (date, entry) => cache.set(date, entry) },
    credentialProvider: async () => 'GHERKIN_SYNTHETIC_CREDENTIAL',
    now: () => Date.parse('2026-10-21T09:00:00+08:00'),
    client
  });
}

async function submit(service, records) {
  const preview = await service.previewTrainingUpsert({ records });
  assert.ok(preview.preview_id);
  return service.upsertTrainingRecords({ records, preview_id: preview.preview_id, confirm: true });
}

Given('a coaching instruction {string}', function (instruction) {
  this.input = { instruction };
});

Given('a mobile host with attachment support', function () {
  this.input.capabilities = { mobile: true, can_write_files: true };
});

Given(/^Xunji is configured on (\d{4}-\d{2}-\d{2})$/, function (date) {
  this.input.capabilities = { xunji_connector: true, credentials_ready: true };
  this.input.reference_date = date;
});

When('the coaching request is routed', function () {
  this.decision = buildWorkflowDecision(this.input);
});

Then('safety status is {string} with zero attachments', function (status) {
  assert.equal(this.decision.safety.status, status);
  assert.deepEqual(this.decision.artifacts, []);
});

Then('the task is {string} and no write-back is pending', function (task) {
  assert.equal(this.decision.task_type, task);
  assert.equal(this.decision.writeback, null);
});

Then('the workflow schedules a read from {string} to {string} without missing fields', function (startDate, endDate) {
  assert.equal(this.decision.information_state, 'ready');
  assert.deepEqual(this.decision.missing_fields, []);
  assert.deepEqual(this.decision.data_source, {
    status: 'read_pending', action: 'read_range', start_date: startDate, end_date: endDate
  });
});

Given('an unexpired checkpoint for today', function () {
  this.now = Date.parse('2026-11-24T12:00:00+08:00');
  this.snapshot = createCheckpoint({ updated_at: '2026-11-24', valid_until: '2026-11-24' });
});

When('the checkpoint is resumed with the written answer {string}', function (answer) {
  this.resume = assessResume(this.snapshot, { now: this.now, state_confirmed: answer });
});

Then('resume status is {string}', function (status) {
  assert.equal(this.resume.status, status);
});

Given('a delayed training-day read with old record ID {string}', function (oldId) {
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const release = new Promise((resolve) => { this.releaseRead = resolve; });
  this.service = trainingService({
    async fetchDay() {
      markStarted();
      await release;
      return { records: [trainingLine(oldId)] };
    },
    async upsertRecords(records) { return { records }; }
  });
  this.reading = this.service.getTrainingDay({ date: day });
  return started;
});

When('a confirmed same-day write returns record ID {string} before the read completes', async function (newId) {
  try {
    this.written = await submit(this.service, [trainingLine(newId)]);
  } finally {
    this.releaseRead();
  }
  this.delayedResult = await this.reading;
  this.cached = await this.service.getTrainingDay({ date: day });
});

Then('both the delayed read and the cache return record ID {string}', function (id) {
  assert.equal(this.written.outcome, 'confirmed');
  for (const result of [this.delayedResult, this.cached]) {
    assert.deepEqual(result.records.map((record) => record.id), [id]);
  }
});

Given('a training write that times out upstream', function () {
  this.writes = 0;
  this.service = trainingService({
    upsertRecords: async () => {
      this.writes += 1;
      throw Object.assign(new Error('synthetic timeout'), { code: 'network_error' });
    }
  });
});

When('the batch is explicitly confirmed twice using separate previews', async function () {
  const records = [trainingLine('1')];
  this.initialWrite = await submit(this.service, records);
  this.replay = await submit(this.service, records);
});

Then('the outcomes are {string} and {string} with {int} upstream write', function (initial, replay, count) {
  assert.equal(this.initialWrite.outcome, initial);
  assert.equal(this.replay.outcome, replay);
  assert.equal(this.writes, count);
});
