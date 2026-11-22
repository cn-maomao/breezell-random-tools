import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../media/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../media/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../media/style.css', import.meta.url), 'utf8');
const en = JSON.parse(readFileSync(new URL('../media/i18n/en.json', import.meta.url), 'utf8'));
const zh = JSON.parse(readFileSync(new URL('../media/i18n/zh-cn.json', import.meta.url), 'utf8'));

const decode = (value) => value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>');
const kebab = (value) => value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
const categories = { generation: ['password', 'key', 'port', 'uuid'], security: ['hash', 'base64', 'jwt'], parsing: ['url', 'timestamp'] };

// This minimal DOM exercises app.js itself, without a browser or dependencies.
class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = document;
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.textContent = '';
    this._value = undefined;
    this.type = tag === 'input' ? 'text' : '';
    this.hidden = false;
    this.checked = false;
    this.disabled = false;
    this.valid = true;
    this.dataset = new Proxy({}, {
      get: (_, key) => this.attributes.get(`data-${kebab(key)}`),
      set: (_, key, value) => { this.attributes.set(`data-${kebab(key)}`, String(value)); return true; }
    });
  }
  get value() {
    if (this.tagName === 'SELECT') return this._value === undefined ? (this.children[0]?.value || '') : this._value;
    if (this.tagName === 'OPTION') return this._value ?? this.getAttribute('value') ?? this.textContent;
    return this._value ?? '';
  }
  set value(value) {
    const string = String(value);
    this._value = this.tagName === 'SELECT' && !this.children.some((option) => option.value === string) ? '' : string;
  }
  get options() { return this.tagName === 'SELECT' ? this.children : undefined; }
  get id() { return this.attributes.get('id') || ''; }
  set id(value) { this.setAttribute('id', value); }
  get className() { return this.attributes.get('class') || ''; }
  set className(value) { this.attributes.set('class', value); }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'value') this.value = decode(String(value));
    if (name === 'type') this.type = String(value);
    if (name === 'min' || name === 'max') this[name] = String(value);
    if (['hidden', 'checked', 'disabled'].includes(name)) this[name] = true;
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  append(...children) {
    for (const child of children) {
      if (child.tagName === '#FRAGMENT') this.append(...child.children);
      else { child.parentNode = this; this.children.push(child); }
    }
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    if (this.tagName === 'SELECT') this._value = undefined;
    this.append(...children);
  }
  matches(selector) {
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    const attribute = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    if (attribute) return this.attributes.has(attribute[1]) && (attribute[2] === undefined || this.attributes.get(attribute[1]) === attribute[2]);
    return this.tagName === selector.toUpperCase();
  }
  querySelectorAll(selector) {
    const results = [];
    for (const child of this.children) {
      if (child.matches(selector)) results.push(child);
      results.push(...child.querySelectorAll(selector));
    }
    return results;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }
  emit(type, properties = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...properties };
    let node = this;
    do {
      for (const callback of node.listeners.get(type) || []) callback(event);
      node = node.parentNode;
    } while (node);
    return event;
  }
  focus() { this.ownerDocument.activeElement = this; }
  reportValidity() { return this.valid; }
}

function createDocument() {
  const document = {
    title: '', activeElement: null,
    createElement: (tag) => new Element(tag, document),
    createDocumentFragment: () => new Element('#fragment', document)
  };
  const root = new Element('#document', document);
  const stack = [root];
  for (const token of html.match(/<[^>]+>|[^<]+/g)) {
    if (token.startsWith('<!')) continue;
    if (token.startsWith('</')) { stack.pop(); continue; }
    if (!token.startsWith('<')) { stack.at(-1).textContent += decode(token); continue; }
    const match = token.match(/^<([a-z][a-z0-9-]*)\b([^>]*)>/i);
    if (!match) continue;
    const [, tag, attributes] = match;
    const element = document.createElement(tag);
    for (const attribute of attributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) element.setAttribute(attribute[1], attribute[2] || '');
    stack.at(-1).append(element);
    if (!['meta', 'link', 'input', 'br', 'hr'].includes(tag)) stack.push(element);
  }
  document.documentElement = root.querySelector('html');
  document.querySelectorAll = (selector) => root.querySelectorAll(selector);
  document.getElementById = (id) => {
    const visit = (node) => node.id === id ? node : node.children.map(visit).find(Boolean);
    return visit(root) || null;
  };
  for (const select of document.querySelectorAll('select')) select.value = select.children[0]?.value || '';
  return document;
}

function boot(options = {}) {
  const document = createDocument();
  const messages = [];
  const listeners = new Map();
  let acquired = 0;
  const context = {
    document,
    window: { addEventListener: (name, callback) => listeners.set(name, callback) }
  };
  if (options.host !== false) context.acquireVsCodeApi = () => {
    acquired += 1;
    if (options.acquireThrows) throw new Error('Host acquisition unavailable');
    if (options.host === null) return null;
    return { postMessage: (message) => {
      if (options.postThrows) throw new Error('Host unavailable');
      messages.push(JSON.parse(JSON.stringify(message)));
    } };
  };
  vm.runInNewContext(app, context, { filename: 'app.js' });
  const get = (id) => document.getElementById(id);
  const receive = (data) => listeners.get('message')({ data });
  const submit = (kind) => get(`${kind}-form`).emit('submit');
  const change = (id, value, type = 'change') => {
    const element = get(id);
    if (typeof value === 'boolean') element.checked = value;
    else element.value = String(value);
    element.emit(type);
  };
  const tool = (kind) => {
    const category = Object.keys(categories).find((key) => categories[key].includes(kind));
    assert.ok(category, `Known tool: ${kind}`);
    if (get('category-select').value !== category) change('category-select', category);
    change('tool-select', kind);
  };
  const init = (catalog = en, language = 'en') => receive({ type: 'init', language, strings: catalog });
  const last = (type) => messages.filter((message) => message.type === type).at(-1);
  const result = (request, values = ['safe-value'], sensitive = true) => receive({ type: 'result', requestId: request.requestId, values, sensitive, metadata: {} });
  return { document, messages, get, receive, submit, tool, change, init, last, result, acquired: () => acquired };
}

test('sign-out and blocking clear visible values and fail closed until host reinitializes', () => {
  for (const code of ['notSignedIn', 'blocked']) {
    const page = boot(); page.init(); page.submit('password'); page.result(page.last('generate'));
    page.receive({ type: 'error', requestId: -1, code });
    assert.equal(page.get('result-list').children.length, 0);
    assert.equal(page.get('results').hidden, true);
    assert.equal(page.get('password-form').querySelector('.generate').disabled, true);
    const count = page.messages.length;
    page.submit('password'); assert.equal(page.messages.length, count);
    page.init();
    assert.equal(page.get('password-form').querySelector('.generate').disabled, false);
    assert.equal(page.get('status').textContent, en.ready);
  }
});

