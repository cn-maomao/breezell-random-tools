import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const filename = path.join(root, `${pkg.publisher}.${pkg.name}-${pkg.version}.vsix`);
function entries(bytes) {
  const files = new Map();
  let cursor = 0;
  while (bytes.readUInt32LE(cursor) === 0x04034b50) {
    const method = bytes.readUInt16LE(cursor + 8);
    const size = bytes.readUInt32LE(cursor + 18);
    const nameLength = bytes.readUInt16LE(cursor + 26);
    const extraLength = bytes.readUInt16LE(cursor + 28);
    const name = bytes.subarray(cursor + 30, cursor + 30 + nameLength).toString('utf8');
    const start = cursor + 30 + nameLength + extraLength;
    const data = bytes.subarray(start, start + size);
    assert.ok(method === 0 || method === 8);
    files.set(name, method === 8 ? inflateRawSync(data) : data);
    cursor = start + size;
  }
  return files;
}
test('packaged extension starts in Chinese without relying on development-only locale paths', { skip: !existsSync(filename) }, () => {
  const files = entries(readFileSync(filename));
  const nodeRequire = createRequire(import.meta.url);
  const module = { exports: {} };
  let status;
  const virtualFs = {
    existsSync(name) { return files.has(name); },
    readFileSync(name) { const bytes = files.get(name); if (!bytes) throw new Error('Missing packaged resource'); return bytes.toString('utf8'); }
  };
  const vscode = {
    Uri: { joinPath(base, ...parts) { return { fsPath: [base.fsPath, ...parts].join('/') }; } },
    env: { language: 'zh-cn' }, StatusBarAlignment: { Right: 2 },
    window: { createStatusBarItem() { status = { show() {}, dispose() {} }; return status; } },
    commands: { registerCommand() { return { dispose() {} }; } }
  };
  runInNewContext(files.get('extension/dist/extension.js').toString('utf8'), { module, exports: module.exports, Buffer, URL, require: name => name === 'vscode' ? vscode : name === 'node:fs' ? virtualFs : nodeRequire(name) });
  module.exports.activate({ extensionUri: { fsPath: 'extension' }, subscriptions: [] });
  assert.equal(status.name, '随机工具');
  assert.equal(status.command, 'randomTools.open');
  assert.ok(status.tooltip.length > 0);
});

test('built VSIX contains all runtime resources and root locale metadata', { skip: !existsSync(filename) }, () => {
  const files = entries(readFileSync(filename));
  for (const name of ['extension.vsixmanifest', '[Content_Types].xml', 'extension/dist/extension.js', 'extension/media/index.html', 'extension/media/app.js', 'extension/media/style.css', 'extension/media/icon.png', 'extension/media/i18n/en.json', 'extension/media/i18n/zh-cn.json', 'extension/package.nls.json', 'extension/package.nls.zh-cn.json', 'extension/README.md', 'extension/i18n/README.zh-CN.md']) {
    assert.ok(files.has(name), `Missing packaged resource: ${name}`);
  }
  assert.ok(![...files.keys()].some(name => /node_modules|\.tmp\//.test(name)));
  const packed = JSON.parse(files.get('extension/package.json').toString('utf8'));
  assert.equal(packed.version, pkg.version);
  assert.deepEqual(packed.breezell.permissions, ['agent.tools']);
  assert.equal(packed.publisher, 'cn-maomao');
  assert.equal(packed.contributes.breezell.tools.length, 9);
  const html = files.get('extension/media/index.html').toString('utf8');
  assert.match(html, /connect-src 'none'/);
  if (Number(pkg.version.split('.')[1]) >= 3) {
    for (const kind of ['uuid', 'hash', 'timestamp', 'base64', 'url', 'jwt']) assert.ok(html.includes(`id="${kind}-form"`), `Missing packaged tool: ${kind}`);
    const english = JSON.parse(files.get('extension/media/i18n/en.json').toString('utf8'));
    const chinese = JSON.parse(files.get('extension/media/i18n/zh-cn.json').toString('utf8'));
    for (const kind of ['Uuid', 'Hash', 'Timestamp', 'Base64', 'Url', 'Jwt']) assert.equal(typeof english[`tab${kind}`], 'string');
    assert.deepEqual(Object.keys(english).sort(), Object.keys(chinese).sort());
    const extension = files.get('extension/dist/extension.js').toString('utf8');
    assert.ok(extension.includes('runUtility'));
    assert.ok(extension.includes('registerAgentTools'));
    assert.ok(html.includes('id="category-select"'));
    assert.ok(html.includes('id="tool-select"'));
    assert.ok(html.includes('id="copy-prompt"'));
  }
});
