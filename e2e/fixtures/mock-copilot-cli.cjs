const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const args = process.argv.slice(2);
const optionIndex = args.indexOf('--session-id');
const sessionId = optionIndex >= 0 ? args[optionIndex + 1]
  : args.find((arg) => arg.startsWith('--session-id='))?.split('=')[1] ?? randomUUID();
const dir = path.join(process.env.USERPROFILE || process.env.HOME, '.copilot', 'session-state', sessionId);
fs.mkdirSync(dir, { recursive: true });
const lock = path.join(dir, `inuse.${process.pid}.lock`);
fs.writeFileSync(lock, String(process.pid));
fs.writeFileSync(path.join(dir, 'workspace.yaml'), `id: ${sessionId}\ncwd: ${JSON.stringify(process.cwd())}\nname: "VS Code Copilot fixture"\n`);
fs.appendFileSync(path.join(dir, 'events.jsonl'), [
  { type: 'session.start', data: {} },
  { type: 'user.message', data: { content: 'Inspect the extension fixture' } },
  { type: 'tool.execution_start', data: { toolCallId: 'fixture-read', toolName: 'view', arguments: { path: 'integration.ts' } } },
].map((event) => JSON.stringify({ ...event, timestamp: new Date().toISOString() })).join('\n') + '\n');
process.on('exit', () => { if (fs.existsSync(lock)) fs.unlinkSync(lock); });
setInterval(() => {}, 1000);
