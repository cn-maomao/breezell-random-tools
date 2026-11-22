import * as vscode from 'vscode';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { generate, GeneratorError, COMMON_PORTS } from './generator.ts';
import { runUtility } from './utilities.ts';
import { registerAgentTools } from './agent-tools.ts';
import { buildToolPrompt } from './prompts.ts';
import type { GenerationResult } from './generator.ts';

type Message = { type: string; requestId: number; request?: unknown; index?: unknown; port?: unknown };

export function activate(context: vscode.ExtensionContext): void {
  let panel: vscode.WebviewPanel | undefined;
  let panelReady = false;
  let showAgentResult: ((result: GenerationResult, kind: 'password' | 'key') => void) | undefined;
  let pendingAgentResult: { result: GenerationResult; kind: 'password' | 'key' } | undefined;
  const language = vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en';
  const english = JSON.parse(readFileSync(vscode.Uri.joinPath(context.extensionUri, 'package.nls.json').fsPath, 'utf8')) as Record<string, string>;
  const translated = vscode.Uri.joinPath(context.extensionUri, 'package.nls.zh-cn.json');
  const translatedPath = existsSync(translated.fsPath) ? translated.fsPath : vscode.Uri.joinPath(context.extensionUri, 'i18n/package.nls.zh-cn.json').fsPath;
  const labels = language === 'en' ? english : { ...english, ...JSON.parse(readFileSync(translatedPath, 'utf8')) };
  const title = labels.displayName;
  const shortcut = vscode.window.createStatusBarItem('randomTools.open', vscode.StatusBarAlignment.Right, 100);
  shortcut.name = labels['statusBar.name'];
  shortcut.text = `$(key) ${title}`;
  shortcut.tooltip = labels['statusBar.tooltip'];
  shortcut.command = 'randomTools.open';
  context.subscriptions.push(shortcut);
  shortcut.show();
  const open = () => {
    if (panel) { panel.reveal(); return; }
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    const readResource = (name: string) => readFileSync(vscode.Uri.joinPath(media, name).fsPath, 'utf8');
    let strings: Record<string, string>;
    let template: string;
    try {
      const english = JSON.parse(readResource('i18n/en.json')) as Record<string, string>;
      strings = language === 'en' ? english : { ...english, ...JSON.parse(readResource(`i18n/${language}.json`)) };
      template = readResource('index.html');
    } catch {
      void vscode.window.showErrorMessage(language === 'en' ? 'Random Tools: packaged interface resources are missing or invalid.' : '随机工具：界面资源缺失或无效，请重新安装插件。');
      return;
    }
    const current = vscode.window.createWebviewPanel('randomTools', title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [media]
    });
    panel = current;
    let values: string[] = [];
    let disposed = false;
    const post = (data: unknown) => { if (!disposed) void current.webview.postMessage(data); };
    const signedIn = () => vscode.breezell?.account.isSignedIn ?? false;
    const error = (requestId: number, code: string) => post({ type: 'error', requestId, code });
    const clear = () => { values = []; pendingAgentResult = undefined; };
    showAgentResult = (result, kind) => {
      values = result.values;
      post({ type: 'agentResult', kind, ...result, sensitive: true });
    };
    const signInSubscription = vscode.breezell?.account.onDidChangeSignIn(signed => {
      clear();
      if (!signed) post({ type: 'error', requestId: -1, code: 'notSignedIn' });
      else post({ type: 'init', language, strings });
    });
    const visibilitySubscription = current.onDidChangeViewState(() => {
      // The renderer is released when hidden; its host must drop secret references too.
      if (!current.visible) clear();
    });
    current.onDidDispose(() => {
      disposed = true;
      panelReady = false;
      showAgentResult = undefined;
      clear();
      signInSubscription?.dispose();
      visibilitySubscription.dispose();
      messageSubscription.dispose();
      if (panel === current) panel = undefined;
    });
    const messageSubscription = current.webview.onDidReceiveMessage(async (raw: unknown) => {
      if (disposed || !raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      const message = raw as Message;
      if (!Number.isSafeInteger(message.requestId) || typeof message.type !== 'string') return;
      const { requestId } = message;
      if (message.type === 'clear') { clear(); post({ type: 'cleared', requestId }); return; }
      if (message.type === 'ready') {
        // A reloaded webview must never recover the previous secret values.
        const pending = pendingAgentResult;
        clear();
        panelReady = true;
        post({ type: 'init', language, strings });
        if (!signedIn()) error(-1, 'notSignedIn');
        else if (pending) showAgentResult?.(pending.result, pending.kind);
        return;
      }
      if (!signedIn()) { clear(); error(requestId, 'notSignedIn'); return; }
      if (message.type === 'generate' || message.type === 'process') {
        try {
          const result = message.type === 'generate' ? generate(message.request) : runUtility(message.request);
          values = result.values;
          post({ type: 'result', requestId, ...result });
        } catch (cause) {
          // Do not serialize exception messages: input and generated secrets must not enter logs.
          error(requestId, cause instanceof GeneratorError ? cause.code : 'unknownError');
        }
      } else if (message.type === 'copyPrompt') {
        try {
          const prompt = buildToolPrompt(message.request, context.extension.id, language);
          await vscode.env.clipboard.writeText(prompt);
          post({ type: 'promptCopied', requestId });
        } catch (cause) {
          error(requestId, cause instanceof GeneratorError ? cause.code : 'clipboardFailed');
        }
      } else if (message.type === 'copy') {
        const index = message.index;
        if (!Number.isInteger(index) || typeof index !== 'number' || index < -1 || index >= values.length || !values.length) {
          error(requestId, 'invalidRequest'); return;
        }
        const text = index === -1 ? values.join('\n') : values[index];
        try {
          await vscode.env.clipboard.writeText(text);
          post({ type: 'copied', requestId });
        } catch { error(requestId, 'clipboardFailed'); }
      } else if (message.type === 'inspectPort') {
        const port = message.port;
        if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) { error(requestId, 'invalidPortRange'); return; }
        post({ type: 'portInfo', requestId, port, service: COMMON_PORTS[port], category: port <= 1023 ? 'system' : port <= 49151 ? 'registered' : 'dynamic' });
      } else error(requestId, 'invalidRequest');
    });
    const replacements: Record<string, string> = {
      cspSource: current.webview.cspSource,
      nonce: randomBytes(24).toString('hex'),
      styleUri: current.webview.asWebviewUri(vscode.Uri.joinPath(media, 'style.css')).toString(),
      scriptUri: current.webview.asWebviewUri(vscode.Uri.joinPath(media, 'app.js')).toString(),
      lang: language
    };
    const escapeAttribute = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
    current.webview.html = template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => name in replacements ? escapeAttribute(replacements[name]) : match);
  };
  registerAgentTools(context, vscode.breezell, (result, kind) => {
    if (!(vscode.breezell?.account.isSignedIn ?? false)) throw new GeneratorError('BreezellNotSignedIn');
    if (!panel || !panel.visible) panelReady = false;
    open();
    if (!panel || !showAgentResult) throw new GeneratorError('secretDisplayFailed');
    if (panelReady) showAgentResult(result, kind);
    else pendingAgentResult = { result, kind };
  });
  context.subscriptions.push(vscode.commands.registerCommand('randomTools.open', open));
  context.subscriptions.push({ dispose: () => panel?.dispose() });
}

export function deactivate(): void { }
