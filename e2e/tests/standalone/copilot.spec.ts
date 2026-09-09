import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { expect, test } from '@playwright/test';

import { launchStandalone, type StandaloneSession } from '../../helpers/standalone';
import { openSettingsModal, setSettings } from '../../helpers/webview';

test('Copilot office adopts existing sessions across folders and tracks live lifecycle @area:standalone', async ({
  page,
}, testInfo) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-copilot-e2e-'));
  const children: ChildProcessWithoutNullStreams[] = [];
  let office: StandaloneSession | undefined;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  async function startSession(cwd: string, title: string) {
    const child = spawn(
      process.execPath,
      [path.resolve(__dirname, '../../fixtures/mock-copilot.cjs'), home, randomUUID(), cwd, title],
      { stdio: 'pipe' },
    );
    children.push(child);
    const lines = createInterface({ input: child.stdout });
    const nextLine = () => new Promise<void>((resolve) => lines.once('line', () => resolve()));
    await nextLine();
    return {
      emit: async (type: string, data: Record<string, unknown> = {}, agentId?: string) => {
        const written = nextLine();
        child.stdin.write(JSON.stringify({ type, data, agentId }) + '\n');
        await written;
      },
      stop: async () => {
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        child.stdin.write(JSON.stringify({ type: 'exit' }) + '\n');
        await exited;
        lines.close();
      },
    };
  }

  try {
    const workspace = path.join(home, 'alpha-project');
    const first = await startSession(workspace, 'Alpha session');
    const second = await startSession(path.join(home, 'beta-project'), 'Beta session');
    await first.emit('user.message', { content: 'Fix the login form validation.' });
    await first.emit('assistant.message', {
      content: 'I am reading the form component.',
      phase: 'commentary',
    });
    await first.emit('tool.execution_start', {
      toolCallId: 'read-one',
      toolName: 'view',
      arguments: { path: 'example.ts' },
    });
    await second.emit('user.message', { content: 'Fixture prompt' });
    await second.emit('tool.execution_start', {
      toolCallId: 'ask-one',
      toolName: 'ask_user',
      arguments: { message: 'Fixture question' },
    });
    office = await launchStandalone(page, {
      homeDir: home,
      workspaceDir: workspace,
      seedHooksConsent: false,
      cliArgs: ['--copilot', '--watch-all-sessions', '--terminal-controls'],
    });
    const settings = await openSettingsModal(page);
    await page.getByText('Always Show Labels', { exact: true }).click();
    await expect(
      page.getByText('Copilot CLI: read-only session monitoring. No hooks required.'),
    ).toBeVisible();
    await expect(page.getByText('Instant Detection (Hooks)', { exact: true })).toHaveCount(0);
    await settings.getByRole('button', { name: 'x', exact: true }).click();
    const overlays = page.getByTestId('agent-overlay');
    await expect(overlays).toHaveCount(2);
    await expect(page.getByText('GitHub Copilot: Alpha session', { exact: true })).toBeVisible();
    await expect(page.getByText('GitHub Copilot: Beta session', { exact: true })).toBeVisible();
    await expect(page.getByText('Waiting for input', { exact: true })).toBeVisible();
    expect(fs.existsSync(path.join(home, '.claude', 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.copilot', 'config.json'))).toBe(false);

    await page.getByRole('button', { name: 'Sessions (2)', exact: true }).click();
    await page.getByLabel('Select session').selectOption({ label: 'Alpha session' });
    const details = page.getByTestId('session-details');
    await expect(
      details.getByText('Fix the login form validation.', { exact: true }),
    ).toBeVisible();
    await expect(
      details.getByText('I am reading the form component.', { exact: true }),
    ).toBeVisible();
    await expect(details.getByText('File: example.ts', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '+ Agent', exact: true })).toBeVisible();
    await expect(
      details.getByRole('button', { name: 'Open session in terminal', exact: true }),
    ).toBeVisible();
    await details.getByRole('button', { name: 'Focus terminal', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('not opened by this office');
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await first.emit('tool.execution_start', {
      toolCallId: 'test-command',
      toolName: 'powershell',
      arguments: { command: 'npm run test -- login', description: 'Exercise form validation' },
    });
    await expect(
      details.getByText('Exercise form validation\nCommand:\nnpm run test -- login', {
        exact: true,
      }),
    ).toBeVisible();
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const bounds = await details.boundingBox();
      expect(bounds?.x).toBeGreaterThanOrEqual(0);
      expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: testInfo.outputPath(`office-${width}.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    await page.reload();
    await expect(overlays).toHaveCount(2);
    await expect(page.getByText('Waiting for input', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Sessions (2)', exact: true }).click();
    await page.getByLabel('Select session').selectOption({ label: 'Alpha session' });
    await expect(
      details.getByText('Fix the login form validation.', { exact: true }),
    ).toBeVisible();
    await first.emit('tool.execution_complete', { toolCallId: 'test-command', success: false });
    await expect(details.getByText('Failed', { exact: true })).toBeVisible();
    await details.getByRole('button', { name: 'Close session details' }).click();
    await first.emit('tool.execution_complete', { toolCallId: 'read-one', success: true });
    await first.emit('assistant.turn_end', {});
    await expect(page.getByText('Thinking', { exact: true })).toBeVisible();
    await first.emit('assistant.message', { content: 'Finished.', toolRequests: [] });
    await first.emit('session.usage_checkpoint', {});
    await expect(page.getByText('Thinking', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Sessions (2)', exact: true }).click();
    await page.getByLabel('Select session').selectOption({ label: 'Alpha session' });
    await expect(details.getByText('Finished.', { exact: true })).toBeVisible();
    await details.getByRole('button', { name: 'Close session details' }).click();

    await setSettings(page, { watchAllSessions: false });
    await expect(overlays).toHaveCount(1);
    await setSettings(page, { watchAllSessions: true });
    await expect(overlays).toHaveCount(2);
    await second.stop();
    await expect(overlays).toHaveCount(1);
    await first.emit('session.usage_info', { currentTokens: 100000, tokenLimit: 400000 });
    await first.emit('tool.execution_start', {
      toolCallId: 'named-spawn',
      toolName: 'task',
      arguments: { name: 'named-worker', description: 'Review in parallel', mode: 'background' },
    });
    await first.emit('subagent.started', { toolCallId: 'named-spawn' }, 'named-actor');
    await first.emit(
      'tool.execution_start',
      { toolCallId: 'worker-read', toolName: 'view', arguments: { path: 'worker.ts' } },
      'named-actor',
    );
    await first.emit('tool.execution_start', {
      toolCallId: 'unnamed-spawn',
      toolName: 'task',
      arguments: { description: 'Explore sibling', mode: 'sync' },
    });
    await first.emit('subagent.started', { toolCallId: 'unnamed-spawn' }, 'unnamed-actor');
    await first.emit(
      'tool.execution_start',
      { toolCallId: 'helper-read', toolName: 'view', arguments: { path: 'helper.ts' } },
      'unnamed-actor',
    );
    await expect(overlays).toHaveCount(3);
    await expect(page.getByText('named-worker', { exact: true })).toBeVisible();
    await expect(page.getByText('Explore sibling', { exact: true })).toBeVisible();
    await expect(page.getByTestId('context-gauge')).toHaveAttribute('data-context-pct', '25');
    await page.reload();
    await expect(overlays).toHaveCount(3);
    await expect(page.getByText('named-worker', { exact: true })).toBeVisible();
    await first.emit('subagent.completed', { toolCallId: 'named-spawn' }, 'named-actor');
    await first.emit('subagent.completed', { toolCallId: 'unnamed-spawn' }, 'unnamed-actor');
    await expect(overlays).toHaveCount(1);
    await page.goto(office.hostUrl);
    await expect(page.getByRole('button', { name: '+ Agent', exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await office?.cleanup();
    for (const child of children) {
      if (child.exitCode === null) {
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        child.kill();
        await exited;
      }
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
