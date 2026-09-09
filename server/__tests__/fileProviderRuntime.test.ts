import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FileSessionProvider, FileSessionSnapshot } from '../../core/src/fileProvider.js';
import { resendAgentActivity } from '../src/agentActivityResend.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import { DismissalTracker } from '../src/dismissalTracker.js';
import { FileProviderRuntime } from '../src/fileProviderRuntime.js';
import { claudeProvider } from '../src/providers/index.js';

const workspace = path.resolve('workspace-a');
const otherWorkspace = path.resolve('workspace-b');

function snapshot(
  sessionId: string,
  overrides: Partial<FileSessionSnapshot> = {},
): FileSessionSnapshot {
  return {
    sessionId,
    transcriptPath: path.join(workspace, sessionId, 'events.jsonl'),
    cwd: workspace,
    title: sessionId,
    status: 'active',
    tools: [],
    lastActivityAt: 100,
    ...overrides,
  };
}

describe('FileProviderRuntime', () => {
  const monitors: FileProviderRuntime[] = [];
  afterEach(() => {
    for (const monitor of monitors) monitor.dispose();
    monitors.length = 0;
    vi.restoreAllMocks();
  });

  function fixture() {
    const store = new AgentStateStore();
    const sessions: FileSessionSnapshot[] = [];
    const provider: FileSessionProvider = {
      id: 'copilot',
      displayName: 'GitHub Copilot',
      scan: vi.fn(async () => sessions),
      dispose: vi.fn(),
    };
    const messages: Record<string, unknown>[] = [];
    store.on('broadcast', (message) => messages.push(message));
    const watchAllSessions = { current: true };
    const dismissals = new DismissalTracker();
    const capabilitiesChanged = vi.fn();
    const monitor = new FileProviderRuntime({
      store,
      provider,
      workspacePaths: [workspace],
      watchAllSessions,
      dismissals,
      removeAgent: (id) => {
        store.delete(id);
      },
      onReadingToolsChanged: capabilitiesChanged,
    });
    monitors.push(monitor);
    return {
      store,
      sessions,
      provider,
      messages,
      watchAllSessions,
      dismissals,
      monitor,
      capabilitiesChanged,
    };
  }

  it('adopts all live projects, filters dynamically, and removes closed sessions', async () => {
    const f = fixture();
    f.sessions.push(snapshot('first'), snapshot('second', { cwd: otherWorkspace }));
    await f.monitor.scan();
    expect(f.store.size).toBe(2);
    expect([...f.store.values()].map((agent) => agent.sessionId)).toEqual(['first', 'second']);
    f.watchAllSessions.current = false;
    await f.monitor.scan();
    expect(f.store.size).toBe(1);
    f.watchAllSessions.current = true;
    await f.monitor.scan();
    expect(f.store.size).toBe(2);
    f.sessions.length = 0;
    await f.monitor.scan();
    expect(f.store.size).toBe(0);
  });

  it('keeps stable identity and avoids repeating completion notifications on each poll', async () => {
    const f = fixture();
    f.sessions.push(snapshot('idle', { status: 'done', lastActivityAt: 1 }));
    await f.monitor.scan();
    const id = [...f.store.keys()][0];
    const count = f.messages.length;
    await f.monitor.scan();
    expect([...f.store.keys()]).toEqual([id]);
    expect(f.messages).toHaveLength(count);
    expect(f.store.get(id)?.isWaiting).toBe(true);
  });

  it('keeps parallel tools independent and announces reading capabilities before tools', async () => {
    const f = fixture();
    f.sessions.push(
      snapshot('work', {
        tools: [
          { id: 'read', name: 'view', status: 'Reading file', isReading: true },
          { id: 'shell', name: 'powershell', status: 'Running command', isReading: false },
        ],
      }),
    );
    await f.monitor.scan();
    const agent = [...f.store.values()][0];
    expect(agent.activeToolIds.size).toBe(2);
    expect(f.monitor.readingTools.has('view')).toBe(true);
    expect(f.capabilitiesChanged).toHaveBeenCalledOnce();
    f.sessions[0] = snapshot('work', {
      tools: [{ id: 'shell', name: 'powershell', status: 'Running command', isReading: false }],
    });
    await f.monitor.scan();
    expect([...agent.activeToolIds]).toEqual(['shell']);
    expect(f.messages).toContainEqual({ type: 'agentToolDone', id: agent.id, toolId: 'read' });
  });

  it('shows thinking between tools and preserves input/permission state on reconnect', async () => {
    const f = fixture();
    f.sessions.push(snapshot('work'));
    await f.monitor.scan();
    const agent = [...f.store.values()][0];
    expect([...agent.activeToolStatuses.values()]).toEqual(['Thinking']);
    f.sessions[0] = snapshot('work', { status: 'input' });
    await f.monitor.scan();
    const replay: Record<string, unknown>[] = [];
    resendAgentActivity((message) => replay.push(message), f.store);
    expect(replay).toContainEqual({
      type: 'agentStatus',
      id: agent.id,
      status: 'waiting',
      awaitingInput: true,
    });
    f.sessions[0] = snapshot('work', { status: 'permission' });
    await f.monitor.scan();
    replay.length = 0;
    resendAgentActivity((message) => replay.push(message), f.store);
    expect(replay).toContainEqual({ type: 'agentToolPermission', id: agent.id });
    f.sessions[0] = snapshot('work', { status: 'done' });
    await f.monitor.scan();
    expect(agent.permissionSent).toBe(false);
    expect(agent.activeToolIds.size).toBe(0);
  });

  it('does not re-adopt a dismissed character while its session remains live', async () => {
    const f = fixture();
    const session = snapshot('dismiss');
    f.sessions.push(session);
    await f.monitor.scan();
    const id = [...f.store.keys()][0];
    f.dismissals.dismiss(session.transcriptPath);
    f.store.delete(id);
    await f.monitor.scan();
    f.dismissals.clearDismissal(session.transcriptPath);
    await f.monitor.scan();
    expect(f.store.size).toBe(0);
    f.sessions.length = 0;
    await f.monitor.scan();
    f.sessions.push(session);
    await f.monitor.scan();
    expect(f.store.size).toBe(1);
  });

  it('renders named teammates and unnamed subagents separately and restores their activity', async () => {
    const f = fixture();
    f.sessions.push(
      snapshot('team', {
        context: { usedTokens: 100000, maxTokens: 400000 },
        children: [
          {
            id: 'named',
            name: 'reviewer',
            label: 'Review code',
            status: 'active',
            tools: [{ id: 'read', name: 'view', status: 'Reading file.ts', isReading: true }],
          },
          { id: 'unnamed', label: 'Explore code', status: 'active', tools: [] },
        ],
      }),
    );
    await f.monitor.scan();
    const parent = [...f.store.values()].find((agent) => agent.sessionId === 'team')!;
    const teammate = [...f.store.values()].find((agent) => agent.leadAgentId === parent.id)!;
    expect(f.store.size).toBe(2);
    expect(parent.isTeamLead).toBe(true);
    expect(teammate.agentName).toBe('reviewer');
    expect(parent.contextTokens).toBe(100000);
    expect(parent.maxContextTokens).toBe(400000);
    expect(f.messages).toContainEqual(
      expect.objectContaining({
        type: 'subagentToolStart',
        id: parent.id,
        parentToolId: 'unnamed',
        label: 'Explore code',
      }),
    );
    const replay: Record<string, unknown>[] = [];
    resendAgentActivity((message) => replay.push(message), f.store);
    expect(replay).toContainEqual(
      expect.objectContaining({ type: 'subagentToolStart', parentToolId: 'unnamed' }),
    );
    f.sessions[0] = snapshot('team');
    await f.monitor.scan();
    expect(f.store.size).toBe(1);
    expect(parent.isTeamLead).toBe(false);
    expect(parent.contextTokens).toBe(0);
    expect(f.messages).toContainEqual({
      type: 'subagentClear',
      id: parent.id,
      parentToolId: 'unnamed',
    });
  });

  it('does not reopen a dismissed teammate or dismiss its parent', async () => {
    const f = fixture();
    f.sessions.push(
      snapshot('team', {
        children: [{ id: 'worker', name: 'worker', label: 'Work', status: 'active', tools: [] }],
      }),
    );
    await f.monitor.scan();
    const teammate = [...f.store.values()].find((agent) => agent.leadAgentId !== undefined)!;
    f.store.delete(teammate.id);
    await f.monitor.scan();
    expect(f.store.size).toBe(1);
    expect(f.dismissals.isDismissed(f.sessions[0].transcriptPath)).toBe(false);
  });

  it('publishes updated session details and replays them when the browser reconnects', async () => {
    const f = fixture();
    f.sessions.push(
      snapshot('details', {
        latestRequest: {
          content: 'Fix login',
          timestamp: '2026-09-09T04:00:00Z',
          truncated: false,
        },
      }),
    );
    await f.monitor.scan();
    const id = [...f.store.keys()][0];
    expect(f.messages).toContainEqual(
      expect.objectContaining({
        type: 'agentDetails',
        id,
        details: expect.objectContaining({
          latestRequest: expect.objectContaining({ content: 'Fix login' }),
        }),
      }),
    );
    f.sessions[0] = {
      ...f.sessions[0],
      latestResponse: {
        content: 'Checking the form',
        timestamp: '2026-09-09T04:00:01Z',
        truncated: false,
      },
    };
    await f.monitor.scan();
    const replay: Record<string, unknown>[] = [];
    resendAgentActivity((message) => replay.push(message), f.store);
    expect(replay).toContainEqual(
      expect.objectContaining({
        type: 'agentDetails',
        id,
        details: expect.objectContaining({
          latestResponse: expect.objectContaining({ content: 'Checking the form' }),
        }),
      }),
    );
    expect(JSON.stringify(replay)).not.toContain('transcriptPath');
  });

  it('preserves an outstanding approval when another parallel tool starts', async () => {
    const f = fixture();
    f.sessions.push(snapshot('approval', { status: 'permission' }));
    await f.monitor.scan();
    f.messages.length = 0;
    f.sessions[0] = snapshot('approval', {
      status: 'permission',
      tools: [{ id: 'parallel', name: 'view', status: 'Reading file', isReading: true }],
    });
    await f.monitor.scan();
    expect(f.messages).toContainEqual(
      expect.objectContaining({
        type: 'agentToolStart',
        toolId: 'parallel',
        permissionActive: true,
      }),
    );
  });

  it('preserves live characters on scan errors and never overlaps scans', async () => {
    const f = fixture();
    f.sessions.push(snapshot('work'));
    await f.monitor.scan();
    let rejectScan!: (error: Error) => void;
    vi.mocked(f.provider.scan).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectScan = reject;
        }),
    );
    const first = f.monitor.scan();
    const second = f.monitor.scan();
    expect(first).toBe(second);
    rejectScan(new Error('access denied'));
    await expect(first).rejects.toThrow('access denied');
    expect(f.store.size).toBe(1);
  });

  it('does not resurrect characters if disposed during an in-flight scan', async () => {
    const f = fixture();
    let resolveScan!: (sessions: readonly FileSessionSnapshot[]) => void;
    vi.mocked(f.provider.scan).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve;
        }),
    );
    const pending = f.monitor.scan();
    f.monitor.dispose();
    resolveScan([snapshot('late')]);
    await pending;
    expect(f.store.size).toBe(0);
    expect(f.provider.dispose).toHaveBeenCalledOnce();
  });
});

