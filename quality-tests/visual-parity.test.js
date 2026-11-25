'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const canonicalCharts = require('../healthy-fitness-coach/references/visuals.js');
const bundledCharts = require('../healthy-fitness-coach-plugin/skills/healthy-fitness-coach/references/visuals.js');
const connectorCharts = require('../healthy-fitness-coach-plugin/mcp/xunji/src/visuals.js');
const canonicalReport = require('../healthy-fitness-coach/references/visual-report.js');
const bundledReport = require('../healthy-fitness-coach-plugin/skills/healthy-fitness-coach/references/visual-report.js');
const connectorReport = require('../healthy-fitness-coach-plugin/mcp/xunji/src/visual-report.js');

test('connector uses the bundled renderer and its output matches the standalone renderer', () => {
  assert.strictEqual(connectorCharts, bundledCharts);
  assert.strictEqual(connectorReport, bundledReport);
  const input = { startDate: '2025-12-31', endDate: '2026-04-01', dates: ['2025-12-31', '2026-01-01'] };
  assert.equal(connectorCharts.renderTrainingHeatmapSvg(input), canonicalCharts.renderTrainingHeatmapSvg(input));
  for (const trends of [{}, { training_dates: input.dates, date_start: input.startDate, date_end: input.endDate }]) {
    assert.deepEqual(connectorReport.buildVisualReportAssets({ trends }), canonicalReport.buildVisualReportAssets({ trends }));
  }
});
