import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mock, test } from 'node:test';
import type * as vscode from 'vscode';
import {
  AGENT_TOOL_NAMES, registerAgentTools, type AgentToolName, type AgentToolsApi, type ToolUnavailable,
} from '../src/agent-tools.ts';
import type { GenerationResult } from '../src/generator.ts';

function token(cancelled = false): vscode.CancellationToken & { isCancellationRequested: boolean } {
  return { isCancellationRequested: cancelled, onCancellationRequested: () => ({ dispose() {} }) };
}

function setup(showSecret: (result: GenerationResult, kind: 'password' | 'key') => void | PromiseLike<void> = () => {}) {
  const tools = new Map<AgentToolName, vscode.breezell.Tool>();
  const disposed: string[] = [];
  const context: Pick<vscode.ExtensionContext, 'subscriptions'> = { subscriptions: [] };
  const account = { isSignedIn: true };
  const api: AgentToolsApi = {
    account,
    tools: {
      register(name, tool) {
        tools.set(name as AgentToolName, tool);
        return { dispose() { disposed.push(name); tools.delete(name as AgentToolName); } };
      },
    },
  };
  const status = registerAgentTools(context, api, showSecret);
  return { tools, context, account, disposed, status };
}

async function invoke(tools: Map<AgentToolName, vscode.breezell.Tool>, name: AgentToolName, input: Record<string, unknown>, cancellation = token()) {
  const tool = tools.get(name);
  assert.ok(tool);
  return await tool.invoke(input, cancellation);
}

function parsed(result: vscode.breezell.ToolResult): Record<string, any> {
  assert.equal(typeof result, 'string');
  return JSON.parse(result as string) as Record<string, any>;
}

test('all nine declared tools are registered with the real API shape and context disposal', () => {
  const { context, tools, disposed, status } = setup();
  assert.deepEqual(status.registered, [...AGENT_TOOL_NAMES]);
  assert.deepEqual(status.unavailable, []);
  assert.equal(tools.size, 9);
  assert.equal(context.subscriptions.length, 9);
  for (const disposable of context.subscriptions) disposable.dispose();
  assert.deepEqual(disposed, [...AGENT_TOOL_NAMES]);
  assert.equal(tools.size, 0);
});

test('password and key values are panel-only, including username mode', async () => {
  const shown: GenerationResult[] = [];
  const kinds: string[] = [];
  const { tools } = setup((result, kind) => { shown.push(result); kinds.push(kind); });
  for (const [name, input] of [
    ['rt_password', { count: 2, length: 12, prefix: 'SECRET_' }],
    ['rt_password', { username: true }],
    ['rt_key', { purpose: 'generic', bytes: 16, encoding: 'hex' }],
  ] as const) {
    const output = await invoke(tools, name, input);
    const data = parsed(output);
    assert.equal('values' in data, false);
    assert.equal('sensitive' in data, false);
    assert.equal(data.message, 'Generated locally; secret is shown in the plugin panel and is not returned to the model.');
    const latest = shown[shown.length - 1];
    assert.ok(latest.values.length > 0);
    for (const secret of latest.values) assert.equal((output as string).includes(secret), false);
    assert.equal((output as string).includes('SECRET_'), false);
  }
  assert.deepEqual(kinds, ['password', 'password', 'key']);
  assert.equal(shown[1].sensitive, false);
});

