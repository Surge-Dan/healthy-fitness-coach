'use strict';

const { readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { run } = require('node:test');

const root = resolve(__dirname, '..');
const suites = [
  'healthy-fitness-coach/tests',
  'healthy-fitness-coach-plugin/mcp/xunji/test',
  'quality-tests/visual-parity.test.js'
];

function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return entry.name.endsWith('.test.js') ? [path] : [];
  });
}

async function main() {
  for (const suite of suites) {
    const path = join(root, suite);
    const files = suite.endsWith('.test.js') ? [path] : testFiles(path);
    if (!files.length) throw new Error(`No tests found under ${suite}`);
    let passed = 0;
    let failed = 0;
    for await (const event of run({ files, concurrency: 2 })) {
      if (event.type === 'test:stderr' || event.type === 'test:stdout') process.stderr.write(event.data.message);
      if (event.type === 'test:pass' || event.type === 'test:fail') {
        const { name, skip, todo, details } = event.data;
        if (skip || todo || event.type === 'test:fail') {
          failed += 1;
          const reason = details?.error?.cause || details?.error || skip || todo;
          console.error(`FAIL ${name}: ${reason?.stack || reason || 'test failed'}`);
        } else {
          passed += 1;
        }
      }
    }
    console.log(`${suite}: ${passed} passed, ${failed} failed or skipped`);
    if (failed || !passed) process.exitCode = 1;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
