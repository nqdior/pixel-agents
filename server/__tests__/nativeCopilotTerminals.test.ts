import { describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import { buildCopilotTerminalScript } from '../src/nativeCopilotTerminals.js';

const sessionId = '11111111-1111-1111-1111-111111111111';

describe('native Copilot terminal controls', () => {
  it('keeps paths as data and launches without permission bypass or an automatic prompt', () => {
    const cwd = 'C:\\work\\quoted \"; Write-Output injected; #';
    const script = buildCopilotTerminalScript(sessionId, cwd);
    expect(script).not.toContain(cwd);
    expect(script).toContain('Set-Location -LiteralPath');
    const payload = /FromBase64String\('([^']+)'\)/.exec(script)?.[1];
    expect(payload).toBeDefined();
    expect(JSON.parse(Buffer.from(payload!, 'base64').toString('utf8'))).toEqual({
      cwd,
      args: ['--session-id', sessionId],
    });
    expect(() => buildCopilotTerminalScript('not-a-uuid; bad', cwd)).toThrow('UUID');
  });

  it('requires the private operator token and rejects bypass requests', async () => {
    const onTerminalAction = vi.fn(async () => {});
    const messages: Record<string, unknown>[] = [];
    const ctx = { store: new AgentStateStore(), cache: null, onTerminalAction };
    handleClientMessage({ type: 'launchAgent' }, (message) => messages.push(message), ctx);
    handleClientMessage(
      { type: 'openAgentTerminal', id: 1 },
      (message) => messages.push(message),
      ctx,
    );
    handleClientMessage(
      { type: 'launchAgent', bypassPermissions: true },
      (message) => messages.push(message),
      { ...ctx, privileged: true },
    );
    expect(onTerminalAction).not.toHaveBeenCalled();
    expect(messages).toHaveLength(3);
    expect(messages.every((message) => message.success === false)).toBe(true);
    handleClientMessage({ type: 'openAgentTerminal', id: 1 }, (message) => messages.push(message), {
      ...ctx,
      privileged: true,
    });
    await Promise.resolve();
    expect(onTerminalAction).toHaveBeenCalledWith('open', 1, undefined);
    expect(messages.at(-1)).toMatchObject({ type: 'terminalActionResult', success: true });
  });
});
