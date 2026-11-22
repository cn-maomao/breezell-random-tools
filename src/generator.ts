import { randomBytes, randomInt } from 'node:crypto';

export class GeneratorError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'GeneratorError';
    this.code = code;
  }
}

export type KeyEncoding = 'base64url' | 'base64' | 'hex';
export type HmacAlgorithm = 'HS256' | 'HS384' | 'HS512';

export interface GenerationResult {
  values: string[];
  sensitive: boolean;
  metadata: {
    kind: 'password' | 'key' | 'port';
    username?: boolean;
    length?: number;
    minLength?: number;
    maxLength?: number;
    charsetSize?: number;
    purpose?: 'jwt' | 'generic';
    algorithm?: HmacAlgorithm;
    bytes?: number;
    encoding?: KeyEncoding;
    min?: number;
    max?: number;
    excludedCount?: number;
    candidateCount?: number;
  };
}

// 仅提供常见服务的有限参考清单，不代表完整的 IANA 注册表。
export const COMMON_PORTS: Readonly<Record<number, string>> = Object.freeze({
  20: 'FTP data',
  21: 'FTP control',
  22: 'SSH',
  23: 'Telnet',
  25: 'SMTP',
  53: 'DNS',
  67: 'DHCP server',
  68: 'DHCP client',
  69: 'TFTP',
  80: 'HTTP',
  110: 'POP3',
  123: 'NTP',
  143: 'IMAP',
  161: 'SNMP',
  162: 'SNMP trap',
  389: 'LDAP',
  443: 'HTTPS',
  465: 'SMTP over TLS',
  514: 'Syslog',
  587: 'SMTP submission',
  636: 'LDAP over TLS',
  993: 'IMAP over TLS',
  995: 'POP3 over TLS',
  1433: 'Microsoft SQL Server',
  1521: 'Oracle listener',
  2049: 'NFS',
  2375: 'Docker API',
  2376: 'Docker API over TLS',
  3000: 'Common development server',
  3306: 'MySQL',
  3389: 'Remote Desktop',
  5432: 'PostgreSQL',
  5900: 'VNC',
  6379: 'Redis',
  6443: 'Kubernetes API',
  8080: 'Alternative HTTP / development server',
  8443: 'Alternative HTTPS',
  9000: 'Common development / application server',
  9090: 'Common metrics / application server',
  9200: 'Elasticsearch HTTP',
  11211: 'Memcached',
  27017: 'MongoDB',
});

const LOWERCASE = 'abcdefghijklmnopqrstuvwxyz';
const UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const DEFAULT_SPECIAL = '!@#$%^&*()-_=+';
const CONFUSING = '0O1lI';
const MAX_ATTEMPTS = 10_000;
const RANDOM_BUFFER_BYTES = 4_096;
const MAX_RANDOM_BYTES = 262_144;
const HMAC_MIN_BYTES: Readonly<Record<HmacAlgorithm, number>> = {
  HS256: 32,
  HS384: 48,
  HS512: 64,
};

type Request = Record<string, unknown>;

function fail(code: string): never {
  throw new GeneratorError(code);
}

class RequestRandom {
  private buffer = Buffer.alloc(0);
  private offset = 0;
  private consumed = 0;

  integer(max: number): number {
    if (max === 1) return 0;
    // 只接受最大整倍数区间，各余数出现次数一致；范围至多为 128。
    const limit = 256 - (256 % max);
    for (;;) {
      // 连同被拒绝的字节一起计费，避免极端规则或随机源耗尽时阻塞宿主。
      if (this.consumed >= MAX_RANDOM_BYTES) return fail('attemptsExceeded');
      if (this.offset === this.buffer.length) {
        this.buffer.fill(0);
        this.buffer = randomBytes(Math.min(RANDOM_BUFFER_BYTES, MAX_RANDOM_BYTES - this.consumed));
        this.offset = 0;
      }
      const value = this.buffer[this.offset] as number;
      this.offset += 1;
      this.consumed += 1;
      if (value < limit) return value % max;
    }
  }

  dispose(): void {
    this.buffer.fill(0);
  }
}

