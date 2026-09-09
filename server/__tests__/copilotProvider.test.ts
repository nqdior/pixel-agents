import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_SCALAR_LENGTH,
  PREVIEW_CHAR_LIMIT,
  READ_CHUNK_BYTES,
  RECENT_TOOL_LIMIT,
} from '../src/providers/file/copilot/constants.js';
import { CopilotProvider } from '../src/providers/file/copilot/copilot.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

const OLD_TIMESTAMP = '2026-01-01T00:00:00.000Z';
const NEW_TIMESTAMP = '2026-01-01T00:00:01.000Z';
type TestEvent = {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
  agentId?: string;
};

function event(
  type: string,
  data: Record<string, unknown> = {},
  timestamp = OLD_TIMESTAMP,
): TestEvent {
  return { type, timestamp, data };
}

function line(record: TestEvent): string {
  return `${JSON.stringify(record)}\n`;
}

describe('CopilotProvider', () => {
  let root: string;
  let provider: CopilotProvider;
  let alive: Set<number>;

  beforeEach(async () => {
    root = path.resolve(`.copilot-provider-fixtures-${randomUUID()}`);
    await fs.mkdir(root);
    alive = new Set([101, 202]);
    provider = new CopilotProvider({ sessionRoot: root, isProcessAlive: (pid) => alive.has(pid) });
  });

  afterEach(async () => {
    provider.dispose();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function session(
    id: string,
    cwd = 'C:\\work\\first',
    records = [event('session.start')],
    pid: number | null = 101,
  ): Promise<string> {
    const directory = path.join(root, id);
    await fs.mkdir(directory);
    await fs.writeFile(
      path.join(directory, 'workspace.yaml'),
      `id: ${id}\ncwd: ${JSON.stringify(cwd)}\nname: "Local agent"\n`,
    );
    if (pid !== null) await fs.writeFile(path.join(directory, `inuse.${pid}.lock`), `${pid}\n`);
    const transcript = path.join(directory, 'events.jsonl');
    await fs.writeFile(transcript, records.map(line).join(''));
    return transcript;
  }

  async function append(id: string, ...records: TestEvent[]): Promise<void> {
    await fs.appendFile(path.join(root, id, 'events.jsonl'), records.map(line).join(''));
  }

  it('exports the read-only identity and discovers all projects including hours-idle live sessions', async () => {
    const first = await session('first');
    await session(
      'second',
      'D:\\another\\project',
      [event('session.start'), event('user.message')],
      202,
    );
    await fs.utimes(first, new Date(OLD_TIMESTAMP), new Date(OLD_TIMESTAMP));
    expect(provider.id).toBe('copilot');
    expect(provider.displayName).toBe('GitHub Copilot');
    expect(await provider.scan()).toEqual([
      expect.objectContaining({
        sessionId: 'first',
        cwd: 'C:\\work\\first',
        title: 'Local agent',
        status: 'done',
      }),
      expect.objectContaining({
        sessionId: 'second',
        cwd: 'D:\\another\\project',
        status: 'active',
      }),
    ]);
    expect('installHooks' in provider).toBe(false);
  });

  it('discovers the default session root with both home variables isolated on Windows', async () => {
    await session('first');
    const defaultRoot = path.join(root, '.copilot', 'session-state');
    await fs.mkdir(defaultRoot, { recursive: true });
    await fs.rename(path.join(root, 'first'), path.join(defaultRoot, 'first'));
    vi.stubEnv('HOME', root);
    vi.stubEnv('USERPROFILE', root);
    provider.dispose();
    provider = new CopilotProvider({ isProcessAlive: (pid) => alive.has(pid) });
    expect((await provider.scan()).map((snapshot) => snapshot.sessionId)).toEqual(['first']);
  });

  it('excludes historical sessions, stale/mismatched/empty locks, and not-yet-ready directories', async () => {
    await session('historical', undefined, undefined, null);
    await session('dead', undefined, undefined, 303);
    await session('mismatch');
    await fs.writeFile(path.join(root, 'mismatch', 'inuse.101.lock'), '202\n');
    await session('empty-lock');
    await fs.writeFile(path.join(root, 'empty-lock', 'inuse.101.lock'), '');
    await session('empty-events', undefined, []);
    await fs.mkdir(path.join(root, 'partial-directory'));
    await session('partial-metadata');
    await fs.writeFile(
      path.join(root, 'partial-metadata', 'workspace.yaml'),
      'id: partial-metadata\ncwd: "C:\\',
    );
    await session('valid');
    expect((await provider.scan()).map((s) => s.sessionId)).toEqual(['valid']);
  });

  it('removes agents when the lock disappears or its process exits, not when activity stops', async () => {
    await session('first');
    await session('second', undefined, undefined, 202);
    expect(await provider.scan()).toHaveLength(2);
    await fs.unlink(path.join(root, 'first', 'inuse.101.lock'));
    alive.delete(202);
    expect(await provider.scan()).toEqual([]);
    await fs.writeFile(path.join(root, 'first', 'inuse.101.lock'), '101\n');
    expect((await provider.scan()).map((s) => s.sessionId)).toEqual(['first']);
  });

  it('accepts another live lock when a stale lock is also present', async () => {
    await session('first', undefined, undefined, 303);
    await fs.writeFile(path.join(root, 'first', 'inuse.202.lock'), '202\n');
    expect(await provider.scan()).toHaveLength(1);
  });

  it('ignores invalid process IDs rather than probing an out-of-range PID', async () => {
    await session('first', undefined, undefined, null);
    await fs.writeFile(path.join(root, 'first', 'inuse.999999999999.lock'), '999999999999\n');
    const isProcessAlive = vi.fn(() => {
      throw new Error('must not probe');
    });
    provider.dispose();
    provider = new CopilotProvider({ sessionRoot: root, isProcessAlive });
    expect(await provider.scan()).toEqual([]);
    expect(isProcessAlive).not.toHaveBeenCalled();
  });

  it('marks prompt-only turns active and preserves that state across telemetry and tool loops', async () => {
    await session('first', undefined, [
      event('session.start'),
      event('user.message', { content: 'not displayed' }),
    ]);
    expect((await provider.scan())[0].status).toBe('active');
    await append(
      'first',
      event('assistant.turn_start', { turnId: 'one' }),
      event('assistant.message', { toolRequests: [{ toolCallId: 'tool' }] }),
      event('tool.execution_start', {
        toolCallId: 'tool',
        toolName: 'functions.view',
        arguments: { path: 'secret' },
      }),
    );
    expect((await provider.scan())[0].tools).toEqual([
      {
        id: 'tool',
        name: 'view',
        status: 'Reading: secret',
        isReading: true,
        details: 'File: secret',
      },
    ]);
    await append(
      'first',
      event('tool.execution_complete', { toolCallId: 'tool', success: true }),
      event('assistant.turn_end', { turnId: 'one' }),
      event('session.usage_checkpoint'),
      event('model.response', { content: 'not displayed' }),
    );
    const snapshot = (await provider.scan())[0];
    expect(snapshot.status).toBe('active');
    expect(snapshot.tools).toEqual([]);
    expect(snapshot.recentTools?.[0].details).toBe('File: secret');
    expect(snapshot.latestResponse).toBeUndefined();
    await append('first', event('assistant.turn_start', { turnId: 'two' }));
    expect((await provider.scan())[0].status).toBe('active');
  });

  it('detects an older final response only after its own turn ends, and ignores subsequent telemetry', async () => {
    await session('first', undefined, [event('user.message')]);
    await append(
      'first',
      event('assistant.message', { content: 'Final response', toolRequests: [], turnId: 'final' }),
    );
    expect((await provider.scan())[0].status).toBe('active');
    await append('first', event('assistant.turn_end', { turnId: 'different' }));
    expect((await provider.scan())[0].status).toBe('active');
    await append('first', event('assistant.turn_end', { turnId: 'final' }, NEW_TIMESTAMP));
    expect((await provider.scan())[0].status).toBe('done');
    await append(
      'first',
      event('session.usage_checkpoint'),
      event('model.telemetry', {}, '2026-02-01T00:00:00Z'),
    );
    expect((await provider.scan())[0]).toMatchObject({
      status: 'done',
      lastActivityAt: Date.parse(NEW_TIMESTAMP),
    });
  });

  it('handles explicit final phases, including encrypted empty final text', async () => {
    await session('first', undefined, [event('user.message')]);
    await append(
      'first',
      event('assistant.message', { phase: 'final_answer', content: '', toolRequests: [] }),
    );
    expect((await provider.scan())[0].status).toBe('done');
  });

  it('supports a final message followed by a usage checkpoint without another assistant turn-end', async () => {
    await session('first', undefined, [event('user.message')]);
    await append(
      'first',
      event('tool.execution_start', { toolCallId: 'read-one', toolName: 'view' }),
      event('tool.execution_complete', { toolCallId: 'read-one', success: true }),
      event('assistant.turn_end'),
    );
    expect((await provider.scan())[0].status).toBe('active');
    await append(
      'first',
      event('assistant.message', { content: 'Finished.', toolRequests: [] }),
      event('session.usage_checkpoint'),
    );
    expect((await provider.scan())[0].status).toBe('done');
  });

  it('does not treat empty reasoning messages or commentary as final responses', async () => {
    await session('first', undefined, [event('user.message')]);
    await append(
      'first',
      event('assistant.message', { content: '', toolRequests: [], turnId: 'one' }),
      event('assistant.turn_end', { turnId: 'one' }),
      event('session.usage_checkpoint'),
    );
    expect((await provider.scan())[0].status).toBe('active');
    await append(
      'first',
      event('assistant.message', {
        phase: 'commentary',
        content: 'Working',
        toolRequests: [],
        turnId: 'two',
      }),
      event('assistant.turn_end', { turnId: 'two' }),
    );
    expect((await provider.scan())[0].status).toBe('active');
  });

  it('never lets a nested subagent final finish its parent session', async () => {
    await session('first', undefined, [event('user.message')]);
    await append(
      'first',
      event('assistant.message', {
        phase: 'final_answer',
        content: 'Nested result',
        toolRequests: [],
        parentToolCallId: 'task',
        turnId: 'sub',
      }),
      event('assistant.turn_end', { turnId: 'sub' }),
      event('session.usage_checkpoint'),
    );
    expect((await provider.scan())[0].status).toBe('active');
  });

  it('preserves parallel tool IDs when completions arrive out of order', async () => {
    await session('first', undefined, [event('user.message')]);
    await append(
      'first',
      event('tool.execution_start', { toolCallId: 'a', toolName: 'functions.view' }),
      event('tool.execution_start', { toolCallId: 'b', toolName: 'functions.powershell' }),
      event('tool.execution_start', { toolCallId: 'c', toolName: 'functions.rg' }),
    );
    expect((await provider.scan())[0].tools.map((tool) => tool.id)).toEqual(['a', 'b', 'c']);
    await append('first', event('tool.execution_complete', { toolCallId: 'b', success: false }));
    expect((await provider.scan())[0].tools.map((tool) => tool.id)).toEqual(['a', 'c']);
    await append(
      'first',
      event('tool.execution_complete', { toolCallId: 'c' }),
      event('tool.execution_complete', { toolCallId: 'a' }),
    );
    expect((await provider.scan())[0]).toMatchObject({ status: 'active', tools: [] });
  });

  it('recognizes namespaced read-like tools and describes their target files', async () => {
    await session('first', undefined, [
      event('tool.execution_start', {
        toolCallId: 'a',
        toolName: 'mcp__github__get_file_contents',
        arguments: { path: 'private' },
      }),
      event('tool.execution_start', { toolCallId: 'b', toolName: 'functions.web_fetch' }),
    ]);
    expect((await provider.scan())[0].tools).toEqual([
      {
        id: 'a',
        name: 'get_file_contents',
        status: 'Reading: private',
        isReading: true,
        details: 'File: private',
      },
      { id: 'b', name: 'web_fetch', status: 'Reading', isReading: true },
    ]);
  });

  it('tracks named background workers independently, routes nested tools, and removes completed workers', async () => {
    await session('first', undefined, [
      event('tool.execution_start', {
        toolCallId: 'spawn',
        toolName: 'task',
        arguments: {
          name: 'reviewer',
          description: 'Review the change',
          mode: 'background',
          prompt: 'Review login',
        },
      }),
      event('tool.execution_complete', {
        toolCallId: 'spawn',
        success: true,
        result: {
          content:
            'Agent started in background with agent_id: 11111111-1111-1111-1111-111111111111.',
        },
      }),
      event('assistant.message', {
        phase: 'final_answer',
        content: 'Delegated.',
        model: 'main-model',
      }),
      {
        ...event('subagent.started', { toolCallId: 'spawn', agentDisplayName: 'reviewer' }),
        agentId: '11111111-1111-1111-1111-111111111111',
      },
      {
        ...event('tool.execution_start', {
          toolCallId: 'read',
          toolName: 'view',
          arguments: { path: 'login.ts' },
          parentToolCallId: 'spawn',
        }),
        agentId: '11111111-1111-1111-1111-111111111111',
      },
    ]);
    const parent = (await provider.scan())[0];
    expect(parent.status).toBe('done');
    expect(parent.tools).toEqual([]);
    expect(parent.children).toHaveLength(1);
    expect(parent.children?.[0]).toMatchObject({
      id: 'spawn',
      name: 'reviewer',
      status: 'active',
      tools: [{ id: 'read', status: 'Reading: login.ts' }],
    });
    await append(
      'first',
      {
        ...event('subagent.completed', { toolCallId: 'spawn' }),
        agentId: '11111111-1111-1111-1111-111111111111',
      },
      { ...event('assistant.turn_end'), agentId: '11111111-1111-1111-1111-111111111111' },
    );
    expect((await provider.scan())[0].children).toEqual([]);
  });

  it('separates unnamed synchronous helpers and nested worker tools from the parent', async () => {
    await session('first', undefined, [
      event('tool.execution_start', {
        toolCallId: 'outer',
        toolName: 'task',
        arguments: { description: 'Explore', mode: 'sync' },
      }),
      { ...event('subagent.started', { toolCallId: 'outer' }), agentId: 'outer-agent' },
      {
        ...event('tool.execution_start', {
          toolCallId: 'nested',
          toolName: 'task',
          arguments: { description: 'Nested review', name: 'nested-reviewer' },
        }),
        agentId: 'outer-agent',
      },
      { ...event('subagent.started', { toolCallId: 'nested' }), agentId: 'nested-agent' },
      {
        ...event('tool.execution_start', {
          toolCallId: 'nested-read',
          toolName: 'view',
          arguments: { path: 'nested.ts' },
        }),
        agentId: 'nested-agent',
      },
    ]);
    const result = (await provider.scan())[0];
    expect(result.children?.[0].name).toBeUndefined();
    expect(result.children?.[0].children?.[0]).toMatchObject({
      name: 'nested-reviewer',
      tools: [{ id: 'nested-read', status: 'Reading: nested.ts' }],
    });
    await append('first', event('tool.execution_complete', { toolCallId: 'outer', success: true }));
    expect((await provider.scan())[0].children).toEqual([]);
  });

  it('uses reported context occupancy and window, never cumulative token spend', async () => {
    await session('first', undefined, [
      event('session.usage_checkpoint', { totalTokens: 9000000 }),
      event('session.usage_info', { currentTokens: 100000, tokenLimit: 400000 }),
    ]);
    expect((await provider.scan())[0].context).toMatchObject({
      usedTokens: 100000,
      maxTokens: 400000,
    });
    await append(
      'first',
      event('session.usage_info', { currentTokens: 20000, tokenLimit: 400000 }),
    );
    expect((await provider.scan())[0].context?.usedTokens).toBe(20000);
    await append('first', event('session.model_change', { newModel: 'unreported-model' }));
    expect((await provider.scan())[0].context).toBeUndefined();
  });

  it('uses only matching main-model metrics and counts cached prompt tokens once', async () => {
    await session('first', undefined, [
      event('model.turn_started', {
        model: 'main',
        modelInfo: { capabilities: { limits: { max_context_window_tokens: 400000 } } },
      }),
      event('model.model_call_success', {
        modelCall: { model: 'main' },
        responseUsage: {
          prompt_tokens: 120000,
          completion_tokens: 2000,
          prompt_tokens_details: { cached_tokens: 100000 },
        },
      }),
      event('assistant.message', { model: 'main', content: 'Working', phase: 'commentary' }),
      event('model.turn_started', {
        model: 'helper',
        modelInfo: { capabilities: { limits: { max_context_window_tokens: 1000000 } } },
      }),
      event('model.model_call_success', {
        modelCall: { model: 'helper' },
        responseUsage: { prompt_tokens: 500, completion_tokens: 10 },
      }),
    ]);
    expect((await provider.scan())[0].context).toEqual({
      usedTokens: 122000,
      maxTokens: 400000,
      model: 'main',
    });
    await append('first', event('session.compaction_complete'));
    expect((await provider.scan())[0].context).toBeUndefined();
  });

  it('shows command descriptions, search scope and patch targets instead of generic labels', async () => {
    await session('first', undefined, [
      event('user.message', { content: 'Fix the login form' }),
      event('assistant.message', { content: 'I am checking its validation.', phase: 'commentary' }),
      event('tool.execution_start', {
        toolCallId: 'command',
        toolName: 'powershell',
        arguments: { command: 'npm run test -- login', description: 'Exercise login validation' },
      }),
      event('tool.execution_start', {
        toolCallId: 'search',
        toolName: 'rg',
        arguments: { paths: ['C:\\work\\app\\src', 'C:\\work\\app\\test'], pattern: 'onSubmit' },
      }),
      event('tool.execution_start', {
        toolCallId: 'patch',
        toolName: 'apply_patch',
        arguments:
          '*** Begin Patch\n*** Update File: C:\\work\\app\\login.ts\n@@\n-old\n+new\n*** End Patch',
      }),
    ]);
    const snapshot = (await provider.scan())[0];
    expect(snapshot.latestRequest?.content).toBe('Fix the login form');
    expect(snapshot.latestResponse?.content).toBe('I am checking its validation.');
    expect(snapshot.tools[0]).toMatchObject({
      status: 'Running command: Exercise login validation',
      details: 'Exercise login validation\nCommand:\nnpm run test -- login',
    });
    expect(snapshot.tools[1].details).toContain('C:\\work\\app\\src, C:\\work\\app\\test');
    expect(snapshot.tools[1].details).toContain('Query: onSubmit');
    expect(snapshot.tools[2]).toMatchObject({
      status: 'Editing: login.ts',
      details: 'File: C:\\work\\app\\login.ts',
    });
    await append(
      'first',
      event('assistant.message', { content: 'Nested response', parentToolCallId: 'task' }),
      event('model.response', { content: 'Internal model output' }),
      event('tool.execution_complete', {
        toolCallId: 'command',
        success: false,
        result: { content: 'Not displayed' },
      }),
    );
    const next = (await provider.scan())[0];
    expect(next.latestResponse?.content).toBe('I am checking its validation.');
    expect(next.recentTools?.[0]).toMatchObject({ id: 'command', outcome: 'error' });
    expect(JSON.stringify(next)).not.toContain('Not displayed');
  });

  it('keeps bounded Unicode previews valid across escaped-string and chunk boundaries', async () => {
    const content = '日本語 "quote" \\\\ line\n 😀'.repeat(MAX_SCALAR_LENGTH);
    const transcript = await session('first', undefined, []);
    const encoded = line(event('user.message', { content }));
    const cut = encoded.indexOf('\\n') + 1;
    await fs.appendFile(transcript, encoded.slice(0, cut));
    expect(await provider.scan()).toEqual([]);
    await fs.appendFile(transcript, encoded.slice(cut));
    const result = (await provider.scan())[0].latestRequest;
    expect(result).toMatchObject({ truncated: true });
    expect(result?.content).toBe(
      content
        .slice(0, PREVIEW_CHAR_LIMIT)
        .replace(/[\uD800-\uDBFF]$/, '')
        .trim(),
    );
    await append(
      'first',
      event('assistant.message', { content: 'Short answer', phase: 'final_answer' }),
    );
    expect((await provider.scan())[0].latestResponse).toMatchObject({
      content: 'Short answer',
      truncated: false,
    });
  });

  it('retains only the most recent completed actions', async () => {
    await session('first');
    for (let i = 0; i < RECENT_TOOL_LIMIT + 2; i++) {
      await append(
        'first',
        event('tool.execution_start', {
          toolCallId: String(i),
          toolName: 'view',
          arguments: { path: `file-${i}.ts` },
        }),
        event('tool.execution_complete', { toolCallId: String(i), success: true }),
      );
    }
    const actions = (await provider.scan())[0].recentTools;
    expect(actions).toHaveLength(RECENT_TOOL_LIMIT);
    expect(actions?.[0].id).toBe(String(RECENT_TOOL_LIMIT + 1));
  });

  it('keeps ask_user in input until completion even across idle markers and a user reply', async () => {
    await session('first', undefined, [
      event('user.message'),
      event('tool.execution_start', { toolCallId: 'question', toolName: 'functions.ask_user' }),
    ]);
    expect((await provider.scan())[0].status).toBe('input');
    await append(
      'first',
      event('session.idle'),
      event('user.message'),
      event('assistant.turn_end'),
      event('session.usage_checkpoint'),
    );
    expect((await provider.scan())[0].status).toBe('input');
    await append('first', event('tool.execution_complete', { toolCallId: 'question' }));
    expect((await provider.scan())[0]).toMatchObject({ status: 'active', tools: [] });
  });

  it('uses explicit permission events, handles parallel approvals, and never infers them from elapsed time', async () => {
    await session('first', undefined, [
      event('user.message'),
      event('tool.execution_start', { toolCallId: 'long', toolName: 'powershell' }),
    ]);
    expect((await provider.scan())[0].status).toBe('active');
    await append(
      'first',
      event('permission.requested', {
        requestId: 'p1',
        permissionRequest: { toolCallId: 'long', kind: 'shell' },
      }),
      event('permission.requested', {
        requestId: 'p2',
        permissionRequest: { toolCallId: 'other' },
      }),
    );
    expect((await provider.scan())[0].status).toBe('permission');
    await append(
      'first',
      event('permission.completed', { requestId: 'p2', result: { kind: 'approved' } }),
    );
    expect((await provider.scan())[0].status).toBe('permission');
    await append('first', event('permission.completed', { requestId: 'p1' }));
    expect((await provider.scan())[0].status).toBe('active');
  });

  it('does not mistake permission configuration changes for an approval request', async () => {
    await session('first', undefined, [
      event('user.message'),
      event('session.permissions_changed', { allowAllPermissions: false }),
    ]);
    expect((await provider.scan())[0].status).toBe('active');
  });

  it('clears running tools on abort and handles an explicit idle event', async () => {
    await session('first', undefined, [
      event('tool.execution_start', { toolCallId: 'a', toolName: 'view' }),
    ]);
    expect((await provider.scan())[0].tools).toHaveLength(1);
    await append('first', event('abort'));
    const snapshot = (await provider.scan())[0];
    expect(snapshot).toMatchObject({ status: 'done', tools: [] });
    await append('first', event('user.message'), event('session.idle'));
    expect((await provider.scan())[0].status).toBe('done');
  });

  it('buffers partial JSON and split UTF-8 bytes without publishing unfinished tool records', async () => {
    const transcript = await session('first', undefined, [event('user.message')]);
    const bytes = Buffer.from(
      line(event('tool.execution_start', { toolCallId: '日本語', toolName: 'view' })),
    );
    const split = bytes.indexOf(Buffer.from('日')) + 1;
    await fs.appendFile(transcript, bytes.subarray(0, split));
    expect((await provider.scan())[0].tools).toEqual([]);
    await fs.appendFile(transcript, bytes.subarray(split, bytes.length - 1));
    expect((await provider.scan())[0].tools).toEqual([]);
    await fs.appendFile(transcript, bytes.subarray(bytes.length - 1));
    expect((await provider.scan())[0].tools[0].id).toBe('日本語');
  });

  it('rebuilds after truncation, clearing incomplete UTF-8 and old tool state', async () => {
    const transcript = await session('first', undefined, [
      event('session.start'),
      event('user.message'),
      event('tool.execution_start', { toolCallId: 'old', toolName: 'view' }),
    ]);
    await fs.appendFile(transcript, Buffer.from('{"type":"日').subarray(0, -1));
    expect((await provider.scan())[0].tools).toHaveLength(1);
    await fs.writeFile(transcript, line(event('session.start')));
    expect((await provider.scan())[0]).toMatchObject({ status: 'done', tools: [] });
    await append('first', event('user.message'));
    expect((await provider.scan())[0].status).toBe('active');
  });

  it('rebuilds when a replacement file is larger than the old transcript', async () => {
    const transcript = await session('first', undefined, [event('user.message')]);
    expect((await provider.scan())[0].status).toBe('active');
    const replacement = path.join(root, 'replacement.jsonl');
    await fs.writeFile(replacement, line(event('session.start', { padding: 'x'.repeat(500) })));
    await fs.unlink(transcript);
    await fs.rename(replacement, transcript);
    expect((await provider.scan())[0].status).toBe('done');
  });

  it('detects same-size in-place rewrites and truncate-then-regrow between scans', async () => {
    const transcript = await session('first', undefined, [event('user.message')]);
    expect((await provider.scan())[0].status).toBe('active');
    const originalSize = (await fs.stat(transcript)).size;
    const replacement = line(event('abort'));
    await fs.writeFile(transcript, replacement.trimEnd().padEnd(originalSize - 1, ' ') + '\n');
    expect((await provider.scan())[0].status).toBe('done');
    await fs.writeFile(transcript, line(event('user.message', { ignored: 'x'.repeat(500) })));
    expect((await provider.scan())[0].status).toBe('active');
  });

  it('logs malformed completed records once per file without logging their bodies', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const transcript = await session('first', undefined, [event('user.message')]);
    await fs.appendFile(transcript, '{"private":"DO_NOT_LOG",}\n{not json}\n');
    expect((await provider.scan())[0].status).toBe('active');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('[CopilotProvider]');
    expect(String(warn.mock.calls[0][0])).not.toContain('DO_NOT_LOG');
    await fs.appendFile(transcript, '{');
    await provider.scan();
    expect(warn).toHaveBeenCalledTimes(1);
    await fs.appendFile(transcript, '\n');
    await append('first', event('abort'));
    expect((await provider.scan())[0].status).toBe('done');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('streams huge telemetry, prompts, and results with bounded state and only reads append deltas', async () => {
    const secret = 'PRIVATE_CONTENT_';
    const body = secret.repeat(READ_CHUNK_BYTES);
    const transcript = await session('first', undefined, [
      event('user.message', { content: body }),
      event('model.messages_snapshot', { messages: [{ content: body }] }),
      event('model.response', { content: body }),
      event('tool.execution_start', {
        toolCallId: 'a',
        toolName: 'view',
        arguments: { content: body },
      }),
      event('tool.execution_complete', { toolCallId: 'a', result: { content: body } }),
      event('assistant.message', { content: body, phase: 'final_answer', toolRequests: [] }),
    ]);
    const snapshot = (await provider.scan())[0];
    expect(snapshot).toMatchObject({ status: 'done', tools: [] });
    expect(snapshot.latestRequest?.content.length).toBeLessThanOrEqual(PREVIEW_CHAR_LIMIT);
    expect(snapshot.latestResponse?.truncated).toBe(true);
    expect(JSON.stringify(provider)).not.toContain(secret);
    const reader = await fs.open(transcript, 'r');
    const prototype = Object.getPrototypeOf(reader) as { read: FileHandleRead };
    type FileHandleRead = typeof reader.read;
    await reader.close();
    const read = vi.spyOn(prototype, 'read');
    await provider.scan();
    const requestedBytes = read.mock.calls.reduce(
      (sum, args: unknown[]) => sum + (typeof args[2] === 'number' ? args[2] : 0),
      0,
    );
    expect(requestedBytes).toBeLessThan(READ_CHUNK_BYTES);
    await append('first', event('user.message'));
    expect((await provider.scan())[0].status).toBe('active');
  });

  it('parses plain Windows paths, JSON quotes, YAML single quotes, and refreshed names', async () => {
    await session('first');
    const workspace = path.join(root, 'first', 'workspace.yaml');
    await fs.writeFile(
      workspace,
      "id: first\ncwd: C:\\work\\日本語\nname: 'Agent''s desk # one'\n",
    );
    expect((await provider.scan())[0]).toMatchObject({
      cwd: 'C:\\work\\日本語',
      title: "Agent's desk # one",
    });
    await fs.writeFile(
      workspace,
      `id: first\ncwd: ${JSON.stringify('D:\\two')}\nname: "Renamed" # comment\n`,
    );
    expect((await provider.scan())[0]).toMatchObject({ cwd: 'D:\\two', title: 'Renamed' });
  });

  it('treats a missing root as normal and disposes idempotently', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await fs.rm(root, { recursive: true });
    expect(await provider.scan()).toEqual([]);
    expect(error).not.toHaveBeenCalled();
    provider.dispose();
    provider.dispose();
    expect(await provider.scan()).toEqual([]);
  });

  it('propagates non-ENOENT filesystem errors with a useful prefix and keeps cached live sessions', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await session('first', undefined, [event('user.message')]);
    expect(await provider.scan()).toHaveLength(1);
    const readdir = vi
      .spyOn(fs, 'readdir')
      .mockRejectedValueOnce(Object.assign(new Error('access denied'), { code: 'EACCES' }));
    await expect(provider.scan()).rejects.toThrow(
      '[CopilotProvider] Cannot scan local sessions: access denied',
    );
    expect(error).toHaveBeenCalledTimes(1);
    readdir.mockRestore();
    expect((await provider.scan())[0].status).toBe('active');
  });

  it('propagates per-session filesystem failures instead of returning an incomplete list', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await session('first');
    await session('second');
    expect(await provider.scan()).toHaveLength(2);
    const readFile = fs.readFile;
    vi.spyOn(fs, 'readFile').mockImplementation(((
      file: Parameters<typeof fs.readFile>[0],
      options: unknown,
    ) => {
      if (String(file) === path.join(root, 'second', 'workspace.yaml')) {
        return Promise.reject(Object.assign(new Error('workspace denied'), { code: 'EACCES' }));
      }
      return readFile(file, options as Parameters<typeof fs.readFile>[1]);
    }) as typeof fs.readFile);
    await expect(provider.scan()).rejects.toThrow('workspace denied');
    expect(error).toHaveBeenCalledOnce();
  });

  it('shares concurrent scans and returns immutable-by-copy tool snapshots', async () => {
    await session('first', undefined, [
      event('tool.execution_start', { toolCallId: 'a', toolName: 'view' }),
    ]);
    const first = provider.scan();
    expect(provider.scan()).toBe(first);
    const snapshots = await first;
    snapshots[0].tools[0].name = 'mutated';
    expect((await provider.scan())[0].tools[0].name).toBe('view');
  });

  it('treats process EPERM as alive and ESRCH as dead, surfacing other errors', async () => {
    await session('first');
    provider.dispose();
    provider = new CopilotProvider({ sessionRoot: root });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('not allowed'), { code: 'EPERM' });
    });
    expect(await provider.scan()).toHaveLength(1);
    kill.mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    expect(await provider.scan()).toEqual([]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    kill.mockImplementation(() => {
      throw Object.assign(new Error('unexpected'), { code: 'EIO' });
    });
    await expect(provider.scan()).rejects.toThrow('unexpected');
    expect(error).toHaveBeenCalledOnce();
  });
});