test('key results show random bytes, bits, encoding and character count without secret text', () => {
  const page = boot(); page.init(zh, 'zh-cn'); page.tool('key'); page.submit('key');
  const request = page.last('generate');
  page.receive({ type: 'result', requestId: request.requestId, values: ['a'.repeat(43)], sensitive: true, metadata: { kind: 'key', bytes: 32, encoding: 'base64url' } });
  const info = page.get('result-info');
  assert.equal(info.hidden, false);
  assert.match(info.textContent, /32/); assert.match(info.textContent, /256/); assert.match(info.textContent, /43/);
  assert.ok(!info.textContent.includes('a'.repeat(43)));
  page.get('clear').emit('click'); assert.equal(info.hidden, true);
});

test('HTML has a strict host-substituted CSP and no inline handlers', () => {
  for (const placeholder of ['{{cspSource}}', '{{nonce}}', '{{styleUri}}', '{{scriptUri}}', '{{lang}}']) assert.ok(html.includes(placeholder));
  assert.match(html, /default-src 'none'; style-src \{\{cspSource\}\}; script-src 'nonce-\{\{nonce\}\}'; connect-src 'none'; img-src \{\{cspSource\}\} data:/);
  assert.match(html, /<script nonce="\{\{nonce\}\}" src="\{\{scriptUri\}\}" defer><\/script>/);
  assert.doesNotMatch(html, /\bon\w+\s*=|<style\b/i);
});

test('HTML has linked labels, native forms, named tool regions and live status', () => {
  const page = boot();
  assert.equal(page.document.querySelectorAll('[role="tab"]').length, 0);
  assert.equal(page.document.querySelectorAll('[role="tablist"]').length, 0);
  assert.equal(page.document.querySelectorAll('[role="tabpanel"]').length, 0);
  assert.equal(page.document.querySelectorAll('[role="region"]').length, 9);
  for (const panel of page.document.querySelectorAll('[role="region"]')) {
    const key = panel.getAttribute('data-i18n-aria-label');
    assert.equal(panel.getAttribute('aria-label'), en[key]);
  }
  assert.equal(page.get('category-select').tagName, 'SELECT');
  assert.equal(page.get('tool-select').tagName, 'SELECT');
  for (const label of page.document.querySelectorAll('label')) {
    const target = label.getAttribute('for');
    assert.ok(target ? page.get(target) : label.querySelector('input'), 'Every label controls an input');
  }
  for (const id of ['status', 'inspect-info']) assert.equal(page.get(id).getAttribute('aria-live'), 'polite');
});

test('theme is host-driven, single-column bounded and responsive', () => {
  assert.match(css, /--vscode-editor-background, #ffffff/);
  assert.match(css, /max-width: 640px/);
  assert.match(css, /\[hidden\]/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(max-width: 380px\)/);
});

test('catalogs are complete flat strings and include all documented errors', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const catalog of [en, zh]) for (const value of Object.values(catalog)) assert.equal(typeof value, 'string');
  const errors = ['invalidCount', 'invalidLength', 'emptyCharset', 'requiredGroupEmpty', 'impossibleRules', 'insufficientSpace', 'attemptsExceeded', 'invalidCharacters', 'invalidKeySize', 'invalidEncoding', 'invalidAlgorithm', 'invalidPortRange', 'invalidPortExclusions', 'invalidRequest', 'unknownError', 'clipboardFailed', 'notSignedIn', 'blocked', 'hostOnly', 'inputTooLarge', 'outputTooLarge', 'invalidText', 'invalidHash', 'invalidBase64', 'invalidUtf8', 'invalidTimestamp', 'invalidDate', 'invalidUrl', 'invalidJwt', 'invalidUuidFormat'];
  for (const key of errors) assert.ok(en[key] && zh[key], key);
  for (const [, key] of html.matchAll(/data-i18n(?:-aria-label|-placeholder)?="([^"]+)"/g)) assert.ok(en[key] && zh[key], key);
});