function requestRecord(value: unknown): Request {
  // Webview 消息必须是普通数据，不能执行不可信输入中的访问器。
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return fail('invalidRequest');
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return fail('invalidRequest');
    }
    const result: Request = Object.create(null) as Request;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return fail('invalidRequest');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) {
        return fail('invalidRequest');
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch (error: unknown) {
    if (error instanceof GeneratorError) throw error;
    return fail('invalidRequest');
  }
}

function integer(
  request: Request,
  name: string,
  fallback: number,
  min: number,
  max: number,
  code: string,
): number {
  const value = request[name] === undefined ? fallback : request[name];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    return fail(code);
  }
  return value;
}

function boolean(request: Request, name: string, fallback: boolean): boolean {
  const value = request[name] === undefined ? fallback : request[name];
  if (typeof value !== 'boolean') return fail('invalidRequest');
  return value;
}

function text(request: Request, name: string, fallback: string, code = 'invalidCharacters'): string {
  const value = request[name] === undefined ? fallback : request[name];
  if (typeof value !== 'string') return fail(code);
  return value;
}

function printable(request: Request, name: string, fallback: string): string {
  const value = text(request, name, fallback);
  if (!/^[\x21-\x7e]*$/.test(value)) return fail('invalidCharacters');
  return value;
}

function unique(textValue: string): string {
  return [...new Set(textValue)].join('');
}

function containsAny(value: string, group: string): boolean {
  for (const character of group) {
    if (value.includes(character)) return true;
  }
  return false;
}

function isLetter(character: string): boolean {
  return /^[A-Za-z]$/.test(character);
}

interface PasswordRules {
  minLength: number;
  maxLength: number;
  username: boolean;
  prefix: string;
  suffix: string;
  alphabet: string;
  firstAlphabet: string;
  missingGroups: string[];
}

function passwordRules(request: Request): PasswordRules {
  const length = integer(request, 'length', 20, 1, 128, 'invalidLength');
  const rangeLength = boolean(request, 'rangeLength', false);
  const requestedMin = integer(request, 'minLength', length, 1, 128, 'invalidLength');
  const requestedMax = integer(request, 'maxLength', length, 1, 128, 'invalidLength');
  const minLength = rangeLength ? requestedMin : length;
  const maxLength = rangeLength ? requestedMax : length;
  if (minLength > maxLength) return fail('invalidLength');
  const username = boolean(request, 'username', false);
  const prefix = printable(request, 'prefix', '');
  const suffix = printable(request, 'suffix', '');
  const specialChars = printable(request, 'specialChars', DEFAULT_SPECIAL);
  const customChars = printable(request, 'customChars', '');
  const extraChars = printable(request, 'extraChars', '');
  const excludeChars = printable(request, 'excludeChars', '');
  const customOnly = boolean(request, 'customOnly', false);
  const requireEach = boolean(request, 'requireEach', true);
  const excludeConfusing = boolean(request, 'excludeConfusing', false);
  const selectedGroups = [
    { enabled: boolean(request, 'lowercase', true), chars: LOWERCASE },
    { enabled: boolean(request, 'uppercase', true), chars: UPPERCASE },
    { enabled: boolean(request, 'digits', true), chars: DIGITS },
    { enabled: boolean(request, 'special', true), chars: specialChars },
  ];
  const excluded = new Set(excludeChars + (excludeConfusing ? CONFUSING : ''));
  const filter = (characters: string): string =>
    unique(characters).split('').filter((character) => !excluded.has(character)).join('');
  const rawGroups = customOnly ? [customChars] : selectedGroups.filter((group) => group.enabled).map((group) => group.chars);
  const groups = rawGroups.map(filter);
  if (requireEach && groups.some((group) => group.length === 0)) {
    return fail('requiredGroupEmpty');
  }
  const alphabet = filter(rawGroups.join('') + extraChars);
  if (alphabet.length === 0) return fail('emptyCharset');
  if (prefix.length + suffix.length > minLength) return fail('impossibleRules');
  if ([...prefix, ...suffix].some((character) => excluded.has(character))) {
    return fail('impossibleRules');
  }
  if (username && prefix.length > 0 && !isLetter(prefix[0] ?? '')) {
    return fail('impossibleRules');
  }
  const affixes = prefix + suffix;
  // 固定前后缀可满足必选类别，附加字符本身不要求必须出现。
  const missingGroups = requireEach ? groups.filter((group) => !containsAny(affixes, group)) : [];
  const firstAlphabet = alphabet.split('').filter(isLetter).join('');
  return { minLength, maxLength, username, prefix, suffix, alphabet, firstAlphabet, missingGroups };
}

