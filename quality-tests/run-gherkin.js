'use strict';

const assert = require('node:assert/strict');
const { loadConfiguration, runCucumber } = require('@cucumber/cucumber/api');

async function main() {
  const environment = { cwd: __dirname };
  const { runConfiguration } = await loadConfiguration({
    file: false,
    provided: {
      paths: ['features/**/*.feature'],
      require: ['features/*.steps.js'],
      format: ['summary']
    }
  }, environment);
  const pickles = new Map();
  const cases = new Map();
  const started = new Map();
  const finished = new Set();
  const results = new Map();
  const execution = await runCucumber(runConfiguration, environment, (message) => {
    if (message.pickle) pickles.set(message.pickle.id, message.pickle);
    if (message.testCase) cases.set(message.testCase.id, message.testCase);
    if (message.testCaseStarted) {
      const { id, testCaseId } = message.testCaseStarted;
      started.set(id, cases.get(testCaseId));
    }
    if (message.testCaseFinished) finished.add(message.testCaseFinished.testCaseStartedId);
    if (message.testStepFinished) {
      const { testCaseStartedId, testStepId, testStepResult } = message.testStepFinished;
      if (!results.has(testCaseStartedId)) results.set(testCaseStartedId, new Map());
      results.get(testCaseStartedId).set(testStepId, testStepResult.status);
    }
  });
  assert.ok(execution.success, 'Cucumber reported a failure');
  assert.ok(pickles.size > 0, 'No Gherkin scenarios were loaded');
  assert.equal(started.size, pickles.size, 'Every Gherkin scenario must execute once');
  for (const pickle of pickles.values()) {
    const attempts = [...started].filter(([, testCase]) => testCase?.pickleId === pickle.id);
    assert.equal(attempts.length, 1, `${pickle.name}: expected exactly one attempt`);
    const [attemptId, testCase] = attempts[0];
    assert.ok(finished.has(attemptId), `${pickle.name}: did not finish`);
    const steps = new Map(testCase.testSteps.filter((step) => step.pickleStepId).map((step) => [step.pickleStepId, step.id]));
    const statuses = results.get(attemptId) || new Map();
    assert.ok(pickle.steps.length > 0, `${pickle.name}: no steps defined`);
    for (const step of pickle.steps) {
      assert.equal(statuses.get(steps.get(step.id)), 'PASSED', `${pickle.name}: ${step.text}`);
    }
    assert.ok([...statuses.values()].every((status) => status === 'PASSED'), `${pickle.name}: every hook must pass`);
  }
}

main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
