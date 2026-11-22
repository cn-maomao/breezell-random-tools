import { strict as assert } from 'node:assert';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mock, test } from 'node:test';
import { COMMON_PORTS, generate, GeneratorError, parsePortExclusions } from '../src/generator.ts';

const passwordRequest = {
  kind: 'password',
  count: 1,
  length: 20,
  minLength: 20,
  maxLength: 24,
  rangeLength: false,
  lowercase: true,
  uppercase: true,
  digits: true,
  special: true,
  specialChars: '!@#$%^&*()-_=+',
  extraChars: '',
  excludeChars: '',
  excludeConfusing: false,
  requireEach: true,
  customOnly: false,
  customChars: '',
  username: false,
  prefix: '',
  suffix: '',
};

const customRequest = {
  ...passwordRequest,
  customOnly: true,
  customChars: 'ab',
  length: 2,
};

function errorCode(expected: string): (error: unknown) => boolean {
  return (error: unknown): boolean => error instanceof GeneratorError && error.code === expected && error.message === expected;
}

function fails(request: unknown, code: string): void {
  assert.throws(() => generate(request), errorCode(code));
}

function distinct(values: string[], count: number): void {
  assert.equal(values.length, count);
  assert.equal(new Set(values).size, count);
}

function withRandomBytes(source: (size: number) => Buffer, run: () => void): void {
  // CommonJS 内置模块可修改，ESM 命名空间不能直接替换方法。
  const crypto = createRequire(`${process.cwd()}/generator.test.ts`)('node:crypto') as typeof import('node:crypto');
  const stub = mock.method(crypto, 'randomBytes', source);
  syncBuiltinESMExports();
  try {
    run();
  } finally {
    stub.mock.restore();
    syncBuiltinESMExports();
  }
}

const printableAlphabet = Array.from({ length: 94 }, (_, index) => String.fromCharCode(33 + index)).join('');