function passwordSpace(rules: PasswordRules): bigint {
  const firstMustBeLetter = rules.username && rules.prefix.length === 0;
  const minFreeLength = rules.minLength - rules.prefix.length - rules.suffix.length;
  const terms: { sign: bigint; allowedCount: bigint; firstCount: bigint; power: bigint }[] = [];
  // 容斥原理支持重叠类别；集合只随配置变化，同一请求的长度范围可复用计数。
  for (let mask = 0; mask < 2 ** rules.missingGroups.length; mask += 1) {
    const forbidden = new Set<string>();
    let selected = 0;
    for (let index = 0; index < rules.missingGroups.length; index += 1) {
      if ((mask & (1 << index)) !== 0) {
        selected += 1;
        for (const character of rules.missingGroups[index] ?? '') forbidden.add(character);
      }
    }
    const allowed = rules.alphabet.split('').filter((character) => !forbidden.has(character));
    const allowedCount = BigInt(allowed.length);
    terms.push({
      sign: selected % 2 === 0 ? 1n : -1n,
      allowedCount,
      firstCount: BigInt(firstMustBeLetter ? allowed.filter(isLetter).length : allowed.length),
      power: minFreeLength > 0 ? allowedCount ** BigInt(minFreeLength - 1) : 1n,
    });
  }
  let space = 0n;
  for (let length = rules.minLength; length <= rules.maxLength; length += 1) {
    const freeLength = length - rules.prefix.length - rules.suffix.length;
    if (freeLength === 0 && rules.username && !isLetter((rules.prefix + rules.suffix)[0] ?? '')) {
      return fail('impossibleRules');
    }
    let atLength = 0n;
    for (const term of terms) {
      atLength += term.sign * (freeLength === 0 ? 1n : term.firstCount * term.power);
      if (freeLength > 0) term.power *= term.allowedCount;
    }
    // 范围内每个长度都必须可行，不能静默缩小用户配置的范围。
    if (atLength === 0n) return fail('impossibleRules');
    space += atLength;
  }
  return space;
}

function password(request: Request, count: number): GenerationResult {
  const rules = passwordRules(request);
  if (passwordSpace(rules) < BigInt(count)) return fail('insufficientSpace');
  const values = new Set<string>();
  const random = new RequestRandom();
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS && values.size < count; attempt += 1) {
      const length = rules.minLength === rules.maxLength
        ? rules.minLength
        : rules.minLength + random.integer(rules.maxLength - rules.minLength + 1);
      const freeLength = length - rules.prefix.length - rules.suffix.length;
      let candidate = rules.prefix;
      for (let index = 0; index < freeLength; index += 1) {
        const alphabet = index === 0 && rules.username && rules.prefix.length === 0
          ? rules.firstAlphabet
          : rules.alphabet;
        candidate += alphabet[random.integer(alphabet.length)];
      }
      candidate += rules.suffix;
      // 均匀抽取完整候选再拒绝不合规则的值，不通过补入字符引入偏差。
      if (rules.missingGroups.every((group) => containsAny(candidate, group))) {
        values.add(candidate);
      }
    }
  } finally {
    random.dispose();
  }
  if (values.size !== count) return fail('attemptsExceeded');
  return {
    values: [...values],
    sensitive: !rules.username,
    metadata: {
      kind: 'password',
      username: rules.username,
      ...(rules.minLength === rules.maxLength ? { length: rules.minLength } : {}),
      minLength: rules.minLength,
      maxLength: rules.maxLength,
      charsetSize: rules.alphabet.length,
    },
  };
}

