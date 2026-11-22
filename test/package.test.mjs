import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(root, file), 'utf8');
test('plugin uses a registered launcher, minimal AI permission, packaged local assets and valid PNG', () => {
  const manifest = JSON.parse(read('package.json'));
  assert.equal(manifest.breezell.apiVersion, 1);
  assert.deepEqual(manifest.breezell.permissions, ['agent.tools']);
  assert.ok(manifest.contributes.commands.some(command => command.command === manifest.contributes.breezell.launcher.command));
  assert.deepEqual(manifest.extensionKind, ['ui', 'workspace']);
  assert.deepEqual(manifest.activationEvents, ['onStartupFinished']);
  assert.ok(!manifest.dependencies || Object.keys(manifest.dependencies).length === 0);
  assert.equal(manifest.main, './dist/extension.js');
  const png = readFileSync(path.join(root, manifest.icon));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(manifest.publisher, 'cn-maomao');
  assert.equal(manifest.repository.url, 'https://github.com/cn-maomao/breezell-random-tools');
});
test('AI tool declarations are unique, mode-scoped and have bounded schemas', () => {
  const manifest = JSON.parse(read('package.json'));
  const declarations = manifest.contributes.breezell.tools;
  assert.equal(declarations.length, 9);
  assert.equal(new Set(declarations.map(tool => tool.name)).size, 9);
  for (const tool of declarations) {
    assert.match(tool.name, /^rt_(password|key|port|uuid|hash|timestamp|base64|url|jwt)$/);
    assert.deepEqual([...tool.modes].sort(), ['agent', 'chat', 'entanglement']);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(!tool.inputSchema.properties.kind);
    if (tool.inputSchema.properties.input) assert.ok(tool.inputSchema.properties.input.maxLength <= 65536);
  }
});

test('English manifest catalogue covers every placeholder and Chinese has matching keys', () => {
  const english = JSON.parse(read('package.nls.json'));
  const chinese = JSON.parse(read('i18n/package.nls.zh-cn.json'));
  for (const match of read('package.json').matchAll(/%([^%]+)%/g)) assert.equal(typeof english[match[1]], 'string');
  assert.deepEqual(Object.keys(chinese).sort(), Object.keys(english).sort());
});
