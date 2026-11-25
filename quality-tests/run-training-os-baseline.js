const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { audit, withBaseline } = require('../healthy-fitness-coach/evals/baseline.js');

const root = path.resolve(__dirname, '..');
const evalPath = path.join(root, 'healthy-fitness-coach', 'evals', 'evals.json');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

assert.throws(() => audit('baseline-manifest.json', Buffer.from('OPENAI_API_KEY=sk-example-12345678')), /API Key/);

const current = readJson(evalPath);
assert.equal(current.evals.length, 18, '评测总数必须是保留的12条加6条训练操作系统差异评测');
assert.deepEqual(current.evals.slice(0, 12).map((item) => item.id), Array.from({ length: 12 }, (_, index) => index + 1), '原12条评测必须保留且顺序不变');

const newCases = current.evals.slice(12);
assert.deepEqual(newCases.map((item) => item.id), [13, 14, 15, 16, 17, 18], '新增评测必须使用连续ID 13至18');

const completePlanCase = newCases.find((item) => item.id === 15);
assert.match(completePlanCase.prompt, /\d+\s*岁/, '信息完整的新手计划必须给出年龄范围');
assert.match(completePlanCase.prompt, /每周\s*\d+\s*天/, '信息完整的新手计划必须给出每周训练天数');
assert.match(completePlanCase.prompt, /每次\s*\d+\s*分钟/, '信息完整的新手计划必须给出单次训练时长');
assert.match(completePlanCase.prompt, /动作限制[：:]\s*(?:无|没有)/, '信息完整的新手计划必须明确动作限制');

const requirements = new Map([
  [13, { followUp: false, markers: ['RIR', '不得强制建档'] }],
  [14, { followUp: true, markers: ['关键缺口', '集中询问'] }],
  [15, { followUp: false, markers: ['画像', '当前计划'] }],
  [16, { followUp: true, markers: ['已有档案', '今日状态'] }],
  [17, { followUp: false, markers: ['四周', '1～2个主要变量', '决策记录'] }],
  [18, { followUp: false, markers: ['训练 DNA', '低置信度'] }]
]);

for (const item of newCases) {
  assert.ok(Array.isArray(item.expected_assets) && item.expected_assets.length > 0, `评测 ${item.id} 必须声明预期资产`);
  assert.ok(Array.isArray(item.content_boundaries) && item.content_boundaries.length > 0, `评测 ${item.id} 必须声明内容边界`);
  assert.ok(Array.isArray(item.prohibited_behaviors) && item.prohibited_behaviors.length > 0, `评测 ${item.id} 必须声明禁止行为`);
  assert.equal(typeof item.requires_follow_up, 'boolean', `评测 ${item.id} 必须声明是否应追问`);
  const { followUp, markers } = requirements.get(item.id);
  assert.equal(item.requires_follow_up, followUp, `评测 ${item.id} 的追问预期错误`);
  const searchable = JSON.stringify(item);
  for (const marker of markers) {
    assert.ok(searchable.includes(marker), `评测 ${item.id} 缺少差异化约束：${marker}`);
  }
}
assert.ok(newCases.some((item) => item.requires_follow_up), '新增评测必须覆盖应追问');
assert.ok(newCases.some((item) => !item.requires_follow_up), '新增评测必须覆盖不应追问');

withBaseline(root, (baseline, count) => {
  assert.deepEqual(readJson(path.join(baseline, 'evals', 'evals.json')).evals, current.evals.slice(0, 12));
  console.log(`PASS training-os baseline: ${count} audited Git files; 12 legacy evals + 6 redesign evals`);
});
