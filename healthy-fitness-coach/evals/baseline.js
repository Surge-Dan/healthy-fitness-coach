'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BASELINE_COMMIT = '180549f30a7579d5f4c2733ee662f64229531e78';
const SKILL_PATH = 'healthy-fitness-coach';
const blockedPath = /(^|\/)(?:\.cache|\.pytest_cache|node_modules|__pycache__|fitness-reports|personal-reports|user-reports|client-reports)(?:\/|$)|(^|\/)(?:personal|user|client|athlete)[-_ ]?reports?(?:[-_.\/]|$)|\.(?:pyc|pyo|png|jpe?g|gif|webp|heic|heif|avif|tiff?)$/i;
const blockedContent = /(?:^|[^A-Za-z0-9_])(?:[A-Za-z0-9]+_)*(?:api[_ -]?key|secret|access[_ -]?token|private[_ -]?key)\s*(?:[:=]|is)\s*['"]?[A-Za-z0-9][A-Za-z0-9_./+=-]{7,}/i;

function audit(relative, bytes) {
  assert.ok(!blockedPath.test(relative), '禁止的快照路径：' + relative);
  assert.ok(!blockedContent.test(bytes.toString('utf8')), '快照包含疑似 API Key 或秘密：' + relative);
}

function withBaseline(root, action) {
  const manifestBytes = fs.readFileSync(path.join(__dirname, 'baseline-manifest.json'));
  audit('baseline-manifest.json', manifestBytes);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.source_commit, BASELINE_COMMIT);

  const git = (args, input) => execFileSync('git', args, { cwd: root, input, maxBuffer: 8 * 1024 * 1024, timeout: 30_000 });
  let tree;
  try {
    tree = git(['ls-tree', '-r', '-z', BASELINE_COMMIT, '--', SKILL_PATH]);
  } catch (error) {
    throw new Error('无法读取历史评测基线，需要包含 ' + BASELINE_COMMIT + ' 的 Git 历史。', { cause: error });
  }
  const prefix = SKILL_PATH + '/';
  const entries = tree.toString('utf8').split('\0').filter(Boolean).map((entry) => {
    const boundary = entry.indexOf('\t');
    const [mode, type, blob] = entry.slice(0, boundary).split(' ');
    const filename = entry.slice(boundary + 1);
    assert.ok(['100644', '100755'].includes(mode) && type === 'blob' && /^[a-f0-9]{40}$/.test(blob));
    assert.ok(filename.startsWith(prefix));
    const relative = filename.slice(prefix.length);
    assert.ok(relative.split('/').every((part) => /^[\w.-]+$/.test(part) && part !== '.' && part !== '..'));
    return { blob, relative };
  });
  const paths = manifest.files.map(({ path: filename }) => filename);
  assert.equal(new Set(paths).size, paths.length, '基线清单路径必须唯一');
  assert.deepEqual(entries.map(({ relative }) => relative).sort(), paths.sort(), '历史文件集合与清单不符');
  const hashes = new Map(manifest.files.map((entry) => [entry.path, entry.sha256]));
  const contents = git(['cat-file', '--batch'], entries.map(({ blob }) => blob).join('\n') + '\n');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fitness-history-'));
  try {
    let offset = 0;
    for (const { relative, blob } of entries) {
      const lineEnd = contents.indexOf(10, offset);
      assert.ok(lineEnd >= offset, '缺少 Git blob 头');
      const [object, type, size] = contents.toString('ascii', offset, lineEnd).split(' ');
      assert.ok(object === blob && type === 'blob' && /^\d+$/.test(size));
      const end = lineEnd + 1 + Number(size);
      assert.equal(contents[end], 10, 'Git blob 长度异常');
      const bytes = contents.subarray(lineEnd + 1, end);
      offset = end + 1;
      audit(relative, bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), hashes.get(relative), relative);
      const file = path.join(directory, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes, { flag: 'wx' });
    }
    assert.equal(offset, contents.length, '未读取的 Git blob 数据');
    return action(directory, entries.length);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { BASELINE_COMMIT, audit, withBaseline };