test('page has no random generation, network, clipboard or persistent state APIs', () => {
  assert.doesNotMatch(app, /Math\.random|\bcrypto\b|\bfetch\s*\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|setState|getState|navigator\.clipboard|innerHTML|outerHTML|insertAdjacentHTML|\beval\s*\(/);
});

test('host is acquired once, ready has a numeric monotonically increasing requestId', () => {
  const page = boot();
  assert.equal(page.acquired(), 1);
  assert.deepEqual(page.messages, [{ type: 'ready', requestId: 1 }]);
  page.submit('password');
  page.tool('key');
  page.submit('key');
  assert.deepEqual(page.messages.map((entry) => entry.requestId), [1, 2, 3, 4]);
});

test('without a host generation and lookup stay disabled while tools remain browsable', () => {
  const page = boot({ host: false });
  assert.equal(page.get('host-warning').hidden, false);
  assert.equal(page.get('password-form').querySelector('.generate').disabled, true);
  assert.equal(page.get('inspect-button').disabled, true);
  page.submit('password');
  page.tool('port');
  assert.equal(page.get('panel-port').hidden, false);
  assert.equal(page.get('tool-select').value, 'port');
  assert.equal(page.messages.length, 0);
});

test('a failed host post fails closed without losing tool browsing', () => {
  const page = boot({ postThrows: true });
  assert.equal(page.get('host-warning').hidden, false);
  assert.equal(page.get('password-form').querySelector('.generate').disabled, true);
  page.tool('key');
  assert.equal(page.get('panel-key').hidden, false);
});

test('host init translates static, dynamic and accessibility strings safely', () => {
  const page = boot();
  page.init(zh, 'zh-cn');
  assert.equal(page.get('current-tool-label').textContent, zh.tabPassword);
  assert.equal(page.get('tool-select').options[0].textContent, zh.tabPassword);
  assert.equal(page.get('panel-password').getAttribute('aria-label'), zh.tabPassword);
  assert.equal(page.document.documentElement.lang, 'zh-CN');
  assert.equal(page.get('status').textContent, zh.ready);
  page.submit('password');
  page.result(page.last('generate'));
  const input = page.get('result-list').querySelector('input');
  assert.equal(input.getAttribute('aria-label'), zh.resultLabel.replace('{index}', '1'));
  page.init({ ...en, appTitle: '<img src=x onerror=alert(1)>' });
  assert.equal(page.document.title, '<img src=x onerror=alert(1)>');
});

test('default password request is complete and prevents double generation', () => {
  const page = boot();
  page.submit('password');
  assert.deepEqual(page.last('generate').request, {
    kind: 'password', count: 1, length: 20, minLength: 16, maxLength: 24, rangeLength: false,
    lowercase: true, uppercase: true, digits: true, special: true, specialChars: '!@#$%^&*()-_=+',
    extraChars: '', excludeChars: '', excludeConfusing: false, requireEach: true,
    customOnly: false, customChars: '', username: false, prefix: '', suffix: ''
  });
  assert.equal(page.get('password-form').querySelector('.generate').disabled, true);
  assert.equal(page.get('password-form').getAttribute('aria-busy'), 'true');
  page.submit('password');
  assert.equal(page.messages.filter((message) => message.type === 'generate').length, 1);
});

test('native validity stops requests and range mode disables irrelevant length', () => {
  const page = boot();
  page.get('password-form').valid = false;
  page.submit('password');
  assert.equal(page.last('generate'), undefined);
  page.change('password-range-length', true);
  assert.equal(page.get('password-length').disabled, true);
  assert.equal(page.get('password-range-fields').hidden, false);
  assert.equal(page.get('password-min-length').disabled, false);
});

test('username preset selects lowercase and digits and sends username mode', () => {
  const page = boot();
  page.change('password-custom-only', true);
  page.change('password-preset', 'username');
  page.submit('password');
  const request = page.last('generate').request;
  assert.equal(request.username, true);
  assert.equal(request.lowercase, true);
  assert.equal(request.digits, true);
  assert.equal(request.uppercase, false);
  assert.equal(request.special, false);
  assert.equal(request.customOnly, false);
});

test('password advanced values travel as parameters rather than generated values', () => {
  const page = boot();
  page.change('password-range-length', true);
  page.change('password-min-length', 11);
  page.change('password-max-length', 17);
  page.change('password-extra-chars', 'xyz');
  page.change('password-exclude-chars', 'O0');
  page.change('password-custom-chars', 'abc123');
  page.change('password-custom-only', true);
  page.change('password-prefix', 'pre-');
  page.change('password-suffix', '-post');
  page.submit('password');
  const request = page.last('generate').request;
  assert.equal(request.rangeLength, true);
  assert.equal(request.minLength, 11);
  assert.equal(request.maxLength, 17);
  assert.equal(request.extraChars, 'xyz');
  assert.equal(request.excludeChars, 'O0');
  assert.equal(request.customChars, 'abc123');
  assert.equal(request.customOnly, true);
  assert.equal(request.prefix, 'pre-');
  assert.equal(request.suffix, '-post');
});

test('key algorithm adjusts bytes and generic purpose permits 16–128 bytes', () => {
  const page = boot();
  page.tool('key');
  page.change('key-algorithm', 'HS512');
  assert.equal(page.get('key-bytes').value, '64');
  assert.equal(page.get('key-bytes').min, '64');
  page.submit('key');
  assert.deepEqual(page.last('generate').request, { kind: 'key', count: 1, purpose: 'jwt', algorithm: 'HS512', bytes: 64, encoding: 'base64url' });
  page.result(page.last('generate'));
  page.change('key-purpose', 'generic');
  assert.equal(page.get('key-bytes').min, '16');
  assert.equal(page.get('key-algorithm-field').hidden, true);
  page.change('key-bytes', 16);
  page.change('key-encoding', 'hex');
  page.submit('key');
  assert.equal(page.last('generate').request.bytes, 16);
  assert.equal(page.last('generate').request.encoding, 'hex');
});

test('port presets set ranges, manual range edits select custom and exclusions travel intact', () => {
  const page = boot();
  page.tool('port');
  for (const [preset, minimum, maximum] of [['web', 8000, 9999], ['docker', 8000, 8999], ['micro', 9000, 9999], ['general', 1024, 49151]]) {
    page.change('port-preset', preset);
    assert.equal(page.get('port-min').value, String(minimum));
    assert.equal(page.get('port-max').value, String(maximum));
  }
  page.change('port-min', 1234, 'input');
  assert.equal(page.get('port-preset').value, 'custom');
  page.change('port-preset', 'custom');
  assert.equal(page.get('port-min').value, '1234');
  page.change('port-exclude', '8080,9000-9010');
  page.submit('port');
  assert.deepEqual(page.last('generate').request, { kind: 'port', count: 1, min: 1234, max: 49151, excludeCommon: true, exclude: '8080,9000-9010' });
});

test('result values are read-only and secrets masked until an explicit reveal', () => {
  const page = boot();
  page.init();
  page.submit('password');
  page.result(page.last('generate'), ['<script>bad()</script>']);
  const row = page.get('result-list').children[0];
  const input = row.querySelector('input');
  assert.equal(input.value, '<script>bad()</script>');
  assert.equal(input.type, 'password');
  assert.equal(input.readOnly, true);
  const reveal = row.querySelector('[data-reveal]');
  reveal.emit('click');
  assert.equal(input.type, 'text');
  assert.equal(reveal.getAttribute('aria-pressed'), 'true');
  assert.equal(reveal.textContent, en.hide);
  reveal.emit('click');
  assert.equal(input.type, 'password');
});

test('copy sends only an index, serializes pending copies and never sends result values', () => {
  const page = boot();
  page.init();
  page.submit('password');
  page.result(page.last('generate'), ['secret-one', 'secret-two']);
  page.get('result-list').children[1].querySelector('[data-copy-index]').emit('click');
  const copy = page.last('copy');
  assert.deepEqual(Object.keys(copy).sort(), ['index', 'requestId', 'type']);
  assert.equal(copy.index, 1);
  page.get('copy-all').emit('click');
  assert.equal(page.messages.filter((message) => message.type === 'copy').length, 1);
  page.receive({ type: 'copied', requestId: copy.requestId });
  assert.equal(page.get('status').textContent, en.copied);
  page.get('copy-all').emit('click');
  assert.equal(page.last('copy').index, -1);
  assert.equal(JSON.stringify(page.messages).includes('secret-'), false);
});

test('parameter changes keep previous results and mark pending results stale', () => {
  const page = boot();
  page.init();
  page.submit('password');
  const first = page.last('generate');
  page.change('password-length', 30, 'input');
  page.result(first, ['old-options']);
  assert.equal(page.get('stale').hidden, false);
  assert.equal(page.get('stale-hint').hidden, false);
  page.change('password-count', 2, 'input');
  assert.equal(page.get('result-list').querySelector('input').value, 'old-options');
  page.submit('password');
  page.result(page.last('generate'), ['new-options']);
  assert.equal(page.get('stale').hidden, true);
});

test('tool switches clear host results and reject stale generation replies', () => {
  const page = boot();
  page.submit('password');
  const old = page.last('generate');
  page.tool('key');
  assert.equal(page.last('clear').type, 'clear');
  assert.equal(page.get('results').hidden, true);
  assert.equal(page.get('key-form').querySelector('.generate').disabled, false);
  page.result(old, ['stale-secret']);
  assert.equal(page.get('result-list').children.length, 0);
  page.submit('key');
  const current = page.last('generate');
  page.tool('password');
  page.tool('key');
  page.result(current);
  assert.equal(page.get('result-list').children.length, 0);
});

test('clear discards local values immediately and ignores an old copy acknowledgment', () => {
  const page = boot();
  page.init();
  page.submit('password');
  page.result(page.last('generate'));
  page.get('copy-all').emit('click');
  const copy = page.last('copy');
  page.get('clear').emit('click');
  assert.equal(page.get('result-list').children.length, 0);
  assert.equal(page.get('results').hidden, true);
  assert.deepEqual(Object.keys(page.last('clear')).sort(), ['requestId', 'type']);
  page.receive({ type: 'copied', requestId: copy.requestId });
  assert.equal(page.get('status').textContent, en.clearing);
  page.receive({ type: 'cleared', requestId: page.last('clear').requestId });
  assert.equal(page.get('status').textContent, en.cleared);
});

test('categories have unique membership, native selection and exactly one visible tool', () => {
  const page = boot(); page.init();
  assert.equal(page.get('category-select').value, 'generation');
  assert.equal(page.get('tool-select').value, 'password');
  assert.equal(page.get('current-tool-label').textContent, en.tabPassword);
  assert.equal(page.get('ai-help').getAttribute('open'), null);
  const observed = [];
  for (const [category, kinds] of Object.entries(categories)) {
    page.change('category-select', category);
    assert.deepEqual(page.get('tool-select').options.map((option) => option.value), kinds);
    assert.equal(page.get('tool-select').value, kinds[0]);
    for (const kind of kinds) {
      observed.push(kind);
      page.change('tool-select', kind);
      assert.equal(page.get('panel-' + kind).hidden, false);
      assert.equal(page.document.querySelectorAll('[role="region"]').filter((panel) => !panel.hidden).length, 1);
      assert.equal(page.get('current-tool-label').textContent, page.get('panel-' + kind).getAttribute('aria-label'));
    }
  }
  assert.equal(new Set(observed).size, 9);
  assert.equal(observed.length, 9);
  for (const id of ['category-select', 'tool-select']) {
    for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End']) {
      assert.equal(page.get(id).emit('keydown', { key }).defaultPrevented, false);
    }
  }
  assert.doesNotMatch(app, /addEventListener\('keydown'/);
});

test('localized errors restore generate availability and malformed results fail safely', () => {
  const page = boot();
  page.init(zh, 'zh-cn');
  page.submit('password');
  page.receive({ type: 'error', requestId: page.last('generate').requestId, code: 'emptyCharset' });
  assert.equal(page.get('status').textContent, zh.emptyCharset);
  assert.equal(page.get('password-form').querySelector('.generate').disabled, false);
  page.submit('password');
  page.receive({ type: 'result', requestId: page.last('generate').requestId, values: ['ok', 123], sensitive: true });
  assert.equal(page.get('status').textContent, zh.unknownError);
  assert.equal(page.get('result-list').children.length, 0);
  assert.equal(page.get('password-form').querySelector('.generate').disabled, false);
});

test('unknown ids and mismatched message types cannot mutate results or unblock generation', () => {
  const page = boot();
  page.submit('password');
  const id = page.last('generate').requestId;
  page.receive({ type: 'result', requestId: '2', values: ['wrong'], sensitive: true });
  page.receive({ type: 'result', requestId: id + 1, values: ['wrong'], sensitive: true });
  page.receive({ type: 'copied', requestId: id });
  assert.equal(page.get('result-list').children.length, 0);
  assert.equal(page.get('password-form').querySelector('.generate').disabled, true);
  page.receive({ type: 'error', requestId: id, code: 'unknown-code' });
  assert.equal(page.get('status').textContent, en.unknownError);
});

test('port inspection delegates to host and does not claim availability on a miss', () => {
  const page = boot();
  page.init();
  page.tool('port');
  page.get('inspect-form').emit('submit');
  const lookup = page.last('inspectPort');
  assert.deepEqual(Object.keys(lookup).sort(), ['port', 'requestId', 'type']);
  assert.equal(lookup.port, 8080);
  page.receive({ type: 'portInfo', requestId: lookup.requestId, port: 8080, category: 'registered' });
  assert.equal(page.get('inspect-info').hidden, false);
  assert.match(page.get('inspect-info').textContent, /no common service listed/);
  assert.match(page.get('inspect-info').textContent, /does not confirm availability/);
  page.get('inspect-form').emit('submit');
  const next = page.last('inspectPort');
  page.receive({ type: 'portInfo', requestId: next.requestId, port: 8080, service: '<script>service</script>', category: 'registered' });
  assert.ok(page.get('inspect-info').textContent.includes('<script>service</script>'));
  assert.equal(page.get('inspect-info').children.length, 0);
});

test('editing an inspection port invalidates its old response', () => {
  const page = boot();
  page.tool('port');
  page.get('inspect-form').emit('submit');
  const old = page.last('inspectPort');
  page.change('inspect-port', 8443, 'input');
  assert.equal(page.get('inspect-button').disabled, false);
  page.receive({ type: 'portInfo', requestId: old.requestId, port: 8080, category: 'registered' });
  assert.equal(page.get('inspect-info').hidden, true);
});

const utilityKinds = ['uuid', 'hash', 'timestamp', 'base64', 'url', 'jwt'];
const toolInputIds = ['hash-input', 'timestamp-input', 'base64-input', 'url-input', 'jwt-input'];
const utilityCases = [
  ['uuid', { 'uuid-count': 100, 'uuid-format': 'compact', 'uuid-uppercase': true }, { kind: 'uuid', count: 100, format: 'compact', uppercase: true }],
  ['hash', { 'hash-input': '秘密\ntext', 'hash-algorithm': 'sha512', 'hash-encoding': 'base64' }, { kind: 'hash', input: '秘密\ntext', algorithm: 'sha512', encoding: 'base64' }],
  ['timestamp', { 'timestamp-input': '2026-01-01T00:00:00+08:00', 'timestamp-operation': 'toTimestamp', 'timestamp-unit': 'milliseconds' }, { kind: 'timestamp', input: '2026-01-01T00:00:00+08:00', operation: 'toTimestamp', unit: 'milliseconds' }],
  ['base64', { 'base64-input': 'SGVsbG8', 'base64-variant': 'base64url', 'base64-operation': 'decode', 'base64-format': 'hex' }, { kind: 'base64', input: 'SGVsbG8', variant: 'base64url', operation: 'decode', format: 'hex' }],
  ['url', { 'url-input': 'https://user:secret@example.test/path?q=a#fragment' }, { kind: 'url', input: 'https://user:secret@example.test/path?q=a#fragment' }],
  ['jwt', { 'jwt-input': 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signature' }, { kind: 'jwt', input: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signature' }]
];

for (const [kind, fields, expected] of utilityCases) {
  test(`${kind} submits a complete process request and shares the pending boundary`, () => {
    const page = boot(); page.init(zh, 'zh-cn'); page.tool(kind);
    for (const [id, value] of Object.entries(fields)) page.change(id, value, 'input');
    page.submit(kind);
    const request = page.last('process');
    assert.deepEqual(request.request, expected);
    assert.deepEqual(Object.keys(request).sort(), ['request', 'requestId', 'type']);
    assert.equal(page.last('generate'), undefined);
    assert.equal(page.get('status').textContent, zh.processStatus);
    assert.equal(page.get(`${kind}-form`).getAttribute('aria-busy'), 'true');
    for (const button of page.document.querySelectorAll('.generate')) assert.equal(button.disabled, true);
    page.submit(kind);
    assert.equal(page.messages.filter((message) => message.type === 'process').length, 1);
    page.result(request, ['result'], false);
    assert.equal(page.get(`${kind}-form`).getAttribute('aria-busy'), 'false');
    assert.equal(page.get(`${kind}-form`).querySelector('.generate').disabled, false);
    assert.equal(page.get('status').textContent, zh.processed.replace('{count}', '1'));
  });
}

test('utility controls are bounded, native, labelled and explicitly clearable', () => {
  const page = boot();
  for (const kind of utilityKinds) {
    assert.equal(page.get(`${kind}-form`).querySelector('.clear-tool').type, 'button');
    assert.ok(page.get(`${kind}-form`).querySelector('.generate'));
  }
  for (const id of toolInputIds) {
    const input = page.get(id);
    assert.equal(input.getAttribute('maxlength'), '65536');
    assert.equal(input.getAttribute('autocomplete'), 'off');
    assert.equal(input.getAttribute('spellcheck'), 'false');
    assert.equal(input.getAttribute('autocapitalize'), 'off');
    for (const description of input.getAttribute('aria-describedby').split(' ')) assert.ok(page.get(description));
  }
  assert.equal(page.get('uuid-count').min, '1');
  assert.equal(page.get('uuid-count').max, '100');
  assert.match(css, /\.tool-navigation \{/);
  assert.match(css, /\.field-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/);
  assert.doesNotMatch(css, /\.tabs?\b/);
  assert.match(css, /\.result-row textarea \{[^}]*overflow-wrap: anywhere/);
});

test('native utility validity blocks processing and inactive forms cannot send requests', () => {
  const page = boot(); page.tool('url');
  page.get('url-form').valid = false;
  page.submit('url'); page.submit('jwt');
  assert.equal(page.last('process'), undefined);
});

test('sensitive utility textareas reveal explicitly, remain copyable when hidden and never interpret HTML', () => {
  const payload = '</textarea><script>bad()</script>\n<img src=x onerror=bad()>';
  for (const kind of ['hash', 'base64', 'url', 'jwt']) {
    const page = boot(); page.init(); page.tool(kind); page.submit(kind);
    // The UI also masks a sensitive tool if the host accidentally marks its result public.
    page.result(page.last('process'), [payload], false);
    const row = page.get('result-list').children[0];
    const textarea = row.querySelector('textarea');
    const mask = row.querySelector('[data-result-mask]');
    const reveal = row.querySelector('[data-reveal]');
    assert.equal(textarea.value, payload);
    assert.equal(textarea.readOnly, true);
    assert.equal(textarea.children.length, 0);
    assert.equal(textarea.hidden, true);
    assert.equal(mask.value, '');
    assert.equal(mask.hidden, false);
    assert.equal(mask.getAttribute('placeholder'), en.resultHidden);
    assert.equal(reveal.textContent, en.show);
    row.querySelector('[data-copy-index]').emit('click');
    assert.deepEqual(Object.keys(page.last('copy')).sort(), ['index', 'requestId', 'type']);
    assert.equal(page.last('copy').index, 0);
    assert.equal(textarea.hidden, true);
    assert.equal(JSON.stringify(page.messages).includes(payload), false);
    reveal.emit('click');
    assert.equal(textarea.hidden, false); assert.equal(mask.hidden, true);
    assert.equal(reveal.getAttribute('aria-pressed'), 'true');
    page.init(zh, 'zh-cn');
    assert.equal(reveal.textContent, zh.hide);
    assert.equal(textarea.getAttribute('aria-label'), zh.resultLabel.replace('{index}', '1'));
    reveal.emit('click');
    assert.equal(textarea.hidden, true); assert.equal(mask.hidden, false);
    assert.equal(reveal.getAttribute('aria-pressed'), 'false');
    page.get('clear').emit('click');
    assert.equal(textarea.value, ''); assert.equal(mask.value, '');
    assert.equal(page.get('result-list').children.length, 0);
  }
});

test('UUID and timestamp show public multiline results with static contextual metadata', () => {
  for (const kind of ['uuid', 'timestamp']) {
    const page = boot(); page.init(); page.tool(kind); page.submit(kind);
    const payload = '{\n  "utc": "2026-01-01T00:00:00Z"\n}';
    page.result(page.last('process'), [payload], false);
    const row = page.get('result-list').children[0];
    assert.equal(row.querySelector('textarea').value, payload);
    assert.equal(row.querySelector('textarea').hidden, false);
    assert.equal(row.querySelector('textarea').rows, 3);
    assert.equal(row.querySelector('[data-reveal]'), null);
    assert.equal(row.querySelector('input'), null);
    assert.equal(page.get('result-info').textContent, en[`${kind}Notice`]);
  }
});

test('empty text output is a valid result with individual and batch copy', () => {
  const page = boot(); page.init(); page.tool('base64'); page.submit('base64');
  assert.equal(page.last('process').request.input, '');
  page.result(page.last('process'), [''], true);
  assert.equal(page.get('result-list').children.length, 1);
  assert.equal(page.get('result-list').querySelector('textarea').value, '');
  assert.equal(page.get('copy-all').disabled, false);
  page.get('result-list').querySelector('[data-copy-index]').emit('click');
  assert.equal(page.last('copy').index, 0);
  page.receive({ type: 'copied', requestId: page.last('copy').requestId });
  page.get('copy-all').emit('click');
  assert.equal(page.last('copy').index, -1);
});

test('utility edits retain sensitive input and mark the previous request and result stale', () => {
  const page = boot(); page.init(); page.tool('hash'); page.change('hash-input', 'secret-input', 'input');
  page.submit('hash'); const request = page.last('process');
  page.change('hash-algorithm', 'md5');
  assert.equal(page.get('hash-input').value, 'secret-input');
  page.result(request, ['old-digest'], true);
  assert.equal(page.get('stale').hidden, false);
  page.change('hash-input', 'changed-secret', 'input');
  assert.equal(page.get('hash-input').value, 'changed-secret');
  assert.equal(page.get('result-list').querySelector('textarea').value, 'old-digest');
  page.submit('hash'); page.result(page.last('process'), ['new-digest'], true);
  assert.equal(page.get('stale').hidden, true);
});

test('switch, clear, sign-out and blocking wipe every utility text input but keep original parameters', () => {
  for (const boundary of ['switch', 'clear', 'notSignedIn', 'blocked']) {
    const page = boot(); page.init(); page.tool('jwt');
    page.change('password-prefix', 'keep-prefix'); page.change('key-bytes', 64); page.change('port-exclude', '9000');
    page.change('uuid-format', 'compact');
    for (const id of toolInputIds) page.change(id, `sensitive-${id}`, 'input');
    const before = page.messages.length;
    if (boundary === 'switch') page.tool('password');
    else if (boundary === 'clear') page.get('jwt-form').querySelector('.clear-tool').emit('click');
    else page.receive({ type: 'error', requestId: -1, code: boundary });
    for (const id of toolInputIds) assert.equal(page.get(id).value, '', `${boundary}: ${id}`);
    assert.equal(page.get('password-prefix').value, 'keep-prefix');
    assert.equal(page.get('key-bytes').value, '64');
    assert.equal(page.get('port-exclude').value, '9000');
    assert.equal(page.get('uuid-format').value, 'compact');
    assert.equal(JSON.stringify(page.messages.slice(before)).includes('sensitive-'), false);
    assert.equal(page.get('results').hidden, true);
  }
  const reload = boot();
  for (const id of toolInputIds) assert.equal(reload.get(id).value, '');
});

test('explicit utility clear works before results, without a host, and discards pending replies', () => {
  for (const host of [true, false]) {
    const page = boot({ host }); page.tool('url'); page.change('url-input', 'https://secret@example.test', 'input');
    page.submit('url'); const old = page.last('process');
    page.get('url-form').querySelector('.clear-tool').emit('click');
    assert.equal(page.get('url-input').value, '');
    assert.equal(page.get('results').hidden, true);
    if (old) page.result(old, ['late-result'], true);
    assert.equal(page.get('result-list').children.length, 0);
  }
});

test('process ignores unknown, nonnumeric, mismatched and switched-away replies', () => {
  const page = boot(); page.init(); page.tool('jwt'); page.submit('jwt');
  const old = page.last('process');
  page.receive({ type: 'result', requestId: String(old.requestId), values: ['wrong'], sensitive: true });
  page.receive({ type: 'result', requestId: old.requestId + 1, values: ['wrong'], sensitive: true });
  page.receive({ type: 'copied', requestId: old.requestId });
  assert.equal(page.get('jwt-form').querySelector('.generate').disabled, true);
  assert.equal(page.get('result-list').children.length, 0);
  page.tool('url'); page.tool('jwt'); page.submit('jwt');
  const current = page.last('process');
  page.result(old, ['stale-result'], true);
  assert.equal(page.get('jwt-form').querySelector('.generate').disabled, true);
  assert.equal(page.get('result-list').children.length, 0);
  page.result(current, ['current-result'], true);
  assert.equal(page.get('result-list').querySelector('textarea').value, 'current-result');
});

test('localized process errors release pending state and resource failures never create large DOM output', () => {
  const failures = ['invalidRequest', 'inputTooLarge', 'outputTooLarge', 'invalidText', 'invalidHash', 'invalidBase64', 'invalidUtf8', 'invalidTimestamp', 'invalidDate', 'invalidUrl', 'invalidJwt', 'invalidUuidFormat', 'invalidCount'];
  for (const code of failures) {
    const page = boot(); page.init(zh, 'zh-cn'); page.tool('hash'); page.submit('hash');
    page.receive({ type: 'error', requestId: page.last('process').requestId, code });
    assert.equal(page.get('status').textContent, zh[code]);
    assert.equal(page.get('hash-form').querySelector('.generate').disabled, false);
    assert.equal(page.get('hash-form').getAttribute('aria-busy'), 'false');
  }
  for (const values of [[], ['ok', 123], Array(101).fill('x'), ['x'.repeat(131073)], ['x'.repeat(65536), 'x'.repeat(65537)]]) {
    const page = boot(); page.init(); page.tool('hash'); page.submit('hash');
    page.result(page.last('process'), values, true);
    assert.equal(page.get('result-list').children.length, 0);
    assert.equal(page.get('hash-form').querySelector('.generate').disabled, false);
    const oversized = values.every((value) => typeof value === 'string') && values.reduce((sum, value) => sum + value.length, 0) > 131072;
    assert.equal(page.get('status').textContent, oversized ? en.outputTooLarge : en.unknownError);
  }
  const page = boot(); page.init(); page.tool('base64'); page.submit('base64');
  page.result(page.last('process'), ['x'.repeat(131072)], true);
  assert.equal(page.get('result-list').querySelector('textarea').value.length, 131072);
});

test('tool notices state security limits without claiming verification or network requests', () => {
  assert.match(en.jwtNotice, /not verified/); assert.match(en.jwtNotice, /No signature validation or authorization/);
  assert.match(zh.jwtNotice, /未经验证/); assert.match(zh.jwtNotice, /不验证签名/);
  assert.match(en.hashNotice, /MD5 and SHA-1/); assert.match(en.hashNotice, /not password-storage/);
  assert.match(en.base64Notice, /not encryption/);
  assert.match(en.urlNotice, /without requesting or opening/);
  assert.match(en.timestampNotice, /explicit ISO timezone/);
  assert.match(zh.timestampNotice, /ISO 时区/);
});

test('prompt requests omit password free-form characters, affixes and existing results', () => {
  const page = boot(); page.init();
  for (const field of ['special-chars', 'extra-chars', 'exclude-chars', 'custom-chars', 'prefix', 'suffix']) page.change('password-' + field, 'SECRET-' + field);
  page.change('password-count', 3); page.change('password-length', 32); page.change('password-custom-only', true);
  page.submit('password'); page.result(page.last('generate'), ['GENERATED-SECRET']);
  const before = page.messages.length;
  page.get('copy-prompt').emit('click');
  const message = page.last('copyPrompt');
  assert.deepEqual(Object.keys(message).sort(), ['request', 'requestId', 'type']);
  assert.deepEqual(message.request, {
    kind: 'password', count: 3, length: 32, minLength: 16, maxLength: 24, rangeLength: false,
    lowercase: true, uppercase: true, digits: true, special: true, excludeConfusing: false,
    requireEach: true, customOnly: true, username: false
  });
  assert.equal(typeof message.requestId, 'number');
  assert.equal(JSON.stringify(page.messages.slice(before)).includes('SECRET'), false);
  assert.equal(page.get('copy-prompt').disabled, true);
  assert.equal(page.get('copy-prompt').getAttribute('aria-busy'), 'true');
  page.get('copy-prompt').emit('click');
  assert.equal(page.messages.filter((entry) => entry.type === 'copyPrompt').length, 1);
  page.receive({ type: 'promptCopied', requestId: message.requestId });
  assert.equal(page.get('status').textContent, en.promptCopied);
  assert.equal(page.get('copy-prompt').disabled, false);
  assert.equal(page.get('copy-prompt').getAttribute('aria-busy'), 'false');
  assert.equal(page.get('result-list').querySelector('input').value, 'GENERATED-SECRET');
});

test('prompt requests keep numeric key, port and UUID options but omit port exclusions', () => {
  const cases = [
    ['key', { 'key-count': 4, 'key-bytes': 48, 'key-encoding': 'hex' }, { kind: 'key', count: 4, purpose: 'jwt', algorithm: 'HS256', bytes: 48, encoding: 'hex' }],
    ['port', { 'port-count': 3, 'port-min': 8000, 'port-max': 9000, 'port-exclude-common': false, 'port-exclude': 'PRIVATE-PORT-TEXT' }, { kind: 'port', count: 3, min: 8000, max: 9000, excludeCommon: false }],
    ['uuid', { 'uuid-count': 5, 'uuid-format': 'compact', 'uuid-uppercase': true }, { kind: 'uuid', count: 5, format: 'compact', uppercase: true }]
  ];
  for (const [kind, fields, expected] of cases) {
    const page = boot(); page.init(); page.tool(kind);
    for (const [id, value] of Object.entries(fields)) page.change(id, value);
    page.get('copy-prompt').emit('click');
    assert.deepEqual(page.last('copyPrompt').request, expected);
    assert.equal(JSON.stringify(page.last('copyPrompt')).includes('PRIVATE'), false);
  }
});

for (const [kind, fields, expected] of utilityCases.filter(([kind]) => kind !== 'uuid')) {
  test(`${kind} prompt omits typed text and copies without native input validation`, () => {
    const page = boot(); page.init(zh, 'zh-cn'); page.tool(kind);
    for (const [id, value] of Object.entries(fields)) page.change(id, value);
    page.get(kind + '-form').valid = false;
    page.get('copy-prompt').emit('click');
    assert.deepEqual(page.last('copyPrompt').request, { ...expected, input: '' });
    assert.equal(page.last('process'), undefined);
    assert.equal(page.get(kind + '-input').value, fields[kind + '-input']);
    page.receive({ type: 'promptCopied', requestId: page.last('copyPrompt').requestId });
    assert.equal(page.get('status').textContent, zh.promptCopied);
    page.get('copy-prompt').emit('click');
    assert.equal(page.last('copyPrompt').request.input, '');
  });
}

test('empty utility prompt input is allowed and invalid numeric options report host errors', () => {
  const page = boot(); page.init(zh, 'zh-cn'); page.tool('url');
  page.get('url-form').valid = false;
  page.get('copy-prompt').emit('click');
  assert.deepEqual(page.last('copyPrompt').request, { kind: 'url', input: '' });
  page.receive({ type: 'promptCopied', requestId: page.last('copyPrompt').requestId });
  page.tool('key'); page.change('key-count', 'not-a-number');
  page.get('key-form').valid = false; page.get('copy-prompt').emit('click');
  assert.equal(page.last('copyPrompt').request.count, null);
  page.receive({ type: 'error', requestId: page.last('copyPrompt').requestId, code: 'invalidCount' });
  assert.equal(page.get('status').textContent, zh.invalidCount);
  assert.equal(page.get('copy-prompt').disabled, false);
});

test('prompt acknowledgments require the exact id and type and are discarded on tool switch or clear', () => {
  for (const boundary of ['switch', 'clear']) {
    const page = boot(); page.init(); page.get('copy-prompt').emit('click');
    const old = page.last('copyPrompt');
    page.receive({ type: 'promptCopied', requestId: String(old.requestId) });
    page.receive({ type: 'promptCopied', requestId: old.requestId + 1 });
    page.receive({ type: 'copied', requestId: old.requestId });
    assert.equal(page.get('copy-prompt').disabled, true);
    if (boundary === 'switch') page.tool('key');
    else page.get('clear').emit('click');
    page.get('copy-prompt').emit('click');
    const current = page.last('copyPrompt');
    page.receive({ type: 'promptCopied', requestId: old.requestId, prompt: 'UNTRUSTED-TEXT' });
    assert.equal(page.get('copy-prompt').disabled, true);
    assert.equal(page.get('status').textContent, en.copyingPrompt);
    page.receive({ type: 'promptCopied', requestId: current.requestId, prompt: 'UNTRUSTED-TEXT' });
    assert.equal(page.get('status').textContent, en.promptCopied);
    assert.equal(page.get('status').children.length, 0);
    assert.equal(page.get('copy-prompt').disabled, false);
  }
});

test('missing, null, throwing and denied hosts cannot copy prompts or inject AI results', () => {
  for (const options of [{ host: false }, { host: null }, { acquireThrows: true }, { postThrows: true }]) {
    const page = boot(options);
    assert.equal(page.get('copy-prompt').disabled, true);
    page.get('copy-prompt').emit('click');
    page.receive({ type: 'agentResult', kind: 'key', values: ['secret'], sensitive: true });
    assert.equal(page.last('copyPrompt'), undefined);
    assert.equal(page.get('result-list').children.length, 0);
    page.tool('jwt'); assert.equal(page.get('panel-jwt').hidden, false);
  }
  for (const code of ['notSignedIn', 'blocked']) {
    const page = boot(); page.init(); page.get('copy-prompt').emit('click'); const old = page.last('copyPrompt');
    page.receive({ type: 'error', requestId: -1, code });
    page.receive({ type: 'promptCopied', requestId: old.requestId });
    page.receive({ type: 'agentResult', kind: 'password', values: ['secret'], sensitive: true });
    assert.equal(page.get('status').textContent, en[code]);
    assert.equal(page.get('copy-prompt').disabled, true);
    assert.equal(page.get('result-list').children.length, 0);
    page.init(); assert.equal(page.get('copy-prompt').disabled, false);
  }
});

test('AI password and key results switch categories, cancel old requests and always mask values', () => {
  for (const kind of ['password', 'key']) {
    const page = boot(); page.init(zh, 'zh-cn'); page.tool('jwt');
    for (const id of toolInputIds) page.change(id, 'PRIVATE-INPUT', 'input');
    page.submit('jwt'); const old = page.last('process');
    page.get('copy-prompt').emit('click'); const oldPrompt = page.last('copyPrompt');
    const before = page.messages.length;
    page.receive({ type: 'agentResult', kind, values: ['</input><script>PRIVATE-RESULT</script>'], sensitive: false, metadata: { input: 'IGNORED-INPUT' } });
    assert.equal(page.get('category-select').value, 'generation');
    assert.equal(page.get('tool-select').value, kind);
    assert.deepEqual(page.get('tool-select').options.map((entry) => entry.value), categories.generation);
    assert.equal(page.get('panel-' + kind).hidden, false);
    assert.equal(page.messages.length, before, 'AI results must not clear the new host-owned result batch');
    for (const id of toolInputIds) assert.equal(page.get(id).value, '');
    const input = page.get('result-list').querySelector('input');
    assert.equal(input.type, 'password'); assert.equal(input.readOnly, true);
    assert.equal(input.value, '</input><script>PRIVATE-RESULT</script>');
    assert.equal(input.children.length, 0);
    assert.equal(page.get('result-info').textContent, zh.aiResultNotice);
    assert.equal(page.get('status').textContent, zh.aiGenerated.replace('{count}', '1'));
    assert.equal(page.get('copy-prompt').disabled, false);
    assert.equal(page.get(kind + '-form').querySelector('.generate').disabled, false);
    page.result(old, ['LATE-RESULT'], false);
    page.receive({ type: 'promptCopied', requestId: oldPrompt.requestId });
    assert.equal(input.value, '</input><script>PRIVATE-RESULT</script>');
    assert.equal(page.get('status').textContent, zh.aiGenerated.replace('{count}', '1'));
    page.get('copy-all').emit('click');
    assert.deepEqual(Object.keys(page.last('copy')).sort(), ['index', 'requestId', 'type']);
    assert.equal(JSON.stringify(page.messages.slice(before)).includes('PRIVATE'), false);
  }
});

test('AI delivery replaces old local results and copy acknowledgments even on the same tool', () => {
  const page = boot(); page.init(); page.submit('password'); page.result(page.last('generate'), ['OLD-SECRET']);
  const oldInput = page.get('result-list').querySelector('input');
  page.get('copy-all').emit('click'); const oldCopy = page.last('copy');
  page.receive({ type: 'agentResult', kind: 'password', values: ['NEW-SECRET'], sensitive: true });
  assert.equal(oldInput.value, '');
  page.receive({ type: 'copied', requestId: oldCopy.requestId });
  assert.equal(page.get('status').textContent, en.aiGenerated.replace('{count}', '1'));
  assert.equal(page.get('result-list').querySelector('input').value, 'NEW-SECRET');
  assert.equal(page.get('result-list').querySelector('input').type, 'password');
});

test('AI result validation rejects other kinds, request ids, malformed values and oversized batches', () => {
  for (const message of [
    { kind: 'hash', values: ['x'] }, { kind: '__proto__', values: ['x'] }, { kind: 'url', values: ['x'] },
    { kind: 'password', requestId: 1, values: ['x'] }, { kind: 'password', values: null },
    { kind: 'key', values: [] }, { kind: 'key', values: ['', 'x'] }, { kind: 'key', values: ['x', 42] },
    { kind: 'password', values: Array(101).fill('x') }, { kind: 'key', values: ['x'.repeat(131073)] }
  ]) {
    const page = boot(); page.init(); page.tool('url');
    page.receive({ type: 'agentResult', sensitive: true, ...message });
    assert.equal(page.get('result-list').children.length, 0);
    assert.equal(page.get('tool-select').value, 'url');
    assert.equal(page.get('panel-url').hidden, false);
  }
  const page = boot(); page.init();
  page.receive({ type: 'agentResult', kind: 'key', values: Array(100).fill('safe'), sensitive: true });
  assert.equal(page.get('result-list').children.length, 100);
  for (const input of page.get('result-list').querySelectorAll('input')) assert.equal(input.type, 'password');
});

test('unknown and cross-category select values cannot activate unregistered tools', () => {
  const page = boot(); page.init();
  page.change('tool-select', 'hash');
  assert.equal(page.get('tool-select').value, 'password');
  page.change('category-select', '__proto__');
  assert.equal(page.get('category-select').value, 'generation');
  page.change('tool-select', 'unregistered');
  assert.equal(page.get('tool-select').value, 'password');
  assert.equal(page.get('panel-password').hidden, false);
});

test('AI help and success strings disclose user paste, permission and model visibility', () => {
  assert.match(en.aiHelpPrompt, /paste.*yourself/i); assert.match(en.aiHelpPrompt, /nothing is sent automatically/);
  assert.match(en.aiHelpPermission, /agent\.tools/); assert.match(en.aiHelpData, /input text and outputs.*model/);
  assert.match(en.aiHelpSecrets, /only in their tool panel/); assert.match(en.aiHelpSecrets, /not returned to the model/);
  assert.match(zh.aiHelpPrompt, /自行粘贴/); assert.match(zh.promptCopied, /不包含输入或结果/);
  assert.match(zh.aiHelpSecrets, /不会将值返回给模型/);
  assert.match(html, /Results show UTC, Unix seconds and milliseconds/);
  assert.doesNotMatch(html, /local time/);
});