describe('read-only office handshake', () => {
  it('keeps global visibility and never offers or executes Claude hook installs', async () => {
    const store = new AgentStateStore();
    const runtime = new AgentRuntime(store, claudeProvider, { hookProviders: [] });
    runtime.watchAllSessions.current = true;
    const checkHooks = vi.spyOn(claudeProvider, 'areHooksInstalled');
    const onSetHooksEnabled = vi.fn();
    const messages: Record<string, unknown>[] = [];
    try {
      const ctx = { store, runtime, cache: null, privileged: true, onSetHooksEnabled };
      handleClientMessage({ type: 'webviewReady' }, (message) => messages.push(message), ctx);
      handleClientMessage(
        { type: 'setHooksEnabled', providerId: 'claude', enabled: true },
        (message) => messages.push(message),
        ctx,
      );
      handleClientMessage(
        { type: 'hooksConsentResponse', providerId: 'claude', choice: 'install' },
        (message) => messages.push(message),
        ctx,
      );
      expect(messages).toContainEqual(
        expect.objectContaining({
          type: 'settingsLoaded',
          watchAllSessions: true,
          hooksEnabled: false,
        }),
      );
      expect(messages).toContainEqual(
        expect.objectContaining({
          type: 'providerCapabilities',
          hookProviderIds: [],
        }),
      );
      expect(checkHooks).not.toHaveBeenCalled();
      expect(onSetHooksEnabled).not.toHaveBeenCalled();
      expect(runtime.watchAllSessions.current).toBe(true);
    } finally {
      runtime.dispose();
      vi.restoreAllMocks();
    }
  });
});
