import { strict as assert } from 'node:assert';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mock, test } from 'node:test';
import { GeneratorError } from '../src/generator.ts';
import { runUtility } from '../src/utilities.ts';

function fails(request: unknown, code: string): void {
  assert.throws(() => runUtility(request), (error: unknown) => error instanceof GeneratorError
    && error.code === code && error.message === code);
}

function value(request: unknown): string {
  const result = runUtility(request);
  assert.equal(result.values.length, 1);
  return result.values[0];
}

function timestamp(input: string, operation = 'toDate', unit = 'milliseconds'): Record<string, unknown> {
  return JSON.parse(value({ kind: 'timestamp', input, operation, unit })) as Record<string, unknown>;
}

function base64(input: string, operation = 'encode', variant = 'base64', format = 'utf8'): string {
  return value({ kind: 'base64', input, operation, variant, format });
}

function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function token(header: unknown, payload: unknown, signature = ''): string {
  return `${segment(header)}.${segment(payload)}.${signature}`;
}

function withUuid(source: () => `${string}-${string}-${string}-${string}-${string}`, run: () => void): void {
  const crypto = createRequire(`${process.cwd()}/utilities.test.ts`)('node:crypto') as typeof import('node:crypto');
  const stub = mock.method(crypto, 'randomUUID', source);
  syncBuiltinESMExports();
  try {
    run();
  } finally {
    stub.mock.restore();
    syncBuiltinESMExports();
  }
}

const firstUuid = '00000000-0000-4000-8000-000000000000';
const secondUuid = '00000000-0000-4000-8000-000000000001';