test('all seven public-result tools perform their actual local operation', async () => {
  const { tools } = setup(() => assert.fail('non-secret tool opened secret panel'));
  const samples: [AgentToolName, Record<string, unknown>][] = [
    ['rt_port', { count: 2, min: 61000, max: 61010 }],
    ['rt_uuid', { count: 2, format: 'compact', uppercase: true }],
    ['rt_hash', { input: 'hello' }],
    ['rt_timestamp', { input: '0', operation: 'toDate', unit: 'seconds' }],
    ['rt_base64', { input: 'hello', operation: 'encode', variant: 'base64', format: 'utf8' }],
    ['rt_url', { input: 'https://example.com/?a=1&a=2' }],
    ['rt_jwt', { input: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJkZW1vIn0.' }],
  ];
  const outputs = new Map<AgentToolName, Record<string, any>>();
  for (const [name, input] of samples) {
    const data = parsed(await invoke(tools, name, input));
    outputs.set(name, data);
    assert.equal(data.metadata.kind, name.slice(3));
    assert.ok(Array.isArray(data.values));
    assert.equal(typeof data.sensitive, 'boolean');
  }
  assert.equal(outputs.get('rt_port')?.values.length, 2);
  for (const value of outputs.get('rt_uuid')?.values ?? []) assert.match(value, /^[0-9A-F]{32}$/);
  assert.deepEqual(outputs.get('rt_hash')?.values, [createHash('sha256').update('hello').digest('hex')]);
  assert.equal(JSON.parse(outputs.get('rt_timestamp')?.values[0]).iso, '1970-01-01T00:00:00.000Z');
  assert.deepEqual(outputs.get('rt_base64')?.values, ['aGVsbG8=']);
  assert.deepEqual(JSON.parse(outputs.get('rt_url')?.values[0]).query, [{ key: 'a', value: '1' }, { key: 'a', value: '2' }]);
  assert.equal(JSON.parse(outputs.get('rt_jwt')?.values[0]).signatureVerified, false);
});

test('generation/input errors return only stable codes, with no input, stack, or exception escape', async () => {
  const { tools } = setup();
  for (const [name, input, code] of [
    ['rt_url', { input: 'SECRET_INVALID_URL' }, 'invalidUrl'],
    ['rt_jwt', { input: 'SECRET_TOKEN' }, 'invalidJwt'],
    ['rt_password', { length: 0, prefix: 'SECRET_PREFIX' }, 'invalidLength'],
    ['rt_key', { algorithm: 'SECRET_ALGORITHM' }, 'invalidAlgorithm'],
    ['rt_hash', { input: 'SECRET_INPUT', kind: 'password' }, 'invalidRequest'],
    ['rt_uuid', { input: 'SECRET_INPUT' }, 'invalidRequest'],
  ] as const) {
    assert.deepEqual(await invoke(tools, name, input), { text: code, isError: true });
  }
});

test('hostile objects and accessors are rejected without executing them', async () => {
  let called = 0;
  const { tools } = setup();
  const hostile = new Proxy({}, { ownKeys() { called += 1; throw new Error('SECRET'); } });
  const accessor = { get input() { called += 1; return 'SECRET'; } };
  for (const input of [hostile, accessor, { input: { toString() { called += 1; return 'SECRET'; } } }]) {
    const result = await invoke(tools, 'rt_hash', input);
    assert.equal(typeof result, 'object');
    assert.deepEqual(result, { text: input === hostile || input === accessor ? 'invalidRequest' : 'invalidText', isError: true });
  }
  assert.equal(called, 0);
});

test('cancellation before work skips generation and panel; after generation skips panel', async () => {
  let shown = 0;
  const { tools } = setup(() => { shown += 1; });
  assert.deepEqual(await invoke(tools, 'rt_password', {}, token(true)), { text: 'BreezellCancelled', isError: true });
  const crypto = createRequire(`${process.cwd()}/agent-tools.test.ts`)('node:crypto') as typeof import('node:crypto');
  const cancellation = token();
  const original = crypto.randomBytes;
  const stub = mock.method(crypto, 'randomBytes', (size: number) => {
    const value = original(size);
    cancellation.isCancellationRequested = true;
    return value;
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await invoke(tools, 'rt_key', {}, cancellation), { text: 'BreezellCancelled', isError: true });
  } finally {
    stub.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(shown, 0);
});

test('cancellation after awaited panel completion is a failed call without secret output', async () => {
  const cancellation = token();
  const { tools } = setup(async () => { cancellation.isCancellationRequested = true; });
  assert.deepEqual(await invoke(tools, 'rt_password', {}, cancellation), { text: 'BreezellCancelled', isError: true });
});

test('panel exceptions and crypto exceptions are sanitized, never stringified', async () => {
  const { tools } = setup(result => {
    throw new Error(`SECRET_PANEL_${result.values[0]}`);
  });
  assert.deepEqual(await invoke(tools, 'rt_key', {}), { text: 'secretDisplayFailed', isError: true });
  const crypto = createRequire(`${process.cwd()}/agent-tools.test.ts`)('node:crypto') as typeof import('node:crypto');
  const stub = mock.method(crypto, 'randomUUID', () => { throw new Error('SECRET_CRYPTO_INPUT'); });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await invoke(tools, 'rt_uuid', {}), { text: 'generationFailed', isError: true });
  } finally {
    stub.mock.restore();
    syncBuiltinESMExports();
  }
});

test('signed-out calls return a host code while ordinary UI and registrations remain usable', async () => {
  const { tools, account } = setup();
  account.isSignedIn = false;
  assert.deepEqual(await invoke(tools, 'rt_uuid', {}), { text: 'BreezellNotSignedIn', isError: true });
  account.isSignedIn = true;
  assert.equal(parsed(await invoke(tools, 'rt_uuid', {})).values.length, 1);
});

test('registration failure is isolated per tool and reports permission/host codes', () => {
  for (const reason of ['BreezellPermissionDenied', 'BreezellNotSignedIn', 'SECRET_HOST_ERROR']) {
    const reported: ToolUnavailable[] = [];
    const context: Pick<vscode.ExtensionContext, 'subscriptions'> = { subscriptions: [] };
    const api: AgentToolsApi = { tools: { register(name) {
      if (name !== 'rt_port') throw Object.assign(new Error('SECRET_MESSAGE'), { name: reason });
      return { dispose() {} };
    } } };
    const status = registerAgentTools(context, api, () => {}, value => { reported.push(value); throw new Error('SECRET_UI'); });
    assert.deepEqual(status.registered, ['rt_port']);
    assert.equal(context.subscriptions.length, 1);
    assert.equal(reported.length, 8);
    assert.ok(reported.every(value => value.code === (reason === 'SECRET_HOST_ERROR' ? 'toolRegistrationFailed' : reason)));
  }
  const status = registerAgentTools({ subscriptions: [] }, undefined, () => {});
  assert.equal(status.registered.length, 0);
  assert.ok(status.unavailable.every(value => value.code === 'BreezellNotSupported'));
});

interface Schema {
  type?: string;
  additionalProperties?: boolean;
  properties?: Record<string, Schema>;
  required?: string[];
  minimum?: number;
  maximum?: number;
  enum?: string[];
  default?: unknown;
  allOf?: Schema[];
}

const declarations = JSON.parse(readFileSync('agent-tools.json', 'utf8')) as {
  name: AgentToolName; displayName: string; description: string; modes: string[]; inputSchema: Schema;
}[];

test('manifest fragment declares exactly all nine tools with bounded own-only schemas', () => {
  assert.deepEqual(declarations.map(tool => tool.name), [...AGENT_TOOL_NAMES]);
  for (const declaration of declarations) {
    assert.match(declaration.name, /^[a-z0-9_]{2,48}$/);
    assert.ok(declaration.description.length > 0 && declaration.description.length <= 2000);
    assert.match(declaration.displayName, /^[\x20-\x7e]+$/);
    assert.deepEqual(declaration.modes, ['agent', 'chat', 'entanglement']);
    const schema = declaration.inputSchema;
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.equal('kind' in (schema.properties ?? {}), false);
    assert.ok(JSON.stringify(schema).length < 16000);
    if (['rt_hash', 'rt_timestamp', 'rt_base64', 'rt_url', 'rt_jwt'].includes(declaration.name)) {
      assert.ok(schema.required?.includes('input'));
    }
    const count = schema.properties?.count;
    if (count) assert.deepEqual(count, { type: 'integer', minimum: 1, maximum: 100, default: 1 });
  }
  assert.equal(declarations[0].inputSchema.properties?.length?.maximum, 128);
  assert.equal(declarations[1].inputSchema.properties?.bytes?.maximum, 128);
  assert.equal(declarations[1].inputSchema.allOf?.length, 3);
  assert.equal(declarations[2].inputSchema.properties?.max?.maximum, 65535);
  assert.deepEqual(declarations[5].inputSchema.required, ['input', 'operation', 'unit']);
  assert.deepEqual(declarations[6].inputSchema.required, ['input', 'operation', 'variant', 'format']);
});
