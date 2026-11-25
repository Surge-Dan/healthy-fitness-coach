'use strict';

const assert = require('node:assert/strict');
const { Given, When, Then } = require('@cucumber/cucumber');
const { renderTrainingHeatmapSvg } = require('../../healthy-fitness-coach/references/visuals.js');
const { createTrainingService } = require('../../healthy-fitness-coach-plugin/mcp/xunji/src/server.js');
const { buildVisualDNA, mapFitnessMotifs, recommendVisualRecipes, routeVisualInput } = require('../../healthy-fitness-coach/references/visual-dna.js');
const { compileDerivedLayerPrompt } = require('../../healthy-fitness-coach/references/visual-prompt-compiler.js');
const { renderCompiledVisualSvg } = require('../../healthy-fitness-coach/references/visual-composer.js');

Given(/^a local Xunji cache with no entry for (\d{4}-\d{2}-\d{2})$/, function (date) {
  const values = new Map();
  this.date = date;
  this.requests = 0;
  this.service = createTrainingService({
    cache: { get: async (key) => values.get(key) || null, set: async (key, value) => values.set(key, value) },
    credentialProvider: async () => 'GHERKIN_SYNTHETIC_CREDENTIAL',
    client: { fetchDay: async () => { this.requests += 1; return { records: [] }; } },
    now: () => 1000
  });
});

When('the same training day is requested twice concurrently', async function () {
  await Promise.all([
    this.service.getTrainingDay({ date: this.date }),
    this.service.getTrainingDay({ date: this.date })
  ]);
});

Then('the upstream request count is {int}', function (expected) {
  assert.equal(this.requests, expected);
});

Given(/^training dates spanning (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})$/, function (startDate, endDate) {
  this.heatmapInput = { dates: [startDate, endDate], startDate, endDate, width: 420, height: 260 };
});

When('an annual training heatmap is rendered', function () {
  this.svg = renderTrainingHeatmapSvg(this.heatmapInput);
});

Then('all {int} heatmap cells are inside the viewport', function (expected) {
  assert.match(this.svg, /data-heatmap="year"/);
  const { width, height } = this.heatmapInput;
  const cells = [...this.svg.matchAll(/<rect x="([0-9.]+)" y="([0-9.]+)" width="([0-9.]+)" height="([0-9.]+)"/g)];
  assert.equal(cells.length, expected);
  for (const [, x, y, cellWidth, cellHeight] of cells) {
    assert.ok(+x >= 0 && +y >= 0 && +x + +cellWidth <= width && +y + +cellHeight <= height);
  }
});

Given('write-back rows from two different dates', function () {
  this.rows = ['2026-08-01,id:1,胸部训练', '2026-08-02,id:2,背部训练'];
  this.requests = 0;
  const unexpectedNetwork = async () => { this.requests += 1; };
  this.service = createTrainingService({
    credentialProvider: async () => 'GHERKIN_SYNTHETIC_CREDENTIAL',
    client: { fetchDay: unexpectedNetwork, upsertRecords: unexpectedNetwork }
  });
});

When('the write-back payload is validated', async function () {
  this.preview = await this.service.previewTrainingUpsert({ records: this.rows });
});

Then('validation fails before any network call', function () {
  assert.equal(this.preview.error?.code, 'mixed_dates');
  assert.equal(this.requests, 0);
});

Given('one local fitness photo with observed visual facts', function () {
  this.photos = ['local.jpg'];
  this.images = [{ width: 1080, height: 1440, visual_facts: ['mirror:background', 'ring_light:top_center'] }];
});

When('the visual brief is compiled', function () {
  this.recipes = recommendVisualRecipes({
    route: routeVisualInput({ photos: this.photos }),
    visualDNA: buildVisualDNA({ images: this.images })
  });
});

Then('{int} recommendations use different composition grammars', function (expected) {
  assert.equal(this.recipes.length, expected);
  assert.equal(new Set(this.recipes.map((recipe) => recipe.grammar)).size, expected);
});

Given('a traceable fitness motif from the source photo', function () {
  this.visualDNA = buildVisualDNA({ images: [{ visual_facts: ['ring_light:top_center'] }] });
  this.motifs = mapFitnessMotifs({ observedFacts: this.visualDNA.observed_facts });
  assert.ok(this.motifs.length > 0);
});

When('the image-model prompt is compiled', function () {
  this.compiled = compileDerivedLayerPrompt({
    recipe: { id: 'sketch-diptych' }, visualDNA: this.visualDNA, motifs: this.motifs
  });
});

Then('text numbers logos and invented achievements are forbidden', function () {
  assert.match(this.compiled.prompt, /No text\. No letters\. No numbers/);
  assert.match(this.compiled.prompt, /No logos\. No watermarks\. No invented[^.]*achievements/);
  assert.equal(this.compiled.output.contains_metrics, false);
});

Given('{int} local fitness photos', function (count) {
  this.photos = Array.from({ length: count }, (_, index) => `photo-${index}.jpg`);
});

When('a multi-photo storyboard is rendered', function () {
  this.svg = renderCompiledVisualSvg({ ratio: '3:4', recipe: 'multi-photo-storyboard', photos: this.photos });
});

Then('all {int} originals are present in separate narrative panels', function (expected) {
  assert.equal((this.svg.match(/data-role="original-photo"/g) || []).length, expected);
  assert.equal((this.svg.match(/class="story-panel/g) || []).length, expected);
  for (const photo of this.photos) assert.ok(this.svg.includes(photo), `missing ${photo}`);
});
