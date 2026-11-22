import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder, types } from 'node:util';
import { GeneratorError } from './generator';

export interface UtilityResult {
  values: string[];
  sensitive: boolean;
  metadata: {
    kind: 'uuid' | 'hash' | 'timestamp' | 'base64' | 'url' | 'jwt';
    version?: 4;
    algorithm?: 'sha256' | 'sha512' | 'sha1' | 'md5';
    encoding?: 'hex' | 'base64';
    variant?: 'base64' | 'base64url';
    format?: 'standard' | 'compact' | 'utf8' | 'hex';
    operation?: 'toDate' | 'toTimestamp' | 'encode' | 'decode';
    unit?: 'seconds' | 'milliseconds';
    verified?: false;
  };
}

type Request = Record<string, unknown>;
const MAX_INPUT_BYTES = 65_536;
const MAX_OUTPUT_BYTES = 131_072;
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;

function fail(code: string): never {
  throw new GeneratorError(code);
}

function requestRecord(value: unknown): Request {
  // 消息只能包含普通数据；先拒绝 Proxy，避免反射操作触发其陷阱。
  try {
    if (value === null || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) {
      return fail('invalidRequest');
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return fail('invalidRequest');
    const request: Request = Object.create(null) as Request;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return fail('invalidRequest');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) return fail('invalidRequest');
      request[key] = descriptor.value;
    }
    return request;
  } catch (error: unknown) {
    if (error instanceof GeneratorError) throw error;
    return fail('invalidRequest');
  }
}

function choice<T extends string>(
  request: Request,
  name: string,
  choices: readonly T[],
  code: string,
  fallback?: T,
): T {
  const value = request[name] === undefined ? fallback : request[name];
  if (typeof value !== 'string' || !choices.includes(value as T)) return fail(code);
  return value as T;
}

function inputText(request: Request): string {
  const input = request.input;
  if (typeof input !== 'string') return fail('invalidText');
  if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) return fail('inputTooLarge');
  // 孤立代理项会被 UTF-8 编码静默替换；文本工具必须拒绝这种有损转换。
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return fail('invalidText');
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return fail('invalidText');
    }
  }
  return input;
}

function result(
  values: string[],
  sensitive: boolean,
  metadata: UtilityResult['metadata'],
): UtilityResult {
  let bytes = 0;
  for (const value of values) {
    bytes += Buffer.byteLength(value, 'utf8');
    if (bytes > MAX_OUTPUT_BYTES) return fail('outputTooLarge');
  }
  return { values, sensitive, metadata };
}

function uuid(request: Request): UtilityResult {
  const count = request.count === undefined ? 1 : request.count;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > 100) {
    return fail('invalidCount');
  }
  const format = choice(request, 'format', ['standard', 'compact'], 'invalidUuidFormat', 'standard');
  const uppercase = request.uppercase === undefined ? false : request.uppercase;
  if (typeof uppercase !== 'boolean') return fail('invalidRequest');
  const values = new Set<string>();
  // 同批必须唯一，但随机源故障或碰撞不能让宿主无限循环。
  const budget = count * 16;
  for (let attempt = 0; attempt < budget && values.size < count; attempt += 1) {
    let value: string = randomUUID();
    if (format === 'compact') value = value.replace(/-/g, '');
    if (uppercase) value = value.toUpperCase();
    values.add(value);
  }
  if (values.size !== count) return fail('attemptsExceeded');
  return result([...values], false, { kind: 'uuid', version: 4, format });
}

function hash(request: Request): UtilityResult {
  const input = inputText(request);
  const algorithm = choice(request, 'algorithm', ['sha256', 'sha512', 'sha1', 'md5'], 'invalidHash', 'sha256');
  const encoding = choice(request, 'encoding', ['hex', 'base64'], 'invalidHash', 'hex');
  const value = createHash(algorithm).update(input, 'utf8').digest(encoding);
  return result([value], true, { kind: 'hash', algorithm, encoding });
}

function validMilliseconds(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_DATE_MILLISECONDS) return fail(code);
  return value;
}

function isoMilliseconds(input: string): number {
  // 固定到毫秒精度并要求显式时区，不依赖 Date.parse 的宽松日期归一化。
  const match = /^(\d{4}|[+-]\d{6})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(input);
  if (match === null || match[1] === '-000000') return fail('invalidDate');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? '').padEnd(3, '0'));
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    return fail('invalidDate');
  }
  // 将公历按三月起始的 400 年周期换算为纪元日，避开 Date 的年份偏移和提前截断。
  const calendarYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(calendarYear / 400);
  const yearOfEra = calendarYear - era * 400;
  const monthOfYear = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * monthOfYear + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  const epochDays = era * 146_097 + dayOfEra - 719_468;
  const time = ((hour * 60 + minute) * 60 + second) * 1_000 + millisecond;
  const offset = (offsetHour * 60 + offsetMinute) * 60_000 * (match[9] === '-' ? -1 : 1);
  return validMilliseconds(epochDays * 86_400_000 + time - offset, 'invalidDate');
}

