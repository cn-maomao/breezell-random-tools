(() => {
  'use strict';

  const byId = (id) => document.getElementById(id);
  const tools = ['password', 'key', 'port', 'uuid', 'hash', 'base64', 'jwt', 'url', 'timestamp'];
  const categories = { generation: ['password', 'key', 'port', 'uuid'], security: ['hash', 'base64', 'jwt'], parsing: ['url', 'timestamp'] };
  const toolLabels = { password: 'tabPassword', key: 'tabKey', port: 'tabPort', uuid: 'tabUuid', hash: 'tabHash', base64: 'tabBase64', jwt: 'tabJwt', url: 'tabUrl', timestamp: 'tabTimestamp' };
  const utilityKinds = new Set(['uuid', 'hash', 'timestamp', 'base64', 'url', 'jwt']);
  const sensitiveKinds = new Set(['password', 'key', 'hash', 'base64', 'url', 'jwt']);
  const utilityNotices = { uuid: 'uuidNotice', hash: 'hashNotice', timestamp: 'timestampNotice', base64: 'base64Notice', url: 'urlNotice', jwt: 'jwtNotice' };
  const forms = Object.fromEntries(tools.map((kind) => [kind, byId(`${kind}-form`)]));
  const utilityInputs = Array.from(document.querySelectorAll('[data-tool-input]'));
  const maximumOutputCharacters = 131072;
  const requests = new Map();
  const algorithmBytes = { HS256: 32, HS384: 48, HS512: 64 };
  const portPresets = { general: [1024, 49151], web: [8000, 9999], docker: [8000, 8999], micro: [9000, 9999] };
  const fallback = {
    ready: 'Ready', generating: 'Generating…', processStatus: 'Processing…', results: 'Results', resultLabel: 'Result {index}',
    generated: 'Generated {count} result(s).', processed: 'Processed {count} result(s).',
    resultHidden: 'Result hidden. Select Show to reveal.', outputTooLarge: 'The output exceeds the safety limit.',
    show: 'Show', hide: 'Hide', copy: 'Copy',
    tabPassword: 'Password', tabKey: 'Key', tabPort: 'Port', tabUuid: 'UUID', tabHash: 'Hash',
    tabBase64: 'Base64', tabJwt: 'JWT decode', tabUrl: 'URL', tabTimestamp: 'Timestamp',
    labelToolCategory: 'Tool category', labelTool: 'Tool', toolCategoryGeneration: 'Random generation',
    toolCategorySecurity: 'Encoding & security', toolCategoryParsing: 'Parsing & time',
    copyPrompt: 'Copy AI prompt', copyingPrompt: 'Copying AI prompt…',
    promptCopied: 'AI prompt copied without inputs or results. Paste it into the chat yourself.',
    aiHelpTitle: 'Use tools with AI',
    aiHelpPrompt: 'Copy a prompt for the current tool, then paste it into the chat yourself. Inputs and results are not included, and nothing is sent automatically.',
    aiHelpPermission: 'Enable agent.tools and allow the tool in the host before AI can call it.',
    aiHelpData: 'For other tools, parameters, input text and outputs may be visible to the model. Never submit secrets or private data.',
    aiHelpSecrets: 'AI-generated passwords and keys are shown only in their tool panel, masked by default; their values are not returned to the model.',
    aiGenerated: 'AI generated {count} result(s). Values are shown only in this tool panel, not returned to the model.',
    aiResultNotice: 'AI-generated password or key. The values stay in this tool panel and are not returned to the model.',
    copied: 'Copied. Clear sensitive clipboard contents after use.', cleared: 'Inputs and results cleared.',
    clearing: 'Clearing…', copying: 'Copying…', inspecting: 'Looking up…',
    hostOnly: 'Open this page in Breezell to generate and copy results.',
    unknownError: 'The operation could not be completed.',
    staleStatus: 'Settings changed. Existing results use the previous settings.',
    inspectNoMatch: 'Port {port}: no common service listed. Category: {category}. This does not confirm availability.',
    inspectMatch: 'Port {port}: {service}. Category: {category}. This does not confirm availability.',
    categorySystem: 'system', categoryRegistered: 'registered', categoryDynamic: 'dynamic'
  };
  let strings = fallback;
  let host;
  let accessDenied = null;
  let activeTool = 'password';
  let sequence = 0;
  let generationId = null;
  let inspectId = null;
  let copyId = null;
  let promptId = null;
  let resultVersion = 0;
  let resultCount = 0;
  let statusKey = 'ready';
  let statusParameters = {};

  try {
    if (typeof acquireVsCodeApi === 'function') host = acquireVsCodeApi();
  } catch {
    host = undefined;
  }

  function text(key, parameters = {}) {
    const template = typeof strings[key] === 'string' ? strings[key] : (fallback[key] || key);
    return template.replace(/\{([A-Za-z]+)\}/g, (match, name) => Object.prototype.hasOwnProperty.call(parameters, name) ? String(parameters[name]) : match);
  }

  function setStatus(key, parameters = {}) {
    statusKey = key;
    statusParameters = parameters;
    byId('status').textContent = text(key, parameters);
  }

  function applyStrings() {
    for (const element of document.querySelectorAll('[data-i18n]')) {
      const key = element.getAttribute('data-i18n');
      if (typeof strings[key] === 'string') element.textContent = strings[key];
    }
    for (const attribute of ['aria-label', 'placeholder']) {
      for (const element of document.querySelectorAll(`[data-i18n-${attribute}]`)) {
        const key = element.getAttribute(`data-i18n-${attribute}`);
        if (typeof strings[key] === 'string') element.setAttribute(attribute, strings[key]);
      }
    }
    document.title = text('appTitle');
    populateToolOptions();
    refreshResultLabels();
    setStatus(statusKey, statusParameters);
  }

  function setHostUnavailable() {
    host = undefined;
    generationId = null;
    copyId = null;
    promptId = null;
    inspectId = null;
    requests.clear();
    clearToolInputs();
    resetResults();
    byId('inspect-info').hidden = true;
    byId('host-warning').hidden = false;
    setStatus('hostOnly');
    updateButtons();
  }

  function post(type, payload = {}, context = {}) {
    if (!host || typeof host.postMessage !== 'function') return null;
    const requestId = ++sequence;
    requests.set(requestId, { type, tab: activeTool, version: resultVersion, ...context });
    try {
      host.postMessage({ ...payload, type, requestId });
      return requestId;
    } catch {
      setHostUnavailable();
      return null;
    }
  }

  function updateButtons() {
    const unavailable = !host || accessDenied !== null;
    for (const button of document.querySelectorAll('.generate')) button.disabled = unavailable || generationId !== null;
    for (const button of document.querySelectorAll('[data-copy-index]')) button.disabled = unavailable || copyId !== null;
    byId('copy-all').disabled = unavailable || resultCount === 0 || copyId !== null;
    byId('clear').disabled = unavailable || resultCount === 0;
    byId('inspect-button').disabled = unavailable || inspectId !== null;
    byId('copy-prompt').disabled = unavailable || promptId !== null;
    byId('copy-prompt').setAttribute('aria-busy', String(promptId !== null));
    byId('results').setAttribute('aria-busy', String(copyId !== null));
    for (const [kind, form] of Object.entries(forms)) form.setAttribute('aria-busy', String(kind === activeTool && generationId !== null));
  }

  function clearToolInputs() {
    // Utility input can include tokens or URL credentials; only explicit lifecycle boundaries clear it.
    for (const input of utilityInputs) input.value = '';
  }

  function resetResults() {
    // A cleared or switched panel must never accept an older generation reply.
    generationId = null;
    copyId = null;
    promptId = null;
    resultVersion += 1;
    resultCount = 0;
    for (const tag of ['input', 'textarea']) {
      for (const input of byId('result-list').querySelectorAll(tag)) input.value = '';
    }
    byId('result-list').replaceChildren();
    byId('results').hidden = true;
    byId('stale').hidden = true;
    byId('stale-hint').hidden = true;
    byId('result-info').textContent = '';
    byId('result-info').hidden = true;
    updateButtons();
  }

  function clearResults(announce = true) {
    clearToolInputs();
    requests.clear();
    inspectId = null;
    resetResults();
    const id = post('clear', {}, { announce });
    if (announce) setStatus(accessDenied || (id !== null ? 'clearing' : 'cleared'));
    updateButtons();
  }

  function populateToolOptions() {
    const category = Object.keys(categories).find((key) => categories[key].includes(activeTool));
    byId('category-select').value = category;
    const options = categories[category].map((kind) => {
      const option = document.createElement('option');
      option.value = kind;
      option.setAttribute('data-i18n', toolLabels[kind]);
      option.textContent = text(toolLabels[kind]);
      return option;
    });
    byId('tool-select').replaceChildren(...options);
    byId('tool-select').value = activeTool;
    byId('current-tool-label').setAttribute('data-i18n', toolLabels[activeTool]);
    byId('current-tool-label').textContent = text(toolLabels[activeTool]);
  }

  function activateTool(kind, clearHost = true) {
    if (!tools.includes(kind)) return;
    if (kind !== activeTool) {
      if (clearHost) clearResults(false);
      activeTool = kind;
      byId('inspect-info').hidden = true;
      setStatus(accessDenied || (host ? 'ready' : 'hostOnly'));
    }
    populateToolOptions();
    for (const tool of tools) byId(`panel-${tool}`).hidden = tool !== activeTool;
    updateButtons();
  }

  function markStale() {
    if (resultCount > 0 || generationId !== null) {
      // Input edits retain results, but replies generated with previous options are stale too.
      if (generationId !== null) {
        const request = requests.get(generationId);
        if (request) request.stale = true;
      }
      if (resultCount > 0) {
        byId('stale').hidden = false;
        byId('stale-hint').hidden = false;
        setStatus('staleStatus');
      }
    }
  }

  const number = (id) => Number(byId(id).value);
  const checked = (id) => byId(id).checked;
  const value = (id) => byId(id).value;

  function selectedOption(id, allowed, prompt) {
    const selected = value(id);
    return !prompt || allowed.includes(selected) ? selected : '';
  }

  function buildRequest(kind, prompt = false) {
    if (kind === 'password') {
      return {
        kind, count: number('password-count'), length: number('password-length'),
        minLength: number('password-min-length'), maxLength: number('password-max-length'),
        rangeLength: checked('password-range-length'), lowercase: checked('password-lowercase'),
        uppercase: checked('password-uppercase'), digits: checked('password-digits'),
        special: checked('password-special'),
        excludeConfusing: checked('password-exclude-confusing'), requireEach: checked('password-require-each'),
        customOnly: checked('password-custom-only'), username: value('password-preset') === 'username',
        // Free-form options may contain secrets; prompt requests never read or send them.
        ...(prompt ? {} : {
          specialChars: value('password-special-chars'), extraChars: value('password-extra-chars'),
          excludeChars: value('password-exclude-chars'), customChars: value('password-custom-chars'),
          prefix: value('password-prefix'), suffix: value('password-suffix')
        })
      };
    }
    if (kind === 'key') {
      return { kind, count: number('key-count'), purpose: selectedOption('key-purpose', ['jwt', 'generic'], prompt), algorithm: selectedOption('key-algorithm', ['HS256', 'HS384', 'HS512'], prompt), bytes: number('key-bytes'), encoding: selectedOption('key-encoding', ['base64url', 'base64', 'hex'], prompt) };
    }
    if (kind === 'port') {
      return { kind, count: number('port-count'), min: number('port-min'), max: number('port-max'), excludeCommon: checked('port-exclude-common'), ...(prompt ? {} : { exclude: value('port-exclude') }) };
    }
    if (kind === 'uuid') return { kind, count: number('uuid-count'), format: selectedOption('uuid-format', ['standard', 'compact'], prompt), uppercase: checked('uuid-uppercase') };
    if (kind === 'hash') return { kind, input: prompt ? '' : value('hash-input'), algorithm: selectedOption('hash-algorithm', ['sha256', 'sha512', 'sha1', 'md5'], prompt), encoding: selectedOption('hash-encoding', ['hex', 'base64'], prompt) };
    if (kind === 'timestamp') return { kind, operation: selectedOption('timestamp-operation', ['toDate', 'toTimestamp'], prompt), input: prompt ? '' : value('timestamp-input'), unit: selectedOption('timestamp-unit', ['seconds', 'milliseconds'], prompt) };
    if (kind === 'base64') return { kind, input: prompt ? '' : value('base64-input'), variant: selectedOption('base64-variant', ['base64', 'base64url'], prompt), operation: selectedOption('base64-operation', ['encode', 'decode'], prompt), format: selectedOption('base64-format', ['utf8', 'hex'], prompt) };
    if (kind === 'url' || kind === 'jwt') return { kind, input: prompt ? '' : value(`${kind}-input`) };
    return null;
  }

  function generate(kind) {
    if (!host || accessDenied !== null || generationId !== null || kind !== activeTool) return;
    const form = forms[kind];
    if (!form.reportValidity()) return;
    copyId = null;
    const utility = utilityKinds.has(kind);
    const id = post(utility ? 'process' : 'generate', { request: buildRequest(kind) }, { stale: false });
    if (id !== null) {
      generationId = id;
      setStatus(utility ? 'processStatus' : 'generating');
    }
    updateButtons();
  }

  function copyPrompt() {
    if (!host || accessDenied !== null || promptId !== null) return;
    // The host supplies placeholders and validates numeric options; empty tool input is allowed.
    const id = post('copyPrompt', { request: buildRequest(activeTool, true) });
    if (id !== null) {
      promptId = id;
      setStatus('copyingPrompt');
    }
    updateButtons();
  }

  function copy(index) {
    if (!host || accessDenied !== null || copyId !== null || resultCount === 0) return;
    // The host owns the values. Only their position crosses back to the host.
    const id = post('copy', { index });
    if (id !== null) {
      copyId = id;
      setStatus('copying');
    }
    updateButtons();
  }

  function refreshResultLabels() {
    const rows = Array.from(byId('result-list').children);
    rows.forEach((row, index) => {
      const input = row.querySelector('textarea') || row.querySelector('input');
      input.setAttribute('aria-label', text('resultLabel', { index: index + 1 }));
      const mask = row.querySelector('[data-result-mask]');
      if (mask) {
        mask.setAttribute('aria-label', text('resultLabel', { index: index + 1 }));
        mask.setAttribute('placeholder', text('resultHidden'));
      }
      const copyButton = row.querySelector('[data-copy-index]');
      copyButton.textContent = text('copy');
      copyButton.setAttribute('aria-label', `${text('copy')} ${text('resultLabel', { index: index + 1 })}`);
      const reveal = row.querySelector('[data-reveal]');
      if (reveal) {
        reveal.textContent = text((input.tagName === 'TEXTAREA' ? input.hidden : input.type === 'password') ? 'show' : 'hide');
        reveal.setAttribute('aria-label', `${reveal.textContent} ${text('resultLabel', { index: index + 1 })}`);
      }
    });
  }

  function renderResults(values, sensitive, stale) {
    resultVersion += 1;
    resultCount = values.length;
    copyId = null;
    const fragment = document.createDocumentFragment();
    const utility = utilityKinds.has(activeTool);
    values.forEach((generatedValue, index) => {
      const row = document.createElement('div');
      row.className = utility ? 'result-row utility-result' : 'result-row';
      const input = document.createElement(utility ? 'textarea' : 'input');
      if (utility) {
        input.hidden = sensitive;
        input.rows = Math.min(12, Math.max(2, generatedValue.split('\n', 12).length));
      } else input.type = sensitive ? 'password' : 'text';
      input.value = generatedValue;
      input.id = `result-${resultVersion}-${index}`;
      input.readOnly = true;
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('autocapitalize', 'off');
      row.append(input);
      let mask;
      if (utility && sensitive) {
        // A textarea has no password type; keep its real value hidden behind an empty placeholder.
        mask = document.createElement('input');
        mask.type = 'password';
        mask.readOnly = true;
        mask.autocomplete = 'off';
        mask.dataset.resultMask = '';
        row.append(mask);
      }
      const actions = document.createElement('div');
      actions.className = 'row-actions';
      if (sensitive) {
        const reveal = document.createElement('button');
        reveal.type = 'button';
        reveal.className = 'secondary compact';
        reveal.dataset.reveal = '';
        reveal.setAttribute('aria-controls', input.id);
        reveal.setAttribute('aria-pressed', 'false');
        reveal.addEventListener('click', () => {
          if (utility) {
            input.hidden = !input.hidden;
            mask.hidden = !input.hidden;
          } else input.type = input.type === 'password' ? 'text' : 'password';
          const visible = utility ? !input.hidden : input.type === 'text';
          reveal.setAttribute('aria-pressed', String(visible));
          reveal.textContent = text(visible ? 'hide' : 'show');
          reveal.setAttribute('aria-label', `${reveal.textContent} ${text('resultLabel', { index: index + 1 })}`);
        });
        actions.append(reveal);
      }
      const copyButton = document.createElement('button');
      copyButton.type = 'button';
      copyButton.className = 'secondary compact';
      copyButton.dataset.copyIndex = String(index);
      copyButton.addEventListener('click', () => copy(index));
      actions.append(copyButton);
      row.append(actions);
      fragment.append(row);
    });
    byId('result-list').replaceChildren(fragment);
    byId('results').hidden = false;
    byId('stale').hidden = !stale;
    byId('stale-hint').hidden = !stale;
    refreshResultLabels();
    setStatus(stale ? 'staleStatus' : (utility ? 'processed' : 'generated'), { count: values.length });
    updateButtons();
  }

  function receive(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    if (message.type === 'init') {
      if (!host || !message.strings || typeof message.strings !== 'object' || Array.isArray(message.strings)) return;
      const catalog = {};
      for (const [key, entry] of Object.entries(message.strings)) if (typeof entry === 'string') catalog[key] = entry;
      strings = { ...fallback, ...catalog };
      document.documentElement.lang = message.language === 'zh-cn' ? 'zh-CN' : 'en';
      for (const [id, request] of requests) if (request.type === 'ready') requests.delete(id);
      accessDenied = null;
      setStatus('ready');
      applyStrings();
      updateButtons();
      return;
    }
    if (message.type === 'agentResult') {
      if (!host || accessDenied !== null || Object.prototype.hasOwnProperty.call(message, 'requestId') || !['password', 'key'].includes(message.kind)) return;
      if (!Array.isArray(message.values) || message.values.length === 0 || message.values.length > 100 || !message.values.every((entry) => typeof entry === 'string' && entry.length > 0)) {
        setStatus('unknownError');
        return;
      }
      if (message.values.reduce((total, entry) => total + entry.length, 0) > maximumOutputCharacters) {
        setStatus('outputTooLarge');
        return;
      }
      // Do not send clear back: the host has just installed this AI-owned result batch.
      requests.clear();
      inspectId = null;
      clearToolInputs();
      resetResults();
      byId('inspect-info').hidden = true;
      activateTool(message.kind, false);
      renderResults(message.values, true, false);
      byId('result-info').textContent = text('aiResultNotice');
      byId('result-info').hidden = false;
      setStatus('aiGenerated', { count: message.values.length });
      return;
    }
    if (!Number.isSafeInteger(message.requestId)) return;
    if (message.type === 'error' && (message.code === 'notSignedIn' || message.code === 'blocked')) {
      if (message.requestId !== -1 && !requests.has(message.requestId)) return;
      accessDenied = message.code;
      requests.clear();
      inspectId = null;
      clearToolInputs();
      resetResults();
      byId('inspect-info').hidden = true;
      setStatus(message.code);
      updateButtons();
      return;
    }
    const request = requests.get(message.requestId);
    if (!request) return;
    const responseTypes = { generate: 'result', process: 'result', copy: 'copied', copyPrompt: 'promptCopied', clear: 'cleared', inspectPort: 'portInfo' };
    if (message.type !== 'error' && message.type !== responseTypes[request.type]) return;
    requests.delete(message.requestId);
    if (message.type === 'error') {
      const processing = request.type === 'generate' || request.type === 'process';
      if (processing && generationId !== message.requestId) return;
      if (request.type === 'copy' && (copyId !== message.requestId || request.version !== resultVersion)) return;
      if (request.type === 'inspectPort' && inspectId !== message.requestId) return;
      if (request.type === 'copyPrompt' && (promptId !== message.requestId || request.tab !== activeTool)) return;
      if (processing) generationId = null;
      if (request.type === 'copy') copyId = null;
      if (request.type === 'inspectPort') inspectId = null;
      if (request.type === 'copyPrompt') promptId = null;
      setStatus(typeof message.code === 'string' && Object.prototype.hasOwnProperty.call(strings, message.code) ? message.code : 'unknownError');
      updateButtons();
      return;
    }
    if (message.type === 'result') {
      if (generationId !== message.requestId || request.tab !== activeTool) return;
      generationId = null;
      if (!Array.isArray(message.values) || message.values.length === 0 || message.values.length > 100 || !message.values.every((entry) => typeof entry === 'string') || typeof message.sensitive !== 'boolean') {
        setStatus('unknownError');
        updateButtons();
        return;
      }
      if (message.values.reduce((total, entry) => total + entry.length, 0) > maximumOutputCharacters) {
        setStatus('outputTooLarge');
        updateButtons();
        return;
      }
      renderResults(message.values, message.sensitive || sensitiveKinds.has(activeTool), request.stale);
      const info = byId('result-info');
      const meta = message.metadata;
      if (activeTool === 'key' && meta && Number.isInteger(meta.bytes) && ['base64url', 'base64', 'hex'].includes(meta.encoding)) {
        info.textContent = text('keyResultInfo', { bytes: meta.bytes, bits: meta.bytes * 8, encoding: meta.encoding, chars: message.values[0].length });
        info.hidden = false;
      } else if (utilityKinds.has(activeTool)) {
        info.textContent = text(utilityNotices[activeTool]);
        info.hidden = false;
      } else { info.textContent = ''; info.hidden = true; }
    } else if (message.type === 'copied') {
      if (copyId !== message.requestId || request.version !== resultVersion) return;
      copyId = null;
      setStatus('copied');
      updateButtons();
    } else if (message.type === 'promptCopied') {
      if (promptId !== message.requestId || request.tab !== activeTool) return;
      promptId = null;
      setStatus('promptCopied');
      updateButtons();
    } else if (message.type === 'cleared') {
      if (request.announce && request.version === resultVersion && generationId === null) setStatus('cleared');
    } else if (message.type === 'portInfo') {
      if (inspectId !== message.requestId || request.tab !== activeTool) return;
      inspectId = null;
      const categoryKeys = { system: 'categorySystem', registered: 'categoryRegistered', dynamic: 'categoryDynamic' };
      if (message.port !== request.port || !Object.prototype.hasOwnProperty.call(categoryKeys, message.category) || (message.service !== undefined && typeof message.service !== 'string')) {
        setStatus('unknownError');
        updateButtons();
        return;
      }
      const info = byId('inspect-info');
      info.textContent = text(message.service ? 'inspectMatch' : 'inspectNoMatch', { port: message.port, service: message.service || '', category: text(categoryKeys[message.category]) });
      info.hidden = false;
      setStatus('ready');
      updateButtons();
    }
  }

  byId('category-select').addEventListener('change', () => {
    const selected = value('category-select');
    if (Object.prototype.hasOwnProperty.call(categories, selected)) activateTool(categories[selected][0]);
    else populateToolOptions();
  });
  byId('tool-select').addEventListener('change', () => {
    const selected = value('tool-select');
    const category = value('category-select');
    if (Object.prototype.hasOwnProperty.call(categories, category) && categories[category].includes(selected)) activateTool(selected);
    else populateToolOptions();
  });
  for (const [kind, form] of Object.entries(forms)) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      generate(kind);
    });
    form.addEventListener('input', markStale);
    form.addEventListener('change', markStale);
  }
  byId('password-preset').addEventListener('change', () => {
    const username = value('password-preset') === 'username';
    byId('password-lowercase').checked = true;
    byId('password-uppercase').checked = !username;
    byId('password-digits').checked = true;
    byId('password-special').checked = !username;
    byId('password-custom-only').checked = false;
  });
  byId('password-range-length').addEventListener('change', () => {
    const range = checked('password-range-length');
    byId('password-range-fields').hidden = !range;
    byId('password-min-length').disabled = !range;
    byId('password-max-length').disabled = !range;
    byId('password-length').disabled = range;
  });
  function updateKeyPurpose() {
    const jwt = value('key-purpose') === 'jwt';
    const minimum = jwt ? algorithmBytes[value('key-algorithm')] : 16;
    byId('key-algorithm-field').hidden = !jwt;
    byId('key-algorithm').disabled = !jwt;
    byId('key-bytes').min = String(minimum);
    if (number('key-bytes') < minimum) byId('key-bytes').value = String(minimum);
  }
  byId('key-purpose').addEventListener('change', updateKeyPurpose);
  byId('key-algorithm').addEventListener('change', () => {
    byId('key-bytes').value = String(algorithmBytes[value('key-algorithm')]);
    updateKeyPurpose();
  });
  byId('port-preset').addEventListener('change', () => {
    const preset = portPresets[value('port-preset')];
    if (preset) {
      byId('port-min').value = String(preset[0]);
      byId('port-max').value = String(preset[1]);
    }
  });
  for (const id of ['port-min', 'port-max']) byId(id).addEventListener('input', () => { byId('port-preset').value = 'custom'; });
  byId('copy-prompt').addEventListener('click', copyPrompt);
  byId('copy-all').addEventListener('click', () => copy(-1));
  byId('clear').addEventListener('click', () => clearResults());
  for (const button of document.querySelectorAll('.clear-tool')) button.addEventListener('click', () => clearResults());
  byId('inspect-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!host || accessDenied !== null || inspectId !== null || !byId('inspect-form').reportValidity()) return;
    const port = number('inspect-port');
    byId('inspect-info').hidden = true;
    const id = post('inspectPort', { port }, { port });
    if (id !== null) {
      inspectId = id;
      setStatus('inspecting');
    }
    updateButtons();
  });
  byId('inspect-port').addEventListener('input', () => {
    if (inspectId !== null) requests.delete(inspectId);
    inspectId = null;
    byId('inspect-info').hidden = true;
    setStatus(host ? 'ready' : 'hostOnly');
    updateButtons();
  });
  activateTool(activeTool);
  window.addEventListener('message', (event) => receive(event.data));
  if (host && typeof host.postMessage === 'function') {
    post('ready');
    updateButtons();
  } else {
    setHostUnavailable();
  }
})();
