import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { build } = require('esbuild');
const bundle = await build({ entryPoints: [path.join(root, 'src/extension.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'], write: false, logLevel: 'silent' });
function harness(language = 'zh-cn') {
  let open, receive, disposePanel, changeSignIn, changeVisibility;
  const status = { shown: 0, disposed: false, show() { this.shown++; }, dispose() { this.disposed = true; } };
  let messageDisposed = false, visibilityDisposed = false;
  let created = 0;
  const messages = [], clipboard = [], errors = [], subscriptions = [];
  const tools = new Map();
  const uri = fsPath => ({ fsPath, toString: () => 'file://' + fsPath.replaceAll('\\', '/') });
  const account = { isSignedIn: true, onDidChangeSignIn(listener) { changeSignIn = listener; return { dispose() {} }; } };
  const panel = {
    visible: true,
    reveal() {},
    onDidChangeViewState(listener) { changeVisibility = listener; return { dispose() { visibilityDisposed = true; } }; },
    dispose() { disposePanel?.(); },
    onDidDispose(listener) { disposePanel = listener; },
    webview: {
      html: '', cspSource: 'https://webview.test',
      asWebviewUri: value => value,
      postMessage(value) { messages.push(value); return Promise.resolve(true); },
      onDidReceiveMessage(listener) { receive = listener; return { dispose() { messageDisposed = true; } }; }
    }
  };
  const vscode = {
    Uri: { joinPath(base, ...parts) { return uri(path.join(base.fsPath, ...parts)); } },
    ViewColumn: { Active: 1 },
    StatusBarAlignment: { Right: 2 },
    env: { language, clipboard: { async writeText(value) { clipboard.push(value); } } },
    breezell: { account, tools: { register(name, handler) { tools.set(name, handler); return { dispose() { tools.delete(name); } }; } } },
    commands: { registerCommand(name, listener) { assert.equal(name, 'randomTools.open'); open = listener; return { dispose() {} }; } },
    window: { createStatusBarItem(id, alignment, priority) { assert.equal(id, 'randomTools.open'); assert.equal(alignment, 2); assert.equal(priority, 100); return status; }, createWebviewPanel(_id, _title, _column, options) { created++; assert.equal(options.retainContextWhenHidden, false); assert.equal(options.localResourceRoots.length, 1); return panel; }, showErrorMessage(value) { errors.push(value); } }
  };
  const module = { exports: {} };
  const sandbox = createContext({ module, exports: module.exports, require: name => name === 'vscode' ? vscode : require(name), Buffer, URL, console });
  runInContext(bundle.outputFiles[0].text, sandbox);
  module.exports.activate({ extensionUri: uri(root), extension: { id: 'cn-maomao.random-tools' }, subscriptions });
  open();
  return { panel, messages, clipboard, errors, subscriptions, account, open, status, tools, invoke: (name, input) => { sandbox.input = JSON.stringify(input); return tools.get(name).invoke(runInContext('JSON.parse(input)', sandbox), { isCancellationRequested: false }); }, hide() { panel.visible = false; changeVisibility(); }, disposedListeners: () => messageDisposed && visibilityDisposed, get created() { return created; }, send: message => { sandbox.input = JSON.stringify(message); return receive(runInContext('JSON.parse(input)', sandbox)); }, signOut() { account.isSignedIn = false; changeSignIn(false); } };
}
test('localized shortcut uses right alignment and extension-owned disposal', () => {
  for (const language of ['en', 'zh-cn']) {
    const h = harness(language);
    assert.equal(h.status.command, 'randomTools.open');
    assert.equal(h.status.shown, 1);
    assert.match(h.status.text, /\$\(key\)/);
    assert.equal(h.status.name, language === 'en' ? 'Random Tools' : '随机工具');
    assert.ok(h.subscriptions.includes(h.status));
    h.subscriptions.forEach(subscription => subscription.dispose());
    assert.equal(h.status.disposed, true);
    assert.equal(h.disposedListeners(), true);
  }
});

test('hiding the renderer releases host result references', async () => {
  const h = harness();
  await h.send({ type: 'generate', requestId: 1, request: { kind: 'key', count: 1, bytes: 32 } });
  assert.equal(h.messages.at(-1).type, 'result');
  h.hide();
  await h.send({ type: 'copy', requestId: 2, index: 0 });
  assert.equal(h.messages.at(-1).code, 'invalidRequest');
  assert.equal(h.clipboard.length, 0);
});

const password = { kind: 'password', count: 2, length: 20, lowercase: true, uppercase: true, digits: true, special: false, requireEach: true };
test('panel initializes locale and strict CSP; opening twice reuses it', async () => {
  const h = harness(); h.open(); assert.equal(h.created, 1); assert.equal(h.errors.length, 0);
  assert.ok(!h.panel.webview.html.includes('{{'));
  assert.match(h.panel.webview.html, /connect-src 'none'/);
  await h.send({ type: 'ready', requestId: 1 });
  assert.equal(h.messages[0].type, 'init'); assert.equal(h.messages[0].language, 'zh-cn');
  assert.ok(Object.keys(h.messages[0].strings).length > 10);
});
test('generation, indexed clipboard, invalid payload and clear', async () => {
  const h = harness('en');
  await h.send({ type: 'generate', requestId: 1, request: password });
  const result = h.messages.at(-1); assert.equal(result.type, 'result'); assert.equal(result.values.length, 2);
  await h.send({ type: 'copy', requestId: 2, index: -1 });
  assert.equal(h.clipboard[0], result.values.join('\n'));
  await h.send({ type: 'copy', requestId: 3, index: 9 }); assert.equal(h.messages.at(-1).code, 'invalidRequest');
  await h.send({ type: 'generate', requestId: 4, request: { kind: 'key', bytes: 1 } }); assert.equal(h.messages.at(-1).type, 'error');
  await h.send({ type: 'clear', requestId: 5 });
  await h.send({ type: 'copy', requestId: 6, index: 0 }); assert.equal(h.messages.at(-1).code, 'invalidRequest');
});
test('webview reload, disposal and sign-out do not restore secrets', async () => {
  const h = harness();
  await h.send({ type: 'generate', requestId: 1, request: password });
  await h.send({ type: 'ready', requestId: 2 });
  await h.send({ type: 'copy', requestId: 3, index: 0 }); assert.equal(h.messages.at(-1).code, 'invalidRequest');
  await h.send({ type: 'generate', requestId: 4, request: password });
  h.signOut(); assert.equal(h.messages.at(-1).code, 'notSignedIn');
  await h.send({ type: 'generate', requestId: 5, request: password }); assert.equal(h.messages.at(-1).code, 'notSignedIn');
  h.account.isSignedIn = true;
  await h.send({ type: 'ready', requestId: 6 });
  assert.equal(h.messages.at(-1).type, 'init');
  await h.send({ type: 'copy', requestId: 7, index: 0 }); assert.equal(h.messages.at(-1).code, 'invalidRequest');
  h.panel.dispose(); const length = h.messages.length;
  await h.send({ type: 'generate', requestId: 6, request: password }); assert.equal(h.messages.length, length);
});
test('six offline utilities share the safe result and indexed clipboard boundary', async () => {
  const h = harness();
  const token = [Buffer.from('{"alg":"HS256"}').toString('base64url'), Buffer.from('{"sub":"test"}').toString('base64url'), 'AA'].join('.');
  const requests = [
    { kind: 'uuid', count: 2, format: 'standard', uppercase: false },
    { kind: 'hash', input: 'abc', algorithm: 'sha256', encoding: 'hex' },
    { kind: 'timestamp', input: '0', operation: 'toDate', unit: 'seconds' },
    { kind: 'base64', input: '你好', operation: 'encode', variant: 'base64', format: 'utf8' },
    { kind: 'url', input: 'https://user:password@example.test/path?a=1&a=2#part' },
    { kind: 'jwt', input: token }
  ];
  let id = 100;
  for (const request of requests) {
    await h.send({ type: 'process', requestId: id++, request });
    const result = h.messages.at(-1);
    assert.equal(result.type, 'result', `${request.kind}: ${result.code ?? 'unexpected response'}`); assert.equal(result.metadata.kind, request.kind);
    assert.ok(result.values.every(value => typeof value === 'string'));
    await h.send({ type: 'copy', requestId: id++, index: 0 });
    assert.equal(h.clipboard.at(-1), result.values[0]);
    await h.send({ type: 'clear', requestId: id++ });
    await h.send({ type: 'copy', requestId: id++, index: 0 }); assert.equal(h.messages.at(-1).code, 'invalidRequest');
  }
});

test('utility results replace old batch and are discarded on webview hide or reload', async () => {
  const h = harness();
  await h.send({ type: 'generate', requestId: 1, request: { kind: 'key', count: 3 } });
  assert.equal(h.messages.at(-1).values.length, 3);
  await h.send({ type: 'process', requestId: 2, request: { kind: 'url', input: 'https://example.test/' } });
  assert.equal(h.messages.at(-1).type, 'result');
  await h.send({ type: 'copy', requestId: 3, index: 2 }); assert.equal(h.messages.at(-1).code, 'invalidRequest');
  h.hide();
  await h.send({ type: 'copy', requestId: 4, index: 0 }); assert.equal(h.messages.at(-1).code, 'invalidRequest');
  await h.send({ type: 'process', requestId: 5, request: { kind: 'jwt', input: 'not-a-token' } });
  assert.equal(h.messages.at(-1).type, 'error');
  await h.send({ type: 'ready', requestId: 6 });
  await h.send({ type: 'copy', requestId: 7, index: 0 }); assert.equal(h.messages.at(-1).code, 'invalidRequest');
  assert.equal(h.clipboard.length, 0);
});

test('utility input limits and errors do not serialize submitted content', async () => {
  const h = harness();
  const input = 'x'.repeat(65537);
  await h.send({ type: 'process', requestId: 1, request: { kind: 'hash', input } });
  const response = h.messages.at(-1);
  assert.equal(response.type, 'error'); assert.equal(response.code, 'inputTooLarge');
  assert.ok(!JSON.stringify(response).includes(input));
  await h.send({ type: 'process', requestId: 2, request: { kind: 'base64', input: '', operation: 'encode', variant: 'base64', format: 'utf8' } });
  assert.equal(h.messages.at(-1).type, 'result'); assert.equal(h.messages.at(-1).values[0], '');
  await h.send({ type: 'copy', requestId: 3, index: 0 }); assert.equal(h.clipboard.at(-1), '');
  h.signOut();
  await h.send({ type: 'process', requestId: 4, request: { kind: 'uuid' } }); assert.equal(h.messages.at(-1).code, 'notSignedIn');
});

test('AI registrations expose nine tools and generated secrets remain in the panel', async () => {
  const h = harness();
  assert.equal(h.tools.size, 9);
  await h.send({ type: 'ready', requestId: 1 });
  const response = await h.invoke('rt_key', { bytes: 32, encoding: 'base64url' });
  const model = JSON.parse(response);
  assert.equal(model.values, undefined);
  const local = h.messages.at(-1);
  assert.equal(local.type, 'agentResult'); assert.equal(local.kind, 'key'); assert.equal(local.sensitive, true);
  assert.equal(local.values[0].length, 43);
  assert.ok(!response.includes(local.values[0]));
  await h.send({ type: 'copy', requestId: 2, index: 0 });
  assert.equal(h.clipboard.at(-1), local.values[0]);
  const publicResponse = JSON.parse(await h.invoke('rt_hash', { input: 'abc', algorithm: 'sha256', encoding: 'hex' }));
  assert.equal(publicResponse.values[0].length, 64);
});

test('copy prompt does not require a generated result and does not include typed data', async () => {
  const h = harness();
  await h.send({ type: 'copyPrompt', requestId: 1, request: { kind: 'jwt', input: 'PRIVATE-TYPED-TOKEN' } });
  assert.equal(h.messages.at(-1).type, 'promptCopied');
  assert.ok(h.clipboard.at(-1).includes('plugin:cn-maomao.random-tools'));
  assert.ok(h.clipboard.at(-1).includes('rt_jwt'));
  assert.ok(!h.clipboard.at(-1).includes('PRIVATE-TYPED-TOKEN'));
  await h.send({ type: 'copyPrompt', requestId: 2, request: { kind: 'password', prefix: 'PRIVATE-PREFIX', customChars: 'PRIVATE-CHARSET', length: 24 } });
  assert.ok(h.clipboard.at(-1).includes('24'));
  assert.ok(!h.clipboard.at(-1).includes('PRIVATE-'));
  h.signOut();
  await h.send({ type: 'copyPrompt', requestId: 3, request: { kind: 'uuid' } });
  assert.equal(h.messages.at(-1).code, 'notSignedIn');
});

test('AI secrets queued before renderer readiness are delivered once', async () => {
  const h = harness();
  await h.invoke('rt_password', { length: 24 });
  assert.ok(!h.messages.some(message => message.type === 'agentResult'));
  await h.send({ type: 'ready', requestId: 1 });
  assert.equal(h.messages.at(-1).type, 'agentResult');
  assert.equal(h.messages.at(-1).values[0].length, 24);
  await h.send({ type: 'ready', requestId: 2 });
  assert.equal(h.messages.at(-1).type, 'init');
});

test('port inspection is metadata only, without any bind or scan', async () => {
  const h = harness();
  await h.send({ type: 'inspectPort', requestId: 1, port: 3306 });
  assert.equal(h.messages.at(-1).type, 'portInfo'); assert.equal(h.messages.at(-1).category, 'registered');
  assert.ok(h.messages.at(-1).service);
  await h.send({ type: 'inspectPort', requestId: 2, port: 0 }); assert.equal(h.messages.at(-1).code, 'invalidPortRange');
});