function timestamp(request: Request): UtilityResult {
  const input = inputText(request);
  const operation = choice(request, 'operation', ['toDate', 'toTimestamp'], 'invalidTimestamp');
  const unit = choice(request, 'unit', ['seconds', 'milliseconds'], 'invalidTimestamp');
  let milliseconds: number;
  if (operation === 'toDate') {
    if (!/^[+-]?\d+$/.test(input)) return fail('invalidTimestamp');
    const value = Number(input);
    if (!Number.isSafeInteger(value)) return fail('invalidTimestamp');
    milliseconds = validMilliseconds(unit === 'seconds' ? value * 1_000 : value, 'invalidTimestamp');
  } else {
    milliseconds = isoMilliseconds(input);
  }
  const date = new Date(milliseconds);
  const value = JSON.stringify({
    iso: date.toISOString(),
    utc: date.toUTCString(),
    seconds: Math.floor(milliseconds / 1_000),
    milliseconds,
  });
  return result([value], false, { kind: 'timestamp', operation, unit });
}

function decodeBase64(
  input: string,
  variant: 'base64' | 'base64url',
  code: string,
  allowPadding = true,
): Buffer {
  const pattern = variant === 'base64' ? /^[A-Za-z0-9+/]*={0,2}$/ : /^[A-Za-z0-9_-]*={0,2}$/;
  if (!pattern.test(input) || (!allowPadding && input.includes('='))) return fail(code);
  const unpadded = input.replace(/=+$/, '');
  const padding = input.length - unpadded.length;
  const remainder = unpadded.length % 4;
  if (remainder === 1 || (padding !== 0 && (input.length % 4 !== 0 || padding !== (4 - remainder) % 4))) {
    return fail(code);
  }
  const standard = unpadded.replace(/-/g, '+').replace(/_/g, '/');
  const buffer = Buffer.from(standard, 'base64');
  // Node 的解码器忽略非法字符和非零尾位；回编码核对才能保证唯一规范表示。
  if (buffer.toString('base64').replace(/=+$/, '') !== standard) {
    buffer.fill(0);
    return fail(code);
  }
  return buffer;
}

function decodeUtf8(buffer: Buffer, code: string): string {
  try {
    // ignoreBOM 保留文本中的 U+FEFF，避免编码/解码丢失用户字符。
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    return fail(code);
  }
}

function base64(request: Request): UtilityResult {
  const input = inputText(request);
  const operation = choice(request, 'operation', ['encode', 'decode'], 'invalidBase64');
  const variant = choice(request, 'variant', ['base64', 'base64url'], 'invalidBase64');
  const format = choice(request, 'format', ['utf8', 'hex'], 'invalidBase64');
  let buffer: Buffer;
  if (operation === 'encode') {
    if (format === 'hex' && !/^(?:[0-9A-Fa-f]{2})*$/.test(input)) return fail('invalidBase64');
    buffer = Buffer.from(input, format === 'hex' ? 'hex' : 'utf8');
  } else {
    buffer = decodeBase64(input, variant, 'invalidBase64');
  }
  try {
    const value = operation === 'encode'
      ? buffer.toString(variant)
      : format === 'hex' ? buffer.toString('hex') : decodeUtf8(buffer, 'invalidUtf8');
    return result([value], true, { kind: 'base64', operation, variant, format });
  } finally {
    buffer.fill(0);
  }
}

function url(request: Request): UtilityResult {
  const input = inputText(request);
  // 仅解析明确的 HTTP(S) 绝对地址，不接受 URL 构造器的空白/反斜杠修复。
  if (!/^https?:\/\/[^/?#\\]+(?:[/?#]|$)/i.test(input) || /[\x00-\x20\x7f\\]/.test(input)) {
    return fail('invalidUrl');
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return fail('invalidUrl');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fail('invalidUrl');
  const value = JSON.stringify({
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port,
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
    origin: parsed.origin,
    username: parsed.username,
    password: parsed.password,
    query: [...parsed.searchParams].map(([key, value]) => ({ key, value })),
  });
  return result([value], true, { kind: 'url' });
}

function jwtObject(segment: string): string {
  if (segment.length === 0) return fail('invalidJwt');
  const buffer = decodeBase64(segment, 'base64url', 'invalidJwt', false);
  try {
    const json = decodeUtf8(buffer, 'invalidJwt');
    const value: unknown = JSON.parse(json);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('invalidJwt');
    return json;
  } catch (error: unknown) {
    if (error instanceof GeneratorError) throw error;
    return fail('invalidJwt');
  } finally {
    buffer.fill(0);
  }
}

function jwt(request: Request): UtilityResult {
  const input = inputText(request);
  const segments = input.split('.');
  if (segments.length !== 3) return fail('invalidJwt');
  const header = jwtObject(segments[0]);
  const payload = jwtObject(segments[1]);
  // 签名只检查编码，不依据不可信 alg 执行验证、授权或过期判断。
  const signature = decodeBase64(segments[2], 'base64url', 'invalidJwt', false);
  signature.fill(0);
  // 两段已验证为 JSON 对象；直接嵌入可保留声明并避开深层对象的递归序列化。
  const value = `{"header":${header},"payload":${payload},"signatureVerified":false}`;
  return result([value], true, { kind: 'jwt', verified: false });
}

/** 仅在内存中处理普通 JSON 消息；所有输入相关错误只包含稳定的英文错误码。 */
export function runUtility(value: unknown): UtilityResult {
  const request = requestRecord(value);
  switch (request.kind) {
    case 'uuid': return uuid(request);
    case 'hash': return hash(request);
    case 'timestamp': return timestamp(request);
    case 'base64': return base64(request);
    case 'url': return url(request);
    case 'jwt': return jwt(request);
    default: return fail('invalidRequest');
  }
}
