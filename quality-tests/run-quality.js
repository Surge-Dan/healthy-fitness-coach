'use strict';

const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

const root = resolve(__dirname, '..');
const node = process.execPath;
const checks = [
  [node, 'quality-tests/run-coverage.js'],
  [node, 'quality-tests/run-gherkin.js'],
  [node, 'quality-tests/run-mutation-smoke.js'],
  [node, 'quality-tests/run-knowledge-base.js'],
  [node, 'quality-tests/run-training-system.js'],
  [node, 'quality-tests/run-training-os-baseline.js'],
  [node, 'quality-tests/run-visual-system.js'],
  [node, 'quality-tests/run-visual-png-smoke.js'],
  [node, 'quality-tests/run-plugin-sync.js'],
  [node, 'healthy-fitness-coach/evals/paired-evaluation.js', '--check'],
  ['python', 'quality-tests/test_release.py'],
  ['python', 'quality-tests/build-release.py', '--check', '--verify']
];

let failures = 0;
for (const [command, ...args] of checks) {
  console.log(`\nRunning ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1' },
    timeout: 300000
  });
  if (result.status !== 0 || result.error) {
    failures += 1;
    console.error(`FAILED ${args.join(' ')} (${result.error?.message || result.signal || result.status})`);
  }
}
console.log(`\nQuality gates: ${checks.length - failures}/${checks.length} passed`);
if (failures) process.exitCode = 1;
