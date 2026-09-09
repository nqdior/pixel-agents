const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const [root, sessionId, cwd, title] = process.argv.slice(2);
const directory = path.join(root, '.copilot', 'session-state', sessionId);
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(
  path.join(directory, 'workspace.yaml'),
  [`id: ${sessionId}`, `cwd: ${JSON.stringify(cwd)}`, `name: ${JSON.stringify(title)}`, ''].join(
    '\n',
  ),
);
const lock = path.join(directory, `inuse.${process.pid}.lock`);
fs.writeFileSync(lock, `${process.pid}\n`);
const transcript = path.join(directory, 'events.jsonl');
function append(type, data, agentId) {
  fs.appendFileSync(
    transcript,
    JSON.stringify({ type, timestamp: new Date().toISOString(), data, agentId }) + '\n',
  );
}
append('session.start', { sessionId, context: { cwd } });
console.log('ready');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const event = JSON.parse(line);
  if (event.type === 'exit') {
    fs.unlinkSync(lock);
    process.exit(0);
  }
  append(event.type, event.data, event.agentId);
  console.log('written');
});