test('password defaults are sensitive, length 20, and contain every selected class', () => {
  const result = generate({ kind: 'password', count: 100 });
  distinct(result.values, 100);
  assert.equal(result.sensitive, true);
  assert.equal(result.metadata.kind, 'password');
  assert.equal(result.metadata.length, 20);
  for (const value of result.values) {
    assert.equal(value.length, 20);
    assert.match(value, /^[A-Za-z0-9!@#$%^&*()\-_=+]+$/);
    assert.match(value, /[a-z]/);
    assert.match(value, /[A-Z]/);
    assert.match(value, /[0-9]/);
    assert.match(value, /[!@#$%^&*()\-_=+]/);
  }
});

test('fixed and ranged password lengths include prefix and suffix', () => {
  const result = generate({ ...passwordRequest, count: 100, rangeLength: true, minLength: 12, maxLength: 24, prefix: 'id_', suffix: '_end' });
  distinct(result.values, 100);
  assert.equal(result.metadata.minLength, 12);
  assert.equal(result.metadata.maxLength, 24);
  assert.equal(result.metadata.length, undefined);
  for (const value of result.values) {
    assert.ok(value.length >= 12 && value.length <= 24);
    assert.ok(value.startsWith('id_') && value.endsWith('_end'));
  }
  const fixed = generate({ ...customRequest, length: 7, prefix: 'pre', suffix: 'x' });
  assert.equal(fixed.values[0]?.length, 7);
});

test('username generation guarantees an ASCII letter first without changing total length', () => {
  const result = generate({ ...passwordRequest, username: true, count: 100, length: 16, suffix: '_id' });
  distinct(result.values, 100);
  assert.equal(result.sensitive, false);
  assert.equal(result.metadata.username, true);
  for (const value of result.values) {
    assert.match(value, /^[A-Za-z]/);
    assert.equal(value.length, 16);
    assert.ok(value.endsWith('_id'));
  }
  const prefixed = generate({ ...customRequest, username: true, prefix: 'U_', suffix: '_x', length: 6, count: 4 });
  distinct(prefixed.values, 4);
  assert.ok(prefixed.values.every((value) => value.startsWith('U_') && value.endsWith('_x')));
});

test('unselected classes are absent from the random portion', () => {
  for (const [option, pattern] of [
    ['lowercase', /^[a-z]+$/],
    ['uppercase', /^[A-Z]+$/],
    ['digits', /^[0-9]+$/],
    ['special', /^[!@#$%^&*()\-_=+]+$/],
  ] as const) {
    const result = generate({ ...passwordRequest, lowercase: false, uppercase: false, digits: false, special: false, [option]: true, count: 100, length: 8 });
    distinct(result.values, 100);
    assert.ok(result.values.every((value) => pattern.test(value)));
  }
});

test('extra characters enlarge the deduplicated pool but need not occur', () => {
  const result = generate({ ...customRequest, customChars: 'aaaa', extraChars: 'bbbba', requireEach: false, count: 4 });
  assert.equal(result.metadata.charsetSize, 2);
  assert.deepEqual(new Set(result.values), new Set(['aa', 'ab', 'ba', 'bb']));
});

test('a custom required group is not silently replaced by extra characters', () => {
  const result = generate({ ...customRequest, customChars: 'a', extraChars: 'b', count: 3 });
  assert.deepEqual(new Set(result.values), new Set(['aa', 'ab', 'ba']));
  fails({ ...customRequest, customChars: 'a', extraChars: 'b', count: 4 }, 'insufficientSpace');
});

test('requireEach uses complete-candidate rejection, including overlapping groups', () => {
  const result = generate({ ...passwordRequest, lowercase: true, uppercase: false, digits: false, special: true, specialChars: 'a', excludeChars: 'cdefghijklmnopqrstuvwxyz', extraChars: 'b', length: 2, count: 3 });
  assert.deepEqual(new Set(result.values), new Set(['aa', 'ab', 'ba']));
  fails({ ...passwordRequest, uppercase: false, digits: false, specialChars: 'a', excludeChars: 'cdefghijklmnopqrstuvwxyz', extraChars: 'b', length: 2, count: 4 }, 'insufficientSpace');
});

test('one character may satisfy multiple overlapping required classes', () => {
  const result = generate({ ...passwordRequest, length: 1, uppercase: false, digits: false, specialChars: 'a', excludeChars: 'bcdefghijklmnopqrstuvwxyz' });
  assert.deepEqual(result.values, ['a']);
});

test('fixed affixes may satisfy selected types while preserving exact length', () => {
  const result = generate({ ...passwordRequest, length: 6, prefix: 'A1!', suffix: 'a' });
  assert.equal(result.values[0]?.length, 6);
  assert.ok(result.values[0]?.startsWith('A1!') && result.values[0]?.endsWith('a'));
  const fixed = generate({ ...passwordRequest, length: 4, prefix: 'A1', suffix: '!a' });
  assert.deepEqual(fixed.values, ['A1!a']);
  fails({ ...passwordRequest, length: 4, prefix: 'A1', suffix: '!a', count: 2 }, 'insufficientSpace');
});

test('excluding characters and confusing glyphs applies to every generated value', () => {
  const result = generate({ ...passwordRequest, count: 100, excludeChars: 'aA!2', excludeConfusing: true });
  distinct(result.values, 100);
  assert.ok(result.values.every((value) => !/[aA!20O1lI]/.test(value)));
  fails({ ...customRequest, prefix: 'a', excludeChars: 'a', length: 3 }, 'impossibleRules');
  fails({ ...customRequest, prefix: 'O', excludeConfusing: true, length: 3 }, 'impossibleRules');
});

test('finite password spaces are counted exactly across all requested lengths', () => {
  const result = generate({ ...customRequest, count: 6, rangeLength: true, minLength: 1, maxLength: 2 });
  assert.deepEqual(new Set(result.values), new Set(['a', 'b', 'aa', 'ab', 'ba', 'bb']));
  fails({ ...customRequest, count: 7, rangeLength: true, minLength: 1, maxLength: 2 }, 'insufficientSpace');
  const username = generate({ ...customRequest, username: true, customChars: 'a1', count: 2 });
  assert.deepEqual(new Set(username.values), new Set(['aa', 'a1']));
  fails({ ...customRequest, username: true, customChars: 'a1', count: 3 }, 'insufficientSpace');
});

test('one-character and maximum-length requests remain valid when rules permit them', () => {
  const short = generate({ ...customRequest, length: 1 });
  assert.equal(short.values[0]?.length, 1);
  const long = generate({ ...passwordRequest, length: 128, count: 100 });
  distinct(long.values, 100);
  assert.ok(long.values.every((value) => value.length === 128));
});

test('invalid counts are rejected consistently for all kinds', () => {
  for (const kind of ['password', 'key', 'port']) {
    for (const count of [0, -1, 101, 1.5, NaN, Infinity, '1', null, true, {}, []]) {
      fails({ kind, count }, 'invalidCount');
    }
  }
});

test('invalid lengths and range order are rejected', () => {
  for (const length of [0, -1, 129, 1.5, NaN, Infinity, '20', null]) {
    fails({ ...passwordRequest, length }, 'invalidLength');
  }
  fails({ ...passwordRequest, rangeLength: true, minLength: 30, maxLength: 20 }, 'invalidLength');
  fails({ ...passwordRequest, minLength: 0 }, 'invalidLength');
  fails({ ...passwordRequest, maxLength: 129 }, 'invalidLength');
});

test('empty pools, emptied required groups, and impossible constraints use explicit errors', () => {
  const noGroups = { ...passwordRequest, lowercase: false, uppercase: false, digits: false, special: false };
  fails(noGroups, 'emptyCharset');
  fails({ ...customRequest, customChars: '', requireEach: false }, 'emptyCharset');
  fails({ ...customRequest, customChars: '' }, 'requiredGroupEmpty');
  fails({ ...passwordRequest, specialChars: '' }, 'requiredGroupEmpty');
  fails({ ...passwordRequest, excludeChars: '0123456789' }, 'requiredGroupEmpty');
  fails({ ...passwordRequest, length: 3 }, 'impossibleRules');
  fails({ ...passwordRequest, rangeLength: true, minLength: 3, maxLength: 20 }, 'impossibleRules');
  fails({ ...customRequest, prefix: 'long', length: 2 }, 'impossibleRules');
  fails({ ...customRequest, username: true, prefix: '1', length: 3 }, 'impossibleRules');
  fails({ ...customRequest, username: true, customChars: '12' }, 'impossibleRules');
  fails({ ...customRequest, username: true, prefix: '', suffix: '12', length: 2 }, 'impossibleRules');
});

test('all configured character and affix fields accept only printable, non-whitespace ASCII', () => {
  for (const field of ['specialChars', 'customChars', 'extraChars', 'excludeChars', 'prefix', 'suffix']) {
    for (const value of [' ', '\n', '\r', '\t', '\0', '\x7f', 'é', '😀', '\u00a0', 1, null, {}, []]) {
      fails({ ...passwordRequest, [field]: value }, 'invalidCharacters');
    }
  }
  const result = generate({ ...customRequest, customChars: '!"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~', requireEach: false, count: 100, length: 4 });
  assert.equal(result.metadata.charsetSize, 94);
  assert.ok(result.values.every((value) => /^[\x21-\x7e]+$/.test(value)));
});

test('boolean request fields are not coerced', () => {
  for (const field of ['rangeLength', 'lowercase', 'uppercase', 'digits', 'special', 'excludeConfusing', 'requireEach', 'customOnly', 'username']) {
    fails({ ...passwordRequest, [field]: 'true' }, 'invalidRequest');
  }
  fails({ kind: 'port', excludeCommon: 'false' }, 'invalidRequest');
});

test('rejection sampling and same-batch duplicates have a bounded retry budget', () => {
  let calls = 0;
  withRandomBytes((size) => { calls += 1; return Buffer.alloc(size); }, () => {
    fails({ ...passwordRequest, lowercase: true, uppercase: true, digits: false, special: false, length: 2 }, 'attemptsExceeded');
    assert.ok(calls > 0 && calls <= 5);
    calls = 0;
    fails({ ...customRequest, count: 2 }, 'attemptsExceeded');
    assert.ok(calls > 0 && calls <= 5);
  });
});

test('password byte sampling rejects the biased tail for three and 94 character pools', () => {
  withRandomBytes((size) => {
    const buffer = Buffer.alloc(size);
    buffer.set([255, 254, 253, 252]);
    return buffer;
  }, () => {
    assert.deepEqual(generate({ ...customRequest, customChars: 'abc', length: 1, count: 3 }).values, ['c', 'b', 'a']);
  });
  withRandomBytes((size) => {
    const buffer = Buffer.alloc(size);
    buffer.set([...Array.from({ length: 68 }, (_, index) => 188 + index), ...Array.from({ length: 188 }, (_, index) => index)]);
    return buffer;
  }, () => {
    const result = generate({ ...customRequest, customChars: printableAlphabet, length: 1, count: 94 });
    assert.deepEqual(result.values, [...printableAlphabet]);
  });
});

test('all accepted byte residues have equal multiplicity and range endpoints remain selectable', () => {
  const observed = new Map<string, number>();
  for (let byte = 0; byte < 255; byte += 1) {
    withRandomBytes((size) => Buffer.alloc(size, byte), () => {
      const value = generate({ ...customRequest, customChars: 'abc', length: 1 }).values[0] as string;
      observed.set(value, (observed.get(value) ?? 0) + 1);
    });
  }
  assert.deepEqual([...observed.values()], [85, 85, 85]);
  withRandomBytes((size) => {
    const buffer = Buffer.alloc(size);
    buffer.set([255, 128, 1]);
    return buffer;
  }, () => {
    const result = generate({ ...customRequest, customChars: 'a', rangeLength: true, minLength: 1, maxLength: 128, count: 3 });
    assert.deepEqual(result.values.map((value) => value.length), [128, 1, 2]);
  });
  withRandomBytes((size) => {
    const buffer = Buffer.alloc(size);
    buffer.set([254, 255, 253, 252]);
    return buffer;
  }, () => {
    const result = generate({ ...customRequest, customChars: 'a', rangeLength: true, minLength: 1, maxLength: 127, count: 2 });
    assert.deepEqual(result.values.map((value) => value.length), [127, 126]);
  });
});

test('maximum length rare required classes stop at the byte budget without weakening rules', () => {
  const excludedLetters = 'bcdefghijklmnopqrstuvwxyzBCDEFGHIJKLMNOPQRSTUVWXYZ';
  const remaining = [...printableAlphabet].filter((character) => !excludedLetters.includes(character) && character !== 'a' && character !== 'A').join('');
  const request = { ...passwordRequest, lowercase: true, uppercase: true, digits: false, special: false, excludeChars: excludedLetters, extraChars: remaining, length: 128, count: 100 };
  let requestedBytes = 0;
  let calls = 0;
  withRandomBytes((size) => { requestedBytes += size; calls += 1; return Buffer.alloc(size); }, () => {
    fails(request, 'attemptsExceeded');
    assert.equal(requestedBytes, 262_144);
    assert.equal(calls, 64);
    requestedBytes = 0;
    calls = 0;
    fails({ ...customRequest, customChars: 'abc', length: 128, count: 100 }, 'attemptsExceeded');
    assert.equal(requestedBytes, 262_144);
    assert.equal(calls, 64);
  });
  withRandomBytes((size) => { calls += 1; return Buffer.alloc(size, 255); }, () => {
    calls = 0;
    fails({ ...customRequest, customChars: 'abc', length: 1 }, 'attemptsExceeded');
    assert.equal(calls, 64);
  });
});

test('deterministic full-space batches preserve required groups, overlaps, usernames and ranges', () => {
  const cases = [
    { request: { ...customRequest, count: 4 }, bytes: [0, 0, 0, 1, 1, 0, 1, 1], expected: ['aa', 'ab', 'ba', 'bb'] },
    { request: { ...customRequest, customChars: 'a', extraChars: 'b', count: 3 }, bytes: [1, 1, 0, 0, 0, 1, 1, 0], expected: ['aa', 'ab', 'ba'] },
    { request: { ...passwordRequest, uppercase: false, digits: false, specialChars: 'a', excludeChars: 'cdefghijklmnopqrstuvwxyz', length: 2, count: 3 }, bytes: [1, 1, 0, 0, 0, 1, 1, 0], expected: ['aa', 'ab', 'ba'] },
    { request: { ...customRequest, username: true, customChars: 'a1', count: 2 }, bytes: [0, 1], expected: ['aa', 'a1'] },
    { request: { ...customRequest, count: 6, rangeLength: true, minLength: 1, maxLength: 2 }, bytes: [0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 1, 0, 1, 1, 1], expected: ['a', 'b', 'aa', 'ab', 'ba', 'bb'] },
  ];
  for (const { request, bytes, expected } of cases) {
    withRandomBytes((size) => { const buffer = Buffer.alloc(size); buffer.set(bytes); return buffer; }, () => {
      assert.deepEqual(generate(request).values, expected);
      fails({ ...request, count: expected.length + 1 }, 'insufficientSpace');
    });
  }
});

test('password buffers are bounded, request-local and wiped on success and failure', () => {
  const buffers: Buffer[] = [];
  let fill = 0;
  withRandomBytes((size) => {
    const buffer = Buffer.alloc(size, fill);
    buffers.push(buffer);
    return buffer;
  }, () => {
    const request = Object.freeze({ ...customRequest });
    const first = generate(request);
    assert.deepEqual(first.values, ['aa']);
    assert.ok(buffers[0]?.every((byte) => byte === 0));
    fill = 1;
    const second = generate(request);
    assert.deepEqual(second.values, ['bb']);
    assert.equal(buffers.length, 2);
    assert.ok(buffers.every((buffer) => buffer.length <= 4_096 && buffer.every((byte) => byte === 0)));
    first.values[0] = 'mutated';
    second.metadata.length = 99;
    assert.deepEqual(generate(request).values, ['bb']);
    fails({ ...request, count: 2 }, 'attemptsExceeded');
    assert.ok(buffers.every((buffer) => buffer.every((byte) => byte === 0)));
  });
});

test('password generation never uses Math.random or per-character randomInt', () => {
  const crypto = createRequire(`${process.cwd()}/generator.test.ts`)('node:crypto') as typeof import('node:crypto');
  const integerStub = mock.method(crypto, 'randomInt', () => { throw new Error('unexpected randomInt'); });
  const mathStub = mock.method(Math, 'random', () => { throw new Error('unexpected Math.random'); });
  syncBuiltinESMExports();
  try {
    distinct(generate({ ...passwordRequest, rangeLength: true, minLength: 16, maxLength: 128, count: 100 }).values, 100);
  } finally {
    integerStub.mock.restore();
    mathStub.mock.restore();
    syncBuiltinESMExports();
  }
});

test('duplicate keys fail within bounded work and random key material is wiped', () => {
  const buffers: Buffer[] = [];
  withRandomBytes((size) => { const buffer = Buffer.alloc(size, 7); buffers.push(buffer); return buffer; }, () => {
    const request = Object.freeze({ kind: 'key', purpose: 'generic', bytes: 128, encoding: 'hex' });
    const first = generate(request);
    assert.equal(first.values[0]?.length, 256);
    assert.ok(buffers[0]?.every((byte) => byte === 0));
    first.values[0] = 'mutated';
    const second = generate(request);
    assert.notEqual(second.values[0], 'mutated');
    buffers.length = 0;
    fails({ ...request, count: 2 }, 'attemptsExceeded');
    assert.equal(buffers.length, 2_048);
    assert.ok(buffers.every((buffer) => buffer.every((byte) => byte === 0)));
  });
});

test('JWT algorithms use their minimum random-byte sizes by default', () => {
  for (const [algorithm, bytes] of [['HS256', 32], ['HS384', 48], ['HS512', 64]] as const) {
    const result = generate({ kind: 'key', purpose: 'jwt', algorithm, count: 100 });
    distinct(result.values, 100);
    assert.equal(result.sensitive, true);
    assert.equal(result.metadata.bytes, bytes);
    assert.equal(result.metadata.algorithm, algorithm);
    assert.equal(result.metadata.encoding, 'base64url');
    for (const value of result.values) {
      assert.match(value, /^[A-Za-z0-9_-]+$/);
      assert.equal(Buffer.from(value, 'base64url').length, bytes);
    }
    fails({ kind: 'key', purpose: 'jwt', algorithm, bytes: bytes - 1 }, 'invalidKeySize');
  }
});

test('every key encoding round-trips the exact random-byte length', () => {
  for (const encoding of ['hex', 'base64', 'base64url'] as const) {
    for (const bytes of [16, 17, 32, 48, 64, 128]) {
      const result = generate({ kind: 'key', purpose: 'generic', bytes, encoding, count: 100 });
      distinct(result.values, 100);
      assert.equal(result.metadata.purpose, 'generic');
      assert.equal(result.metadata.algorithm, undefined);
      assert.equal(result.metadata.bytes, bytes);
      assert.equal(result.metadata.encoding, encoding);
      for (const value of result.values) {
        const decoded = Buffer.from(value, encoding);
        assert.equal(decoded.length, bytes);
        assert.ok(decoded.toString(encoding) === value);
        if (encoding === 'hex') assert.equal(value.length, bytes * 2);
        if (encoding === 'base64url') assert.ok(!/[+/=]/.test(value));
        if (encoding === 'base64') assert.match(value, /^[A-Za-z0-9+/]+={0,2}$/);
      }
    }
  }
});

test('key size, purpose, algorithm, and encoding reject malformed requests', () => {
  for (const bytes of [0, 15, 129, -1, 16.5, NaN, Infinity, '32', null]) {
    fails({ kind: 'key', purpose: 'generic', bytes }, 'invalidKeySize');
  }
  for (const algorithm of ['RS256', 'HS128', 'hs256', '', 256, null]) {
    fails({ kind: 'key', algorithm }, 'invalidAlgorithm');
  }
  for (const encoding of ['utf8', 'binary', 'HEX', '', 16, null]) {
    fails({ kind: 'key', encoding }, 'invalidEncoding');
  }
  for (const purpose of ['rsa', '', true, null]) {
    fails({ kind: 'key', purpose }, 'invalidRequest');
  }
});

test('port exclusions parse inclusive ranges, whitespace, and duplicate entries', () => {
  assert.deepEqual(parsePortExclusions(''), []);
  assert.deepEqual(parsePortExclusions(' \t\n '), []);
  assert.deepEqual(parsePortExclusions('3000,8080,9000-9002'), [3000, 8080, 9000, 9001, 9002]);
  assert.deepEqual(parsePortExclusions(' 2 - 4 , 1, 3, 4-4 '), [1, 2, 3, 4]);
  assert.deepEqual(parsePortExclusions('65535'), [65535]);
  assert.equal(parsePortExclusions('1-65535').length, 65535);
});

test('invalid exclusion syntax and forbidden port zero use invalidPortExclusions', () => {
  for (const exclusion of ['0', '65536', '1-65536', '0-10', '5-3', '-1', '1.5', '1e3', '0x50', 'foo', '1,,2', '1,', ',1', '1;2', '1 2', '1--2', '1-2-3', 'NaN', 'Infinity', '9007199254740993']) {
    assert.throws(() => parsePortExclusions(exclusion), errorCode('invalidPortExclusions'));
    fails({ kind: 'port', exclude: exclusion }, 'invalidPortExclusions');
  }
  fails({ kind: 'port', exclude: 8080 }, 'invalidPortExclusions');
});

test('ports sample without replacement and only from allowed candidates', () => {
  const result = generate({ kind: 'port', min: 9001, max: 9200, exclude: '9002,9010-9019,9100', excludeCommon: false, count: 100 });
  distinct(result.values, 100);
  assert.equal(result.sensitive, false);
  assert.equal(result.metadata.kind, 'port');
  assert.equal(result.metadata.candidateCount, 188);
  assert.equal(result.metadata.excludedCount, 12);
  const excluded = new Set(parsePortExclusions('9002,9010-9019,9100'));
  for (const value of result.values) {
    assert.match(value, /^\d+$/);
    const port = Number(value);
    assert.ok(port >= 9001 && port <= 9200 && !excluded.has(port));
  }
});

test('default port generation excludes the finite common-port list', () => {
  const result = generate({ kind: 'port', count: 100 });
  distinct(result.values, 100);
  assert.ok(Object.isFrozen(COMMON_PORTS));
  for (const value of result.values) {
    const port = Number(value);
    assert.ok(port >= 1024 && port <= 49151);
    assert.equal(COMMON_PORTS[port], undefined);
  }
  fails({ kind: 'port', min: 80, max: 80 }, 'insufficientSpace');
  assert.deepEqual(generate({ kind: 'port', min: 80, max: 80, excludeCommon: false }).values, ['80']);
});

test('port boundaries and exhausted ranges are handled before random sampling', () => {
  for (const value of [1, 65535]) {
    assert.deepEqual(generate({ kind: 'port', min: value, max: value, excludeCommon: false }).values, [String(value)]);
  }
  const all = generate({ kind: 'port', min: 65000, max: 65099, excludeCommon: false, count: 100 });
  distinct(all.values, 100);
  assert.deepEqual(new Set(all.values), new Set(Array.from({ length: 100 }, (_, index) => String(65000 + index))));
  fails({ kind: 'port', min: 10, max: 11, excludeCommon: false, count: 3 }, 'insufficientSpace');
  fails({ kind: 'port', min: 10, max: 11, excludeCommon: false, exclude: '10-11' }, 'insufficientSpace');
  for (const invalid of [0, -1, 65536, 1.5, NaN, Infinity, '1024', null]) {
    fails({ kind: 'port', min: invalid }, 'invalidPortRange');
    fails({ kind: 'port', max: invalid }, 'invalidPortRange');
  }
  fails({ kind: 'port', min: 10, max: 9 }, 'invalidPortRange');
});

test('out-of-range exclusions neither shrink the candidate space nor inflate metadata', () => {
  const result = generate({ kind: 'port', min: 65000, max: 65001, exclude: '1-1024,65535', excludeCommon: true, count: 2 });
  assert.deepEqual(new Set(result.values), new Set(['65000', '65001']));
  assert.equal(result.metadata.excludedCount, 0);
  assert.equal(result.metadata.candidateCount, 2);
});

test('malicious unknown inputs never escape the explicit request error boundary', () => {
  for (const value of [undefined, null, false, true, 0, 1, '', 'password', [], ['password'], new Date(), new Map(), new Set(), () => {}, {}, { kind: 'unknown' }, { kind: null }, { kind: {} }]) {
    fails(value, 'invalidRequest');
  }
  const inherited: unknown = Object.create({ kind: 'password' });
  fails(inherited, 'invalidRequest');
  const accessor = Object.defineProperty({}, 'kind', { get: () => { throw new Error('must not execute'); } });
  fails(accessor, 'invalidRequest');
  fails(new Proxy({}, { getPrototypeOf: () => { throw new Error('hostile proxy'); } }), 'invalidRequest');
  fails({ kind: 'password', [Symbol('unknown')]: true }, 'invalidRequest');
  const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { kind: 'port', min: 65535, max: 65535, excludeCommon: false });
  assert.deepEqual(generate(nullPrototype).values, ['65535']);
});

test('the generator does not mutate requests or retain batch result arrays', () => {
  const request = Object.freeze({ ...passwordRequest, count: 10 });
  const first = generate(request);
  const second = generate(request);
  distinct(first.values, 10);
  distinct(second.values, 10);
  assert.notEqual(first.values, second.values);
  first.values.length = 0;
  assert.equal(second.values.length, 10);
  assert.equal(request.count, 10);
});
