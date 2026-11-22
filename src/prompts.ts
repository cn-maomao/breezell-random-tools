import { types } from 'node:util';
import { GeneratorError } from './generator';

export type PromptLanguage = 'en' | 'zh-cn';
type PublicParameters = Record<string, string | number | boolean>;
type Request = Record<string, unknown>;

function invalid(): never {
  throw new GeneratorError('invalidRequest');
}

function requestRecord(value: unknown): Request {
  try {
    if (value === null || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) return invalid();
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalid();
    const request: Request = Object.create(null) as Request;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) return invalid();
      request[key] = descriptor.value;
    }
    return request;
  } catch {
    return invalid();
  }
}

function integer(request: Request, field: string, fallback: number, min: number, max: number): number {
  const value = request[field] === undefined ? fallback : request[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return invalid();
  return value;
}

function boolean(request: Request, field: string, fallback: boolean): boolean {
  const value = request[field] === undefined ? fallback : request[field];
  if (typeof value !== 'boolean') return invalid();
  return value;
}

function choice<T extends string>(request: Request, field: string, choices: readonly T[], fallback: T): T {
  const value = request[field] === undefined ? fallback : request[field];
  if (typeof value !== 'string' || !choices.includes(value as T)) return invalid();
  return value as T;
}

function publicParameters(request: Request, placeholder: string): PublicParameters {
  switch (request.kind) {
    case 'password': {
      const length = integer(request, 'length', 20, 1, 128);
      const rangeLength = boolean(request, 'rangeLength', false);
      const minLength = integer(request, 'minLength', length, 1, 128);
      const maxLength = integer(request, 'maxLength', length, 1, 128);
      if (rangeLength && minLength > maxLength) return invalid();
      // 自由字符集和前后缀永不复制；模板固定回内置字符组，避免空 customOnly 字符集。
      return {
        count: integer(request, 'count', 1, 1, 100), length, rangeLength, minLength, maxLength,
        username: boolean(request, 'username', false),
        lowercase: boolean(request, 'lowercase', true), uppercase: boolean(request, 'uppercase', true),
        digits: boolean(request, 'digits', true), special: boolean(request, 'special', true),
        excludeConfusing: boolean(request, 'excludeConfusing', false),
        requireEach: boolean(request, 'requireEach', true), customOnly: false,
      };
    }
    case 'key': {
      const purpose = choice(request, 'purpose', ['jwt', 'generic'], 'jwt');
      const algorithm = choice(request, 'algorithm', ['HS256', 'HS384', 'HS512'], 'HS256');
      const minimum = purpose === 'generic' ? 16 : algorithm === 'HS512' ? 64 : algorithm === 'HS384' ? 48 : 32;
      return {
        count: integer(request, 'count', 1, 1, 100), purpose, algorithm,
        bytes: integer(request, 'bytes', purpose === 'generic' ? 32 : minimum, minimum, 128),
        encoding: choice(request, 'encoding', ['base64url', 'base64', 'hex'], 'base64url'),
      };
    }
    case 'port': {
      const min = integer(request, 'min', 1024, 1, 65535);
      const max = integer(request, 'max', 49151, 1, 65535);
      if (min > max) return invalid();
      return { count: integer(request, 'count', 1, 1, 100), min, max, excludeCommon: boolean(request, 'excludeCommon', true) };
    }
    case 'uuid': return {
      count: integer(request, 'count', 1, 1, 100),
      format: choice(request, 'format', ['standard', 'compact'], 'standard'),
      uppercase: boolean(request, 'uppercase', false),
    };
    case 'hash': return {
      input: placeholder, algorithm: choice(request, 'algorithm', ['sha256', 'sha512', 'sha1', 'md5'], 'sha256'),
      encoding: choice(request, 'encoding', ['hex', 'base64'], 'hex'),
    };
    case 'timestamp': return {
      input: placeholder, operation: choice(request, 'operation', ['toDate', 'toTimestamp'], 'toDate'),
      unit: choice(request, 'unit', ['seconds', 'milliseconds'], 'seconds'),
    };
    case 'base64': return {
      input: placeholder, operation: choice(request, 'operation', ['encode', 'decode'], 'encode'),
      variant: choice(request, 'variant', ['base64', 'base64url'], 'base64'),
      format: choice(request, 'format', ['utf8', 'hex'], 'utf8'),
    };
    case 'url':
    case 'jwt': return { input: placeholder };
    default: return invalid();
  }
}

/**
 * 生成用户主动复制/粘贴的工具调用模板，不读取环境内容，不执行随机生成。
 * 只保留经过类型和范围校验的公开数值、布尔值和枚举；文本与结果永不复制。
 */
export function buildToolPrompt(request: unknown, publisherId: string, language: PromptLanguage): string {
  if (typeof publisherId !== 'string' || publisherId.length > 100
    || !/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/.test(publisherId)
    || (language !== 'en' && language !== 'zh-cn')) return invalid();
  const record = requestRecord(request);
  const chinese = language === 'zh-cn';
  const parameters = publicParameters(record, chinese ? '<在此填写非敏感文本>' : '<Enter non-sensitive text here>');
  const tool = `rt_${record.kind as string}`;
  const server = `plugin:${publisherId}`;
  const secret = record.kind === 'password' || record.kind === 'key';
  const opening = chinese
    ? `请调用 MCP 服务器 ${server} 的工具 ${tool}，参数如下；如有占位文本，请先按所选操作填写非敏感示例：`
    : `Call tool ${tool} from MCP server ${server} with the following parameters; replace any placeholder with a non-sensitive example valid for the selected operation:`;
  const safety = chinese
    ? secret
      ? '生成的密码或密钥仅显示在插件面板，不返回模型；自由字符集、前后缀和输入文本不会复制到此模板，字符集使用内置默认值。'
      : '工具的输入和输出会进入模型会话。不要发送真实令牌、密码或其他敏感数据；文本已替换为占位符，端口自由排除文本不会复制。'
    : secret
      ? 'Generated passwords or keys appear only in the plugin panel, not in the model result. Free-form character rules, affixes, and input text are omitted; character sets use built-in defaults.'
      : 'Tool input and output enter the model conversation. Do not send real tokens, passwords, or other sensitive data. Text is replaced by a placeholder; free-form port exclusions are omitted.';
  const manual = chinese
    ? '此提示词须由用户主动粘贴到会话；插件不会自动发送，也不会自动读取编辑器、聊天或剪贴板。'
    : 'The user must paste this prompt into a conversation manually. The plugin does not send it automatically or read the editor, chat, or clipboard automatically.';
  return `${opening}\n${JSON.stringify(parameters, null, 2)}\n\n${safety}\n\n${manual}`;
}
