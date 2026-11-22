import type * as vscode from 'vscode';
import { types } from 'node:util';
import { generate, GeneratorError, type GenerationResult } from './generator';
import { runUtility } from './utilities';

export const AGENT_TOOL_NAMES = [
  'rt_password', 'rt_key', 'rt_port', 'rt_uuid', 'rt_hash',
  'rt_timestamp', 'rt_base64', 'rt_url', 'rt_jwt',
] as const;

export type AgentToolName = typeof AGENT_TOOL_NAMES[number];
export type SecretKind = 'password' | 'key';

/** 只使用宿主的工具注册和登录状态，不读取会话、编辑器或剪贴板。 */
export interface AgentToolsApi {
  readonly tools: Pick<typeof vscode.breezell.tools, 'register'>;
  readonly account?: Pick<typeof vscode.breezell.account, 'isSignedIn'>;
}

export interface ToolUnavailable {
  readonly name: AgentToolName;
  readonly code: string;
}

export interface AgentToolRegistration {
  readonly registered: readonly AgentToolName[];
  readonly unavailable: readonly ToolUnavailable[];
}

const FIELDS: Readonly<Record<AgentToolName, readonly string[]>> = {
  rt_password: [
    'count', 'length', 'rangeLength', 'minLength', 'maxLength', 'username',
    'prefix', 'suffix', 'specialChars', 'customChars', 'extraChars', 'excludeChars',
    'customOnly', 'requireEach', 'excludeConfusing', 'lowercase', 'uppercase', 'digits', 'special',
  ],
  rt_key: ['count', 'purpose', 'algorithm', 'bytes', 'encoding'],
  rt_port: ['count', 'min', 'max', 'excludeCommon', 'exclude'],
  rt_uuid: ['count', 'format', 'uppercase'],
  rt_hash: ['input', 'algorithm', 'encoding'],
  rt_timestamp: ['input', 'operation', 'unit'],
  rt_base64: ['input', 'operation', 'variant', 'format'],
  rt_url: ['input'],
  rt_jwt: ['input'],
};

const ERROR_CODES = new Set([
  'invalidRequest', 'invalidLength', 'invalidCount', 'invalidCharacters',
  'requiredGroupEmpty', 'emptyCharset', 'impossibleRules', 'insufficientSpace',
  'attemptsExceeded', 'invalidAlgorithm', 'invalidKeySize', 'invalidEncoding',
  'invalidPortExclusions', 'invalidPortRange', 'invalidText', 'inputTooLarge',
  'outputTooLarge', 'invalidUuidFormat', 'invalidHash', 'invalidDate',
  'invalidTimestamp', 'invalidBase64', 'invalidUtf8', 'invalidUrl', 'invalidJwt',
  'BreezellNotSignedIn', 'BreezellPermissionDenied', 'BreezellNotSupported',
  'BreezellInvalidRequest', 'BreezellCancelled', 'BreezellBlocked',
]);

function safeErrorCode(error: unknown, fallback: string): string {
  // 任意宿主/面板异常可能含输入或密钥；只接受已知错误码，不序列化异常。
  try {
    if (error === null || typeof error !== 'object' || types.isProxy(error)) return fallback;
    for (const key of ['code', 'name']) {
      const descriptor = Object.getOwnPropertyDescriptor(error, key);
      if (descriptor !== undefined && 'value' in descriptor
        && typeof descriptor.value === 'string' && ERROR_CODES.has(descriptor.value)) {
        return descriptor.value;
      }
    }
  } catch {
    // 反射失败也不能把异常内容发送给模型。
  }
  return fallback;
}

function failure(code: string): vscode.breezell.ToolResult {
  return { text: code, isError: true };
}

function toolRequest(name: AgentToolName, input: unknown): Record<string, unknown> {
  try {
    if (input === null || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input)) {
      throw new GeneratorError('invalidRequest');
    }
    const prototype: unknown = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) throw new GeneratorError('invalidRequest');
    const request: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== 'string' || !FIELDS[name].includes(key)) throw new GeneratorError('invalidRequest');
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !('value' in descriptor)) throw new GeneratorError('invalidRequest');
      request[key] = descriptor.value;
    }
    // kind 由注册的工具决定，不能被模型参数改成另一个操作。
    request.kind = name.slice(3);
    return request;
  } catch {
    throw new GeneratorError('invalidRequest');
  }
}

/**
 * 为 context 注册已在清单声明的工具。注册不可用只报告稳定错误码，不中断普通面板。
 * showSecret 必须把结果交给插件面板；密码和密钥的 values 永远不进入模型工具结果。
 */
export function registerAgentTools(
  context: Pick<vscode.ExtensionContext, 'subscriptions'>,
  breezell: AgentToolsApi | undefined,
  showSecret: (result: GenerationResult, kind: SecretKind) => void | PromiseLike<void>,
  onUnavailable?: (status: ToolUnavailable) => void,
): AgentToolRegistration {
  const registered: AgentToolName[] = [];
  const unavailable: ToolUnavailable[] = [];
  for (const name of AGENT_TOOL_NAMES) {
    try {
      if (breezell === undefined || typeof breezell.tools?.register !== 'function') {
        throw Object.assign(new Error(), { name: 'BreezellNotSupported' });
      }
      const api = breezell;
      const registration = api.tools.register(name, {
        async invoke(input, token) {
          if (token.isCancellationRequested) return failure('BreezellCancelled');
          let displayingSecret = false;
          try {
            if (api.account?.isSignedIn === false) return failure('BreezellNotSignedIn');
            const request = toolRequest(name, input);
            const kind = request.kind;
            const result = kind === 'password' || kind === 'key' || kind === 'port'
              ? generate(request)
              : runUtility(request);
            if (token.isCancellationRequested) return failure('BreezellCancelled');
            if (kind === 'password' || kind === 'key') {
              displayingSecret = true;
              await showSecret(result as GenerationResult, kind);
              if (token.isCancellationRequested) return failure('BreezellCancelled');
              // 不把 result 整体 stringify，即便用户名模式标记为非敏感也只留在面板。
              return JSON.stringify({
                metadata: result.metadata,
                message: 'Generated locally; secret is shown in the plugin panel and is not returned to the model.',
              });
            }
            return JSON.stringify(result);
          } catch (error: unknown) {
            if (token.isCancellationRequested) return failure('BreezellCancelled');
            return failure(safeErrorCode(error, displayingSecret ? 'secretDisplayFailed' : 'generationFailed'));
          }
        },
      });
      context.subscriptions.push(registration);
      registered.push(name);
    } catch (error: unknown) {
      const status = { name, code: safeErrorCode(error, 'toolRegistrationFailed') };
      unavailable.push(status);
      // 状态提示失败也不能影响插件的普通 UI 或其余工具注册。
      try { onUnavailable?.(status); } catch { /* 状态回调不属于工具执行。 */ }
    }
  }
  return { registered, unavailable };
}