function key(request: Request, count: number): GenerationResult {
  const purpose = text(request, 'purpose', 'jwt', 'invalidRequest');
  if (purpose !== 'jwt' && purpose !== 'generic') return fail('invalidRequest');
  const algorithm = text(request, 'algorithm', 'HS256', 'invalidAlgorithm');
  if (algorithm !== 'HS256' && algorithm !== 'HS384' && algorithm !== 'HS512') {
    return fail('invalidAlgorithm');
  }
  const minimum = purpose === 'jwt' ? HMAC_MIN_BYTES[algorithm] : 16;
  const bytes = integer(request, 'bytes', purpose === 'jwt' ? minimum : 32, minimum, 128, 'invalidKeySize');
  const encoding = text(request, 'encoding', 'base64url', 'invalidEncoding');
  if (encoding !== 'base64url' && encoding !== 'base64' && encoding !== 'hex') {
    return fail('invalidEncoding');
  }
  const values = new Set<string>();
  const attempts = Math.min(MAX_ATTEMPTS, Math.floor(MAX_RANDOM_BYTES / bytes));
  for (let attempt = 0; attempt < attempts && values.size < count; attempt += 1) {
    const material = randomBytes(bytes);
    try {
      values.add(material.toString(encoding));
    } finally {
      material.fill(0);
    }
  }
  if (values.size !== count) return fail('attemptsExceeded');
  return {
    values: [...values],
    sensitive: true,
    metadata: { kind: 'key', purpose, ...(purpose === 'jwt' ? { algorithm } : {}), bytes, encoding },
  };
}

/** 解析逗号分隔的端口或闭区间，并合并重复项。 */
export function parsePortExclusions(value: string): number[] {
  if (typeof value !== 'string') return fail('invalidPortExclusions');
  if (value.trim() === '') return [];
  const ports = new Set<number>();
  for (const rawPart of value.split(',')) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(rawPart.trim());
    if (match === null) return fail('invalidPortExclusions');
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end > 65535 || start > end) {
      return fail('invalidPortExclusions');
    }
    for (let port = start; port <= end; port += 1) ports.add(port);
  }
  return [...ports].sort((left, right) => left - right);
}

function port(request: Request, count: number): GenerationResult {
  const min = integer(request, 'min', 1024, 1, 65535, 'invalidPortRange');
  const max = integer(request, 'max', 49151, 1, 65535, 'invalidPortRange');
  if (min > max) return fail('invalidPortRange');
  const excludeCommon = boolean(request, 'excludeCommon', true);
  const exclude = text(request, 'exclude', '', 'invalidPortExclusions');
  const excluded = new Set(parsePortExclusions(exclude));
  if (excludeCommon) {
    for (const common of Object.keys(COMMON_PORTS)) excluded.add(Number(common));
  }
  const candidates: number[] = [];
  for (let candidate = min; candidate <= max; candidate += 1) {
    if (!excluded.has(candidate)) candidates.push(candidate);
  }
  const candidateCount = candidates.length;
  if (candidateCount < count) return fail('insufficientSpace');
  // 部分 Fisher-Yates 洗牌实现无放回采样，并避免取模偏差。
  const values: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const selected = randomInt(index, candidates.length);
    const candidate = candidates[selected];
    const previous = candidates[index];
    if (candidate === undefined || previous === undefined) return fail('invalidRequest');
    candidates[index] = candidate;
    candidates[selected] = previous;
    values.push(String(candidate));
  }
  return {
    values,
    sensitive: false,
    metadata: { kind: 'port', min, max, candidateCount, excludedCount: max - min + 1 - candidateCount },
  };
}

/** 校验不可信 Webview 请求并在本地生成结果，不持久化生成值。 */
export function generate(value: unknown): GenerationResult {
  const request = requestRecord(value);
  if (request.kind !== 'password' && request.kind !== 'key' && request.kind !== 'port') {
    return fail('invalidRequest');
  }
  const count = integer(request, 'count', 1, 1, 100, 'invalidCount');
  switch (request.kind) {
    case 'password': return password(request, count);
    case 'key': return key(request, count);
    case 'port': return port(request, count);
  }
}
