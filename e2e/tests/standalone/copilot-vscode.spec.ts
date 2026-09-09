import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { Frame } from '@playwright/test';

import { runCommand, setSettings } from '../../helpers/webview';

test('VS Code Copilot office adopts and launches Copilot terminals without Claude hooks @area:standalone', async ({}, testInfo) => {
  const executablePath = process.env.PIXEL_AGENTS_VSCODE_EXECUTABLE;
  test.skip(!executablePath, 'Set PIXEL_AGENTS_VSCODE_EXECUTABLE to VS Code 1.105 or newer.');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-copilot-vscode-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  const userData = path.join(root, 'user-data');
  const bin = path.join(root, 'bin');
  for (const dir of [home, workspace, path.join(userData, 'User'), bin])
    fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'User', 'settings.json'),
    JSON.stringify({
      'pixel-agents.agentProvider': 'copilot',
      'pixel-agents.autoShowPanel': true,
      'telemetry.telemetryLevel': 'off',
      'workbench.startupEditor': 'none',
      'security.workspace.trust.enabled': false,
      'terminal.integrated.enablePersistentSessions': false,
    }),
  );
  const mockCli = path.resolve(__dirname, '../../fixtures/mock-copilot-cli.cjs');
  fs.writeFileSync(
    path.join(bin, 'copilot.cmd'),
    `@echo off\r\n"${process.execPath}" "${mockCli}" %*\r\n`,
  );
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  };
  const producer = spawn(process.execPath, [mockCli], { cwd: workspace, env, stdio: 'ignore' });
  const app = await electron.launch({
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
      '--user-data-dir',
      userData,
      '--extensions-dir',
      path.join(root, 'extensions'),
      `--extensionDevelopmentPath=${path.resolve(__dirname, '../../..')}`,
      workspace,
    ],
    env,
  });
  try {
    const window = await app.firstWindow();
    const command = async (name: string) => {
      await app.evaluate(({ BrowserWindow }) => {
        const current = BrowserWindow.getAllWindows()[0];
        current.focus();
        current.webContents.focus();
      });
      await runCommand(window, name);
    };
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000));
    let office: Frame | undefined;
    await expect
      .poll(
        async () => {
          for (const frame of window.frames()) {
            if (await frame.getByRole('button', { name: 'Layout', exact: true }).count()) {
              office = frame;
              return true;
            }
          }
          return false;
        },
        { timeout: 45000 },
      )
      .toBe(true);
    await command('View: Toggle Maximized Panel');
    await setSettings(office!, { alwaysShowLabels: true });
    await expect(office!.getByTestId('agent-overlay')).toHaveCount(1);
    await expect(office!.getByText('Reading: integration.ts', { exact: true })).toBeVisible();
    await office!.getByRole('button', { name: '+ Agent', exact: true }).click();
    await expect
      .poll(() => fs.readdirSync(path.join(home, '.copilot', 'session-state')).length, {
        timeout: 20000,
      })
      .toBe(2);
    expect(fs.existsSync(path.join(home, '.claude', 'settings.json'))).toBe(false);
    await command('Pixel Agents: Show Panel');
    await expect
      .poll(
        async () => {
          for (const frame of window.frames()) {
            if (frame.isDetached()) continue;
            if (await frame.getByRole('button', { name: 'Layout', exact: true }).count()) {
              office = frame;
              return true;
            }
          }
          return false;
        },
        { timeout: 15000 },
      )
      .toBe(true);
    await expect(office!.getByTestId('agent-overlay')).toHaveCount(2);
    await office!.getByRole('button', { name: 'Sessions (2)', exact: true }).click();
    const sessionDirs = fs.readdirSync(path.join(home, '.copilot', 'session-state'));
    const options = office!.getByLabel('Select session').locator('option');
    const ids = await options.evaluateAll((items) =>
      items.map((item) => (item as HTMLOptionElement).value).filter(Boolean),
    );
    for (const id of ids) {
      await office!.getByLabel('Select session').selectOption(id);
      const panel = office!.getByTestId('session-details');
      const sessionText = await panel.innerText();
      const sessionId = sessionDirs.find((sid) => sessionText.includes(sid));
      const agentMeta = sessionId
        ? fs.readdirSync(path.join(home, '.copilot', 'session-state', sessionId))
        : [];
      if (!agentMeta.some((entry) => entry === `inuse.${producer.pid}.lock`)) {
        await panel.getByRole('button', { name: 'Focus terminal', exact: true }).click();
        await expect(
          window.getByText(`Pixel Copilot ${sessionId}`, { exact: true }).first(),
        ).toBeVisible();
        break;
      }
    }
    await command('Pixel Agents: Show Panel');
    await window.screenshot({ path: testInfo.outputPath('copilot-vscode.png') });
  } finally {
    await app.close();
    if (producer.exitCode === null) {
      const exited = new Promise<void>((resolve) => producer.once('exit', () => resolve()));
      producer.kill();
      await exited;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
