import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const PROCESS_TIMEOUT_MS = 15_000;

function encoded(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function decodePayload(value: unknown): string {
  const payload = Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json`;
}

export function buildCopilotTerminalScript(sessionId: string, cwd: string): string {
  if (!UUID.test(sessionId)) throw new Error('A valid Copilot session UUID is required.');
  return [
    "$ErrorActionPreference = 'Stop'",
    `$launch = ${decodePayload({ cwd, args: ['--session-id', sessionId] })}`,
    'Set-Location -LiteralPath $launch.cwd',
    '& copilot @($launch.args)',
  ].join('\n');
}

/** Native window actions are invoked only by an authenticated operator click. */
export class NativeCopilotTerminals {
  private readonly owned = new Map<string, { pid: number; startedAt: string }>();

  async open(cwd: string, sessionId: string = randomUUID()): Promise<void> {
    if (process.platform !== 'win32')
      throw new Error(
        'Native browser terminal controls currently require Windows. Use the VS Code adapter on this host.',
      );
    if (!(await fs.stat(cwd)).isDirectory())
      throw new Error('The terminal working directory does not exist.');
    const script = buildCopilotTerminalScript(sessionId, cwd);
    const outer = [
      "$ErrorActionPreference = 'Stop'",
      `$command = '${encoded(script)}'`,
      "$child = Start-Process -FilePath powershell.exe -ArgumentList @('-NoLogo', '-NoExit', '-EncodedCommand', $command) -PassThru",
      "@{ pid = $child.Id; startedAt = $child.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress",
    ].join('\n');
    const { stdout } = await run(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(outer)],
      { windowsHide: true, timeout: PROCESS_TIMEOUT_MS },
    );
    const result: unknown = JSON.parse(stdout);
    if (
      !result ||
      typeof result !== 'object' ||
      !('pid' in result) ||
      !('startedAt' in result) ||
      typeof result.pid !== 'number' ||
      typeof result.startedAt !== 'string'
    ) {
      throw new Error('Windows did not return the launched terminal identity.');
    }
    this.owned.set(sessionId, { pid: result.pid, startedAt: result.startedAt });
  }

  async focus(sessionId: string): Promise<void> {
    const owned = this.owned.get(sessionId);
    if (!owned)
      throw new Error(
        'This terminal was not opened by this office. Use "Open session in terminal" to attach with Copilot.',
      );
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$owned = ${decodePayload(owned)}`,
      '$terminal = Get-Process -Id $owned.pid',
      "if ($terminal.StartTime.ToUniversalTime().ToString('o') -ne $owned.startedAt) { throw 'The original terminal has exited.' }",
      'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class PixelOfficeWindow { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c); }\'',
      "if ($terminal.MainWindowHandle -eq 0) { throw 'This terminal host does not expose a focusable window. Switch to its tab manually, or use the VS Code adapter for exact terminal focus.' }",
      '[void][PixelOfficeWindow]::ShowWindowAsync($terminal.MainWindowHandle, 9)',
      "if (-not [PixelOfficeWindow]::SetForegroundWindow($terminal.MainWindowHandle)) { throw 'Windows declined to focus this terminal window.' }",
    ].join('\n');
    await run(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(script)],
      { windowsHide: true, timeout: PROCESS_TIMEOUT_MS },
    );
  }
}