test('UUID defaults use standard RFC version 4 and variant bits', () => {
  const result = runUtility({ kind: 'uuid' });
  assert.equal(result.values.length, 1);
  assert.match(result.values[0], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(result.sensitive, false);
  assert.deepEqual(result.metadata, { kind: 'uuid', version: 4, format: 'standard' });
});

test('UUID batches contain 100 unique compact uppercase identifiers', () => {
  const result = runUtility({ kind: 'uuid', count: 100, format: 'compact', uppercase: true });
  assert.equal(result.values.length, 100);
  assert.equal(new Set(result.values).size, 100);
  for (const id of result.values) assert.match(id, /^[0-9A-F]{12}4[0-9A-F]{3}[89AB][0-9A-F]{15}$/);
});

test('UUID standard uppercase preserves hyphens and version bits', () => {
  assert.match(value({ kind: 'uuid', uppercase: true }), /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
});

test('UUID rejects invalid count, formatting and booleans', () => {
  for (const count of [0, -1, 101, 1.5, NaN, Infinity, '2', null]) fails({ kind: 'uuid', count }, 'invalidCount');
  for (const format of ['', 'v1', null, false]) fails({ kind: 'uuid', format }, 'invalidUuidFormat');
  for (const uppercase of [1, 'true', null]) fails({ kind: 'uuid', uppercase }, 'invalidRequest');
});

test('UUID collision is retried within the same batch', () => {
  let calls = 0;
  withUuid(() => ++calls < 3 ? firstUuid : secondUuid, () => {
    assert.deepEqual(runUtility({ kind: 'uuid', count: 2 }).values, [firstUuid, secondUuid]);
  });
  assert.equal(calls, 3);
});

test('UUID repeated random source stops at a bounded budget', () => {
  let calls = 0;
  withUuid(() => { calls += 1; return firstUuid; }, () => fails({ kind: 'uuid', count: 2 }, 'attemptsExceeded'));
  assert.equal(calls, 32);
});

test('SHA-256 defaults match the empty and abc published vectors', () => {
  assert.equal(value({ kind: 'hash', input: '' }), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  const result = runUtility({ kind: 'hash', input: 'abc' });
  assert.equal(result.values[0], 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(result.sensitive, true);
  assert.deepEqual(result.metadata, { kind: 'hash', algorithm: 'sha256', encoding: 'hex' });
});

test('SHA-512 matches its abc published vector', () => {
  assert.equal(value({ kind: 'hash', algorithm: 'sha512', input: 'abc' }),
    'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f');
});

test('SHA-1 and MD5 match their empty and abc published vectors', () => {
  assert.equal(value({ kind: 'hash', algorithm: 'sha1', input: '' }), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
  assert.equal(value({ kind: 'hash', algorithm: 'sha1', input: 'abc' }), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(value({ kind: 'hash', algorithm: 'md5', input: '' }), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(value({ kind: 'hash', algorithm: 'md5', input: 'abc' }), '900150983cd24fb0d6963f7d28e17f72');
});

test('hash base64 encoding is exact and keeps whitespace significant', () => {
  assert.equal(value({ kind: 'hash', input: 'abc', encoding: 'base64' }), 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
  assert.notEqual(value({ kind: 'hash', input: ' abc\n' }), value({ kind: 'hash', input: 'abc' }));
});

test('hash algorithms and encodings are an explicit allowlist', () => {
  for (const algorithm of ['SHA256', 'shake128', '', null, {}]) fails({ kind: 'hash', input: 'x', algorithm }, 'invalidHash');
  for (const encoding of ['utf8', 'base64url', null]) fails({ kind: 'hash', input: 'x', encoding }, 'invalidHash');
});

test('timestamp epoch zero returns the complete UTC JSON result', () => {
  assert.deepEqual(timestamp('0'), { iso: '1970-01-01T00:00:00.000Z', utc: 'Thu, 01 Jan 1970 00:00:00 GMT', seconds: 0, milliseconds: 0 });
  assert.deepEqual(timestamp('0', 'toDate', 'seconds'), timestamp('0'));
  const result = runUtility({ kind: 'timestamp', operation: 'toDate', input: '0', unit: 'seconds' });
  assert.equal(result.sensitive, false);
  assert.deepEqual(result.metadata, { kind: 'timestamp', operation: 'toDate', unit: 'seconds' });
});

test('negative timestamps floor seconds rather than truncating', () => {
  assert.equal(timestamp('-1').iso, '1969-12-31T23:59:59.999Z');
  assert.equal(timestamp('-1').seconds, -1);
  assert.equal(timestamp('-1', 'toDate', 'seconds').milliseconds, -1000);
});

test('timestamp accepts both inclusive JS date range boundaries', () => {
  assert.equal(timestamp('8640000000000000').iso, '+275760-09-13T00:00:00.000Z');
  assert.equal(timestamp('-8640000000000000').iso, '-271821-04-20T00:00:00.000Z');
  assert.equal(timestamp('8640000000000', 'toDate', 'seconds').milliseconds, 8640000000000000);
  assert.equal(timestamp('-8640000000000', 'toDate', 'seconds').milliseconds, -8640000000000000);
});

test('timestamp rejects fractional, unsafe, oversized and whitespace numbers', () => {
  for (const input of ['1.5', '', ' 0', '0\n', '1e3', '0x10', 'NaN', 'Infinity', '9007199254740993', '8640000000000001', '-8640000000000001']) {
    fails({ kind: 'timestamp', operation: 'toDate', input, unit: 'milliseconds' }, 'invalidTimestamp');
  }
  fails({ kind: 'timestamp', operation: 'toDate', input: '8640000000001', unit: 'seconds' }, 'invalidTimestamp');
});

test('timestamp operations and units are checked', () => {
  for (const operation of ['', 'parse', null]) fails({ kind: 'timestamp', input: '0', operation, unit: 'seconds' }, 'invalidTimestamp');
  for (const unit of ['', 'minutes', null]) fails({ kind: 'timestamp', input: '0', operation: 'toDate', unit }, 'invalidTimestamp');
});

test('ISO date supports leap year and 1 to 3 millisecond digits', () => {
  assert.equal(timestamp('2024-02-29T12:34:56Z', 'toTimestamp').iso, '2024-02-29T12:34:56.000Z');
  assert.equal(timestamp('2000-02-29T00:00:00.1Z', 'toTimestamp').iso, '2000-02-29T00:00:00.100Z');
  assert.equal(timestamp('2024-02-29T12:34:56.12Z', 'toTimestamp').iso, '2024-02-29T12:34:56.120Z');
  assert.equal(timestamp('2024-02-29T12:34:56.123Z', 'toTimestamp').iso, '2024-02-29T12:34:56.123Z');
});

test('ISO date offsets are explicit and converted without using local time', () => {
  assert.equal(timestamp('1970-01-01T05:30:00+05:30', 'toTimestamp').milliseconds, 0);
  assert.equal(timestamp('1969-12-31T16:00:00-08:00', 'toTimestamp', 'seconds').milliseconds, 0);
  assert.equal(timestamp('1970-01-01T00:00:00-23:59', 'toTimestamp').milliseconds, 86340000);
});

test('ISO years zero, ninety-nine and expanded signed years are retained', () => {
  assert.equal(timestamp('0000-02-29T00:00:00Z', 'toTimestamp').iso, '0000-02-29T00:00:00.000Z');
  assert.equal(timestamp('0099-01-01T00:00:00Z', 'toTimestamp').iso, '0099-01-01T00:00:00.000Z');
  assert.equal(timestamp('+010000-01-01T00:00:00Z', 'toTimestamp').iso, '+010000-01-01T00:00:00.000Z');
  assert.equal(timestamp('-000001-01-01T00:00:00Z', 'toTimestamp').iso, '-000001-01-01T00:00:00.000Z');
});

test('ISO date refuses calendar normalization and non-leap February 29', () => {
  for (const input of ['2023-02-29T00:00:00Z', '1900-02-29T00:00:00Z', '2024-02-30T00:00:00Z', '2024-04-31T00:00:00Z', '2024-00-01T00:00:00Z', '2024-13-01T00:00:00Z', '2024-01-00T00:00:00Z']) {
    fails({ kind: 'timestamp', operation: 'toTimestamp', input, unit: 'milliseconds' }, 'invalidDate');
  }
});

test('ISO date refuses absent zones, loose formats and invalid time components', () => {
  for (const input of ['2024-01-01', '2024-01-01T00:00:00', '2024-01-01 00:00:00Z', '2024-1-01T00:00:00Z', '2024-01-01t00:00:00z', '2024-01-01T24:00:00Z', '2024-01-01T00:60:00Z', '2024-01-01T00:00:60Z', '2024-01-01T00:00:00.1234Z', '2024-01-01T00:00:00+24:00', '2024-01-01T00:00:00+00:60', '2024-01-01T00:00:00+0800', '-000000-01-01T00:00:00Z']) {
    fails({ kind: 'timestamp', operation: 'toTimestamp', input, unit: 'milliseconds' }, 'invalidDate');
  }
});

test('ISO date validates final date range after offset arithmetic', () => {
  assert.equal(timestamp('+275760-09-13T00:00:00Z', 'toTimestamp').milliseconds, 8640000000000000);
  assert.equal(timestamp('-271821-04-20T00:00:00Z', 'toTimestamp').milliseconds, -8640000000000000);
  assert.equal(timestamp('+275760-09-13T00:01:00+00:01', 'toTimestamp').milliseconds, 8640000000000000);
  assert.equal(timestamp('-271821-04-19T23:59:00-00:01', 'toTimestamp').milliseconds, -8640000000000000);
  for (const input of ['+275760-09-13T00:00:00.001Z', '-271821-04-19T23:59:59.999Z', '+275760-09-13T00:00:00-00:01', '-271821-04-20T00:00:00+00:01']) {
    fails({ kind: 'timestamp', operation: 'toTimestamp', input, unit: 'milliseconds' }, 'invalidDate');
  }
});

test('base64 standard encoding matches RFC text vectors', () => {
  for (const [input, output] of [['', ''], ['f', 'Zg=='], ['fo', 'Zm8='], ['foo', 'Zm9v'], ['foob', 'Zm9vYg=='], ['fooba', 'Zm9vYmE='], ['foobar', 'Zm9vYmFy']]) {
    assert.equal(base64(input), output);
    assert.equal(base64(output, 'decode'), input);
  }
});

test('base64url encoding uses the URL-safe alphabet without padding', () => {
  assert.equal(base64('fbffff', 'encode', 'base64url', 'hex'), '-___');
  assert.equal(base64('ff', 'encode', 'base64url', 'hex'), '_w');
  assert.equal(base64('_w', 'decode', 'base64url', 'hex'), 'ff');
  assert.equal(base64('_w==', 'decode', 'base64url', 'hex'), 'ff');
});

test('base64 decoding accepts only canonical padded or unpadded data', () => {
  for (const input of ['Zg==', 'Zg']) assert.equal(base64(input, 'decode'), 'f');
  for (const input of ['Zm8=', 'Zm8']) assert.equal(base64(input, 'decode'), 'fo');
  for (const input of ['Zm9v', '']) assert.equal(base64(input, 'decode'), input === '' ? '' : 'foo');
});

test('base64 rejects nonzero tail bits rather than silently discarding them', () => {
  for (const input of ['Zh', 'Zh==', 'Zm9', 'Zm9=']) fails({ kind: 'base64', operation: 'decode', input, variant: 'base64', format: 'utf8' }, 'invalidBase64');
  for (const input of ['_x', '_x==']) fails({ kind: 'base64', operation: 'decode', input, variant: 'base64url', format: 'hex' }, 'invalidBase64');
});

test('base64 refuses illegal characters, whitespace and misplaced padding', () => {
  for (const input of ['Z', 'Zg=', 'Zg===', 'Zm9v=', 'Z=g=', '==', '=', 'Zg==\n', ' Zg==', 'Zg==\u00a0', 'Zg!@', 'Zg==junk', 'Zg==\0']) {
    fails({ kind: 'base64', operation: 'decode', input, variant: 'base64', format: 'utf8' }, 'invalidBase64');
  }
});

test('base64 and base64url alphabets cannot be mixed', () => {
  for (const input of ['_w==', '-___', '+_//']) fails({ kind: 'base64', operation: 'decode', input, variant: 'base64', format: 'hex' }, 'invalidBase64');
  for (const input of ['/w==', '+///', '+_//']) fails({ kind: 'base64', operation: 'decode', input, variant: 'base64url', format: 'hex' }, 'invalidBase64');
});

test('base64 UTF-8 preserves Unicode, whitespace, NUL and a literal BOM', () => {
  for (const input of ['你好🙂', ' \t\n\r\u00a0', '\0x\0', '\ufefftext']) {
    assert.equal(base64(base64(input), 'decode'), input);
    assert.equal(base64(base64(input, 'encode', 'base64url'), 'decode', 'base64url'), input);
  }
});

test('base64 UTF-8 fatal decoder rejects malformed encoded bytes', () => {
  for (const hex of ['ff', 'c0af', 'e08080', 'eda080', 'f4908080', 'e282', '80']) {
    const input = base64(hex, 'encode', 'base64', 'hex');
    fails({ kind: 'base64', operation: 'decode', input, variant: 'base64', format: 'utf8' }, 'invalidUtf8');
    assert.equal(base64(input, 'decode', 'base64', 'hex'), hex);
  }
});

test('base64 hex encoding requires exact complete byte pairs', () => {
  assert.equal(base64('48656C6c6F', 'encode', 'base64', 'hex'), 'SGVsbG8=');
  assert.equal(base64('SGVsbG8=', 'decode', 'base64', 'hex'), '48656c6c6f');
  for (const input of ['0', 'abc', '0g', '0x00', '00 00', '00\n', 'ＦＦ']) {
    fails({ kind: 'base64', operation: 'encode', input, variant: 'base64', format: 'hex' }, 'invalidBase64');
  }
});

test('base64 empty strings stay a single sensitive result with metadata', () => {
  for (const operation of ['encode', 'decode']) {
    const result = runUtility({ kind: 'base64', operation, input: '', variant: 'base64', format: 'utf8' });
    assert.deepEqual(result.values, ['']);
    assert.equal(result.sensitive, true);
    assert.deepEqual(result.metadata, { kind: 'base64', operation, variant: 'base64', format: 'utf8' });
  }
});

test('base64 operation, variant and format are checked', () => {
  const request = { kind: 'base64', operation: 'encode', input: 'foo', variant: 'base64', format: 'utf8' };
  for (const field of ['operation', 'variant', 'format']) {
    for (const item of ['', false, null]) fails({ ...request, [field]: item }, 'invalidBase64');
  }
});

test('URL returns parse-only JSON, credentials and duplicate query entries as sensitive data', () => {
  const result = runUtility({ kind: 'url', input: 'https://alice:p%40ss@example.com:8443/a%20b?x=1&x=2&blank=&flag#frag' });
  assert.equal(result.sensitive, true);
  assert.deepEqual(result.metadata, { kind: 'url' });
  assert.deepEqual(JSON.parse(result.values[0]), {
    protocol: 'https:', hostname: 'example.com', port: '8443', pathname: '/a%20b',
    search: '?x=1&x=2&blank=&flag', hash: '#frag', origin: 'https://example.com:8443',
    username: 'alice', password: 'p%40ss',
    query: [{ key: 'x', value: '1' }, { key: 'x', value: '2' }, { key: 'blank', value: '' }, { key: 'flag', value: '' }],
  });
  assert.equal(result.values[0].startsWith('https://'), false);
});

test('URL uses Node URL behavior for IDN, IPv6, default ports and query decoding', () => {
  const idn = JSON.parse(value({ kind: 'url', input: 'https://例子.测试:443/?q=hello+world&q=%F0%9F%99%82' }));
  assert.equal(idn.hostname, 'xn--fsqu00a.xn--0zwm56d');
  assert.equal(idn.port, '');
  assert.deepEqual(idn.query, [{ key: 'q', value: 'hello world' }, { key: 'q', value: '🙂' }]);
  const ipv6 = JSON.parse(value({ kind: 'url', input: 'http://[::1]:80/' }));
  assert.equal(ipv6.hostname, '[::1]');
  assert.equal(ipv6.origin, 'http://[::1]');
});

test('URL rejects relative and dangerous schemes without executing them', () => {
  for (const input of ['', '/path', '//example.com/path', 'javascript:alert(1)', 'data:text/plain,foo', 'file:///etc/passwd', 'ftp://example.com/', 'https:example.com', 'https:///example.com']) {
    fails({ kind: 'url', input }, 'invalidUrl');
  }
});

test('URL rejects malformed hosts, invalid ports and silently repaired characters', () => {
  for (const input of ['https://', 'https://[nope]/', 'https://example.com:65536/', 'https://exa mple.com/', ' https://example.com', 'https://example.com\n', 'https://example.com/a\\b', 'https://example.com/\0']) {
    fails({ kind: 'url', input }, 'invalidUrl');
  }
});

test('JWT decodes header and claims without verifying signature or expiry', () => {
  const header = { alg: 'HS256', typ: 'JWT', kid: 'test' };
  const payload = { sub: 'alice', exp: 1, iat: 9999999999, roles: ['admin'], nested: { enabled: true } };
  const result = runUtility({ kind: 'jwt', input: token(header, payload, 'ZmFrZQ') });
  assert.deepEqual(JSON.parse(result.values[0]), { header, payload, signatureVerified: false });
  assert.equal(result.sensitive, true);
  assert.deepEqual(result.metadata, { kind: 'jwt', verified: false });
});

test('JWT alg none permits an empty signature but still reports unverified', () => {
  assert.deepEqual(JSON.parse(value({ kind: 'jwt', input: token({ alg: 'none' }, { sub: 'guest' }) })), {
    header: { alg: 'none' }, payload: { sub: 'guest' }, signatureVerified: false,
  });
});

test('JWT does not choose any execution or verification from its algorithm header', () => {
  for (const alg of ['RS256', 'not-an-algorithm', 'none', null, { command: 'ignore' }]) {
    const result = JSON.parse(value({ kind: 'jwt', input: token({ alg }, {}, 'AA') }));
    assert.deepEqual(result.header, { alg });
    assert.equal(result.signatureVerified, false);
  }
});

test('JWT retains Unicode and prototype-named JSON claims as plain data', () => {
  const payload = JSON.parse('{"__proto__":{"polluted":true},"text":"你好🙂","constructor":"claim"}');
  const result = JSON.parse(value({ kind: 'jwt', input: token({}, payload) }));
  assert.deepEqual(result.payload, payload);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('JWT requires exactly three segments and nonempty object header and payload', () => {
  for (const input of ['', 'a', 'a.b', 'a.b.c.d', 'a.b.c.d.e', '..', `${segment({})}..`, `.${segment({})}.`]) fails({ kind: 'jwt', input }, 'invalidJwt');
  for (const item of [null, [], 'text', 42, true]) {
    fails({ kind: 'jwt', input: token(item, {}) }, 'invalidJwt');
    fails({ kind: 'jwt', input: token({}, item) }, 'invalidJwt');
  }
});

test('JWT rejects malformed JSON and UTF-8 header or payload', () => {
  for (const bad of [Buffer.from('{bad').toString('base64url'), '_w', '']) {
    fails({ kind: 'jwt', input: `${bad}.${segment({})}.` }, 'invalidJwt');
    fails({ kind: 'jwt', input: `${segment({})}.${bad}.` }, 'invalidJwt');
  }
});

test('JWT compact syntax rejects padding, mixed alphabets, spaces and bad signature tail bits', () => {
  const good = token({}, {});
  for (const input of [`${segment({})}=.${segment({})}.`, `${segment({})}.${segment({})}=.`, `${good}AA==`, `${good}/w`, `${good}_x`, `${good}A`, ` ${good}`, `${good}\n`]) {
    fails({ kind: 'jwt', input }, 'invalidJwt');
  }
});

test('utility kind and top-level shape reject hostile or non-JSON inputs', () => {
  for (const request of [undefined, null, false, 42, 'hash', [], () => undefined, new Date(), Object.create({ kind: 'uuid' }), {}, { kind: 'key' }, { kind: null }, { kind: {} }]) fails(request, 'invalidRequest');
  const request = Object.assign(Object.create(null), { kind: 'hash', input: 'abc' });
  assert.equal(value(request), value({ kind: 'hash', input: 'abc' }));
  fails({ kind: 'uuid', [Symbol('extra')]: true }, 'invalidRequest');
});

test('utility property accessors are rejected without executing code', () => {
  let calls = 0;
  for (const key of ['kind', 'input', 'unused']) {
    const request = { kind: 'hash', input: 'secret' };
    Object.defineProperty(request, key, { get() { calls += 1; throw new Error('secret'); } });
    fails(request, 'invalidRequest');
  }
  assert.equal(calls, 0);
});

test('utility proxies including revoked proxies are rejected without triggering traps', () => {
  let calls = 0;
  const request = new Proxy({ kind: 'uuid' }, {
    getPrototypeOf() { calls += 1; throw new Error('secret'); },
    ownKeys() { calls += 1; throw new Error('secret'); },
    get() { calls += 1; throw new Error('secret'); },
  });
  fails(request, 'invalidRequest');
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  fails(revoked.proxy, 'invalidRequest');
  assert.equal(calls, 0);
});

test('utility text fields reject coercion and lone UTF-16 surrogates', () => {
  let calls = 0;
  for (const input of [undefined, null, 42, [], { toString() { calls += 1; return 'secret'; } }, '\ud800', '\udfff', 'a\ud800x']) {
    fails({ kind: 'hash', input }, 'invalidText');
  }
  assert.equal(calls, 0);
});

test('all text utilities reject inputs above the UTF-8 byte budget with codes only', () => {
  const input = 'x'.repeat(65537);
  for (const kind of ['hash', 'timestamp', 'base64', 'url', 'jwt']) fails({ kind, input }, 'inputTooLarge');
  fails({ kind: 'hash', input: '🙂'.repeat(16385) }, 'inputTooLarge');
});

test('exact 64 KiB ASCII and Unicode inputs are accepted and output stays bounded', () => {
  assert.equal(value({ kind: 'hash', input: 'x'.repeat(65536) }).length, 64);
  assert.equal(value({ kind: 'hash', input: '🙂'.repeat(16384) }).length, 64);
  const input = 'x'.repeat(65536);
  const encoded = base64(input);
  assert.equal(encoded.length, 87384);
});

test('hex decode expansion stays below the 128 KiB output limit', () => {
  const input = 'A'.repeat(65536);
  const output = base64(input, 'decode', 'base64', 'hex');
  assert.equal(output.length, 98304);
  assert.ok(Buffer.byteLength(output, 'utf8') <= 131072);
});

test('URL query expansion enforces the total 128 KiB UTF-8 output budget', () => {
  fails({ kind: 'url', input: `https://example.com/?${'x&'.repeat(12000)}` }, 'outputTooLarge');
});

test('JWT deeply nested valid JSON within the input budget does not overflow serialization', () => {
  const json = `{"nested":${'['.repeat(6000)}0${']'.repeat(6000)}}`;
  const encoded = Buffer.from(json, 'utf8').toString('base64url');
  const input = `${encoded}.${encoded}.`;
  assert.ok(Buffer.byteLength(input, 'utf8') < 65536);
  const output = value({ kind: 'jwt', input });
  const parsed = JSON.parse(output);
  assert.equal(parsed.signatureVerified, false);
  for (const field of ['header', 'payload']) {
    let nested: unknown = parsed[field].nested;
    for (let level = 0; level < 6000; level += 1) {
      assert.ok(Array.isArray(nested));
      nested = (nested as unknown[])[0];
    }
    assert.equal(nested, 0);
  }
});
