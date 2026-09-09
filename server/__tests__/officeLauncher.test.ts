import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const launcher = path.resolve(__dirname, '../../start-copilot-office.ps1');
const timeoutMs = 30000;

function start(home: string, port: number, cwd: string) {
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'RemoteSigned',
    '-File',
    launcher,
    '-NoBrowser',
    '--port',
    String(port),
  ];
  const child = spawn('powershell.exe', args, {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (bytes: Buffer) => {
    output += bytes.toString();
  });
  child.stderr.on('data', (bytes: Buffer) => {
    output += bytes.toString();
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  return { child, exited, output: () => output };
}

async function reservePort(): Promise<{ port: number; server: net.Server }> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port allocated.');
  return { port: address.port, server };
}

describe.skipIf(process.platform !== 'win32')('Pixel Office PowerShell launcher', () => {
  it(
    'cold-starts and reuses the server from a different cwd',
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-launcher-test-'));
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-launcher-cwd-'));
      const reserved = await reservePort();
      await new Promise<void>((resolve) => reserved.server.close(() => resolve()));
      const first = start(home, reserved.port, cwd);
      let serverPid: number | undefined;
      try {
        await expect
          .poll(first.output, { timeout: 20000 })
          .toContain('Pixel Office: http://127.0.0.1:');
        const response = await fetch(`http://127.0.0.1:${reserved.port}/api/health`);
        const health = (await response.json()) as { status: string; pid: number };
        serverPid = health.pid;
        expect(health.status).toBe('ok');
        expect(first.child.exitCode).toBeNull();
        const second = start(home, reserved.port, home);
        expect(await second.exited).toBe(0);
        expect(second.output()).toContain('Reusing the running Copilot office.');
        const reused = (await (
          await fetch(`http://127.0.0.1:${reserved.port}/api/health`)
        ).json()) as { pid: number };
        expect(reused.pid).toBe(serverPid);
        expect(
          fs
            .readdirSync(path.join(home, '.pixel-agents', 'servers'))
            .filter((name) => name.endsWith('.json')),
        ).toHaveLength(1);
      } finally {
        if (serverPid) {
          await run('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Stop-Process -Id ${serverPid} -ErrorAction Stop`,
          ]);
        }
        if (first.child.exitCode === null) {
          if (serverPid) {
            await expect.poll(() => first.child.exitCode, { timeout: 5000 }).not.toBeNull();
          } else {
            first.child.kill();
          }
          await first.exited;
        }
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
    timeoutMs,
  );

  it(
    'refuses a conflicting port without terminating its owner',
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-launcher-conflict-'));
      const { server, port } = await reservePort();
      try {
        const attempt = start(home, port, home);
        expect(await attempt.exited).not.toBe(0);
        expect(attempt.output()).toContain('No process was stopped.');
        expect(server.listening).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
    timeoutMs,
  );
});
