import type { FileHandle } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  FileChildSnapshot,
  FileContextUsage,
  FileMessage,
  FileSessionProvider,
  FileSessionSnapshot,
  FileTool,
  FileToolResult,
} from '../../../../../core/src/fileProvider.js';
import {
  ACTIVITY_LABEL_LIMIT,
  COPILOT_DISPLAY_NAME,
  COPILOT_LOCK_PATTERN,
  COPILOT_LOG_PREFIX,
  COPILOT_PROVIDER_ID,
  COPILOT_SESSION_DIRECTORY,
  COPILOT_SESSION_STATE_DIRECTORY,
  COPILOT_TRANSCRIPT_FILE,
  COPILOT_WORKSPACE_FILE,
  FILE_ANCHOR_BYTES,
  MAX_PROCESS_ID,
  READ_CHUNK_BYTES,
  READING_TOOLS,
  RECENT_TOOL_LIMIT,
} from './constants.js';
import type { ProjectedEvent } from './eventReader.js';
import { EventReader } from './eventReader.js';

export interface CopilotProviderOptions {
  sessionRoot?: string;
  isProcessAlive?: (pid: number) => boolean;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (hasCode(error, 'ESRCH')) return false;
    if (hasCode(error, 'EPERM')) return true;
    throw error;
  }
}

function yamlScalar(raw: string): string | undefined {
  const value = raw.trim();
  if (!value || value === 'null' || value === '~' || value.startsWith('#')) return undefined;
  if (value.startsWith('"')) {
    const match = /^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(value);
    if (!match) return undefined;
    try {
      return JSON.parse(match[1]) as string;
    } catch (error) {
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  }
  if (value.startsWith("'")) {
    return /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(value)?.[1].replace(/''/g, "'");
  }
  if (value === '|' || value === '>' || value.startsWith('{') || value.startsWith('['))
    return undefined;
  return value.replace(/\s+#.*$/, '').trim();
}

function metadata(raw: string): { id?: string; cwd?: string; title?: string } {
  const result: { id?: string; cwd?: string; title?: string } = {};
  for (const line of raw.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = /^(id|cwd|name):\s*(.*)$/.exec(line);
    if (match)
      result[match[1] === 'name' ? 'title' : (match[1] as 'id' | 'cwd')] = yamlScalar(match[2]);
  }
  return result;
}

function toolName(raw: string): string {
  return raw.split(/[./:]|__/).at(-1) || raw;
}

function toolInfo(id: string, raw: string, event: ProjectedEvent): FileTool {
  const name = toolName(raw);
  const normalized = name.toLowerCase();
  const isReading =
    READING_TOOLS.has(normalized) || /^(?:read_|get_|list_|search_|fetch_)/.test(normalized);
  let status: string;
  if (normalized === 'ask_user') status = 'Waiting for input';
  else if (normalized === 'rg' || normalized === 'glob' || normalized.includes('search'))
    status = 'Searching';
  else if (isReading) status = 'Reading';
  else if (['powershell', 'bash', 'shell', 'terminal', 'run_command'].includes(normalized))
    status = 'Running command';
  else if (['apply_patch', 'edit', 'create', 'write', 'write_file'].includes(normalized))
    status = 'Editing';
  else status = `Using ${name}`;
  const argument = (key: string) => stringField(event, `data.arguments.${key}`)?.trim();
  const file =
    argument('path') || argument('file_path') || argument('filePath') || argument('paths');
  const command = argument('command');
  const description = argument('description');
  const query = argument('pattern') || argument('query');
  const url = argument('url');
  const patch = stringField(event, 'data.arguments') || argument('patch') || argument('input');
  const patchFiles =
    normalized === 'apply_patch'
      ? [...(patch ?? '').matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map(
          (match) => match[1],
        )
      : [];
  const target = file || patchFiles.join(', ');
  const summary =
    description ||
    (target ? target.split(/[\\/]/).at(-1) : undefined) ||
    query ||
    command ||
    url ||
    argument('name') ||
    argument('message');
  const details = [
    description,
    target ? `File: ${target}` : undefined,
    command ? `Command:\n${command}` : undefined,
    query ? `Query: ${query}` : undefined,
    url ? `URL: ${url}` : undefined,
    argument('agent_type') ? `Agent: ${argument('agent_type')}` : undefined,
    argument('prompt') ? `Task: ${argument('prompt')}` : undefined,
    argument('message'),
    Object.keys(event).some(
      (key) =>
        key.startsWith('data.arguments') && key.endsWith('.truncated') && event[key] === true,
    )
      ? '[Tool input preview truncated]'
      : undefined,
  ]
    .filter((value): value is string => !!value)
    .join('\n');
  const label = summary ? `${status}: ${summary.replace(/\s+/g, ' ')}` : status;
  return {
    id,
    name,
    isReading,
    status:
      label.length > ACTIVITY_LABEL_LIMIT
        ? `${label.slice(0, ACTIVITY_LABEL_LIMIT - 3)}...`
        : label,
    ...(details ? { details } : {}),
  };
}

function stringField(event: ProjectedEvent, key: string): string | undefined {
  const value = event[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(event: ProjectedEvent, key: string): number | undefined {
  const raw = stringField(event, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

interface ChildActivity {
  id: string;
  agentId?: string;
  name?: string;
  label: string;
  background: boolean;
  active: boolean;
  reader: SessionReader;
}

class SessionReader {
  private offset = 0;
  private identity = '';
  private modifiedAt = 0;
  private head: Buffer = Buffer.alloc(0);
  private anchor: Buffer = Buffer.alloc(0);
  private warned = false;
  private parser = this.createParser();
  private ready = false;
  private activity: FileSessionSnapshot['status'] = 'done';
  private tools = new Map<string, FileTool>();
  private permissions = new Map<string, string | undefined>();
  private finalTurn: string | undefined;
  private finalPending = false;
  private lastActivityAt = 0;
  private latestRequest?: FileMessage;
  private latestResponse?: FileMessage;
  private recentTools: FileToolResult[] = [];
  private children = new Map<string, ChildActivity>();
  private queriedAgents = new Map<string, string>();
  private modelWindows = new Map<string, number>();
  private modelUsage = new Map<string, FileContextUsage>();
  private primaryModel?: string;
  private context?: FileContextUsage;

  constructor(
    readonly transcriptPath: string,
    private readonly isChild = false,
  ) {}

  private createParser(): EventReader {
    return new EventReader(
      (event) => this.event(event),
      () => {
        if (!this.warned) {
          this.warned = true;
          console.warn(
            `${COPILOT_LOG_PREFIX} Ignoring malformed or over-limit JSONL records: ${this.transcriptPath}`,
          );
        }
      },
    );
  }

  private reset(): void {
    this.offset = 0;
    this.head = Buffer.alloc(0);
    this.anchor = Buffer.alloc(0);
    this.parser = this.createParser();
    this.ready = false;
    this.activity = 'done';
    this.tools.clear();
    this.permissions.clear();
    this.finalPending = false;
    this.finalTurn = undefined;
    this.lastActivityAt = 0;
    this.latestRequest = undefined;
    this.latestResponse = undefined;
    this.recentTools = [];
    this.children.clear();
    this.queriedAgents.clear();
    this.modelWindows.clear();
    this.modelUsage.clear();
    this.primaryModel = undefined;
    this.context = undefined;
  }

  private finish(): void {
    this.activity = 'done';
    this.finalPending = false;
    this.finalTurn = undefined;
  }

  private event(event: ProjectedEvent): void {
    const type = stringField(event, 'type');
    const agentId = stringField(event, 'agentId');
    const parentToolId = stringField(event, 'data.parentToolCallId');
    const toolId = stringField(event, 'data.toolCallId');
    if (type?.startsWith('subagent.')) {
      let child = this.findChild(toolId, agentId);
      if (!child && type === 'subagent.started' && toolId) child = this.createChild(toolId, event);
      if (!child) return;
      child.agentId = agentId ?? child.agentId;
      if (type === 'subagent.started') child.active = true;
      if (
        type === 'subagent.completed' ||
        type === 'subagent.failed' ||
        type === 'subagent.stopped'
      ) {
        child.active = false;
        child.reader.consumeActivity({ type: 'abort' });
      }
      return;
    }
    const child = this.findChild(parentToolId, agentId);
    if (child) {
      if (!child.active) return;
      child.reader.consumeActivity(event);
      return;
    }
    this.consumeActivity(event);
  }

  private findChild(toolId?: string, agentId?: string): ChildActivity | undefined {
    if (toolId && this.children.has(toolId)) return this.children.get(toolId);
    for (const child of this.children.values()) {
      if (agentId && child.agentId === agentId) return child;
      const nested = child.reader.findChild(toolId, agentId);
      if (nested) return nested;
    }
    return undefined;
  }

  private createChild(id: string, event: ProjectedEvent): ChildActivity {
    const name = stringField(event, 'data.arguments.name');
    const label =
      stringField(event, 'data.arguments.description') ??
      stringField(event, 'data.agentDisplayName') ??
      stringField(event, 'data.agentName') ??
      'Sub-agent';
    const child: ChildActivity = {
      id,
      name,
      label,
      active: true,
      agentId:
        stringField(event, 'type') === 'subagent.started'
          ? stringField(event, 'agentId')
          : undefined,
      background:
        (stringField(event, 'data.arguments.mode') ?? stringField(event, 'data.executionMode')) ===
        'background',
      reader: new SessionReader(this.transcriptPath, true),
    };
    child.reader.consumeActivity({
      type: 'user.message',
      timestamp: stringField(event, 'timestamp') ?? '',
      'data.content.preview': stringField(event, 'data.arguments.prompt') ?? label,
    });
    this.children.set(id, child);
    return child;
  }

  private updateContext(event: ProjectedEvent): boolean {
    const type = stringField(event, 'type');
    if (type === 'session.usage_info') {
      const usedTokens = numberField(event, 'data.currentTokens');
      const maxTokens = numberField(event, 'data.tokenLimit');
      if (usedTokens !== undefined && maxTokens) {
        this.ready = true;
        this.context = { usedTokens, maxTokens, model: this.primaryModel };
      }
      return true;
    }
    if (type === 'session.model_change') {
      this.primaryModel = stringField(event, 'data.newModel');
      this.context = undefined;
      if (this.primaryModel) this.modelUsage.delete(this.primaryModel);
      return true;
    }
    if (type === 'model.turn_started') {
      const model = stringField(event, 'data.model');
      const limit = numberField(
        event,
        'data.modelInfo.capabilities.limits.max_context_window_tokens',
      );
      if (model && limit) this.modelWindows.set(model, limit);
      return true;
    }
    if (type === 'model.model_call_success') {
      const model = stringField(event, 'data.modelCall.model');
      const input = numberField(event, 'data.responseUsage.prompt_tokens');
      const output = numberField(event, 'data.responseUsage.completion_tokens');
      const limit = model ? this.modelWindows.get(model) : undefined;
      if (
        model &&
        input !== undefined &&
        output !== undefined &&
        limit &&
        input + output > 0 &&
        input + output <= limit
      ) {
        const usage = { usedTokens: input + output, maxTokens: limit, model };
        this.modelUsage.set(model, usage);
        if (model === this.primaryModel) this.context = usage;
      } else if (model && model === this.primaryModel && input !== undefined) {
        this.modelUsage.delete(model);
        this.context = undefined;
      }
      return true;
    }
    if (type === 'session.compaction_complete') {
      this.context = undefined;
      this.modelUsage.clear();
      return true;
    }
    return false;
  }

  private consumeActivity(event: ProjectedEvent): void {
    if (this.updateContext(event)) return;
    const type = stringField(event, 'type');
    if (!type) return;
    const toolId = stringField(event, 'data.toolCallId');
    const turnId = stringField(event, 'data.turnId');
    const nested = !this.isChild && !!stringField(event, 'data.parentToolCallId');
    switch (type) {
      case 'session.start':
      case 'session.resume':
        this.ready = true;
        break;
      case 'user.message':
        if (nested) return;
        this.latestRequest = this.message(event) ?? this.latestRequest;
        this.activity = 'active';
        this.finalPending = false;
        break;
      case 'assistant.turn_start':
        this.activity = 'active';
        break;
      case 'assistant.message': {
        if (nested) return;
        const model = stringField(event, 'data.model');
        if (model) {
          if (model !== this.primaryModel) this.context = undefined;
          this.primaryModel = model;
          this.context = this.modelUsage.get(model) ?? this.context;
        }
        this.latestResponse = this.message(event) ?? this.latestResponse;
        const phase = stringField(event, 'data.phase');
        const hasTools = event['data.toolRequests'] === true;
        this.finalPending =
          !hasTools && (phase === 'final_answer' || (!phase && event['data.content'] === true));
        this.finalTurn = turnId;
        if (hasTools) this.activity = 'active';
        if (
          phase === 'final_answer' &&
          this.finalPending &&
          !this.tools.size &&
          !this.permissions.size
        ) {
          this.finish();
        }
        break;
      }
      case 'assistant.turn_end':
        // Copilot ends an assistant turn after EVERY tool loop, not every request.
        if (
          this.finalPending &&
          this.finalTurn === turnId &&
          !this.tools.size &&
          !this.permissions.size
        ) {
          this.finish();
        }
        break;
      case 'session.usage_checkpoint':
        // A checkpoint alone is telemetry, never evidence that execution stopped.
        if (this.finalPending && !this.tools.size && !this.permissions.size) this.finish();
        return;
      case 'tool.execution_start': {
        const name = stringField(event, 'data.toolName');
        if (toolId && name) this.tools.set(toolId, toolInfo(toolId, name, event));
        const canonical = name ? toolName(name).toLowerCase() : '';
        if (toolId && canonical === 'task') this.createChild(toolId, event);
        const targetId = stringField(event, 'data.arguments.agent_id');
        if (toolId && targetId && canonical === 'read_agent')
          this.queriedAgents.set(toolId, targetId);
        if (targetId && canonical === 'write_agent') {
          const child = this.findChild(undefined, targetId);
          if (child) {
            child.active = true;
            child.reader.consumeActivity({
              type: 'user.message',
              timestamp: stringField(event, 'timestamp') ?? '',
              'data.content.preview': stringField(event, 'data.arguments.message') ?? '',
            });
          }
        }
        this.activity = 'active';
        this.finalPending = false;
        break;
      }
      case 'tool.execution_complete':
        if (toolId) {
          const result = stringField(event, 'data.result.content') ?? '';
          const child = this.children.get(toolId);
          if (child) {
            const backgroundId =
              /Agent started in background with agent_id:\s*([\da-f-]{36})/i.exec(result)?.[1];
            if (backgroundId) {
              child.agentId = backgroundId;
              child.background = true;
            } else if (!child.background || event['data.success'] === false) {
              child.active = false;
            }
          }
          const queried = this.queriedAgents.get(toolId);
          if (
            queried &&
            /^(?:Agent is idle\b|Agent[^\r\n]*\bstatus:\s*(?:completed|failed|cancelled|idle)\b)/i.test(
              result.split(/\r?\n/, 1)[0],
            )
          ) {
            const finished = this.findChild(undefined, queried);
            if (finished) finished.active = false;
          }
          this.queriedAgents.delete(toolId);
          const tool = this.tools.get(toolId);
          if (tool) {
            this.recentTools.unshift({
              ...tool,
              outcome: event['data.success'] === false ? 'error' : 'done',
            });
            this.recentTools.length = Math.min(this.recentTools.length, RECENT_TOOL_LIMIT);
          }
          this.tools.delete(toolId);
          for (const [requestId, pendingTool] of this.permissions) {
            if (pendingTool === toolId) this.permissions.delete(requestId);
          }
        }
        break;
      case 'permission.requested': {
        const requestId = stringField(event, 'data.requestId');
        if (requestId) {
          this.permissions.set(requestId, stringField(event, 'data.permissionRequest.toolCallId'));
        }
        break;
      }
      case 'permission.completed': {
        const requestId = stringField(event, 'data.requestId');
        if (requestId) this.permissions.delete(requestId);
        this.activity = 'active';
        break;
      }
      case 'session.idle':
      case 'session.task_complete':
        if (!this.tools.size && !this.permissions.size) this.finish();
        break;
      case 'abort':
      case 'session.shutdown':
        for (const child of this.children.values()) child.active = false;
        this.tools.clear();
        this.permissions.clear();
        this.finish();
        break;
      default:
        return;
    }
    this.ready = true;
    const timestamp = stringField(event, 'timestamp');
    if (timestamp) {
      const parsed = /^\d+(?:\.\d+)?$/.test(timestamp) ? Number(timestamp) : Date.parse(timestamp);
      if (Number.isFinite(parsed)) this.lastActivityAt = Math.max(this.lastActivityAt, parsed);
    }
  }

  private message(event: ProjectedEvent): FileMessage | undefined {
    const content = stringField(event, 'data.content.preview')?.trim();
    if (!content) return undefined;
    return {
      content,
      timestamp: stringField(event, 'timestamp') ?? '',
      truncated: event['data.content.preview.truncated'] === true,
    };
  }

  private async bytes(file: FileHandle, start: number, length: number): Promise<Buffer> {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  }

  async refresh(): Promise<boolean> {
    const file = await fs.open(this.transcriptPath, 'r');
    try {
      const stat = await file.stat();
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      let changed =
        identity !== this.identity ||
        stat.size < this.offset ||
        (stat.size === this.offset && stat.mtimeMs !== this.modifiedAt);
      if (!changed && this.offset) {
        const head = await this.bytes(file, 0, this.head.length);
        const anchor = await this.bytes(file, this.offset - this.anchor.length, this.anchor.length);
        changed = !head.equals(this.head) || !anchor.equals(this.anchor);
      }
      if (changed) this.reset();
      this.identity = identity;
      // Snapshot the size: a busy writer cannot make one scan run forever.
      const chunk = Buffer.alloc(READ_CHUNK_BYTES);
      while (this.offset < stat.size) {
        const { bytesRead } = await file.read(
          chunk,
          0,
          Math.min(chunk.length, stat.size - this.offset),
          this.offset,
        );
        if (!bytesRead) {
          this.reset();
          return false;
        }
        this.parser.push(chunk.subarray(0, bytesRead));
        this.offset += bytesRead;
      }
      this.head = await this.bytes(file, 0, Math.min(FILE_ANCHOR_BYTES, this.offset));
      this.anchor = await this.bytes(
        file,
        Math.max(0, this.offset - FILE_ANCHOR_BYTES),
        Math.min(FILE_ANCHOR_BYTES, this.offset),
      );
      this.modifiedAt = stat.mtimeMs;
      return this.ready;
    } finally {
      await file.close();
    }
  }

  snapshot(sessionId: string, cwd: string, title?: string): FileSessionSnapshot {
    const tools = Array.from(this.tools.values(), (tool) => ({ ...tool }));
    const status = this.permissions.size
      ? 'permission'
      : tools.some((tool) => tool.name.toLowerCase() === 'ask_user')
        ? 'input'
        : tools.length
          ? 'active'
          : this.activity;
    return {
      sessionId,
      transcriptPath: this.transcriptPath,
      cwd,
      title,
      status,
      tools,
      lastActivityAt: this.lastActivityAt,
      latestRequest: this.latestRequest,
      latestResponse: this.latestResponse,
      recentTools: this.recentTools.map((tool) => ({ ...tool })),
      context: this.context ? { ...this.context } : undefined,
      children: [...this.children.values()]
        .filter((child) => child.active)
        .map((child): FileChildSnapshot => {
          const snapshot = child.reader.snapshot(child.id, cwd, child.name ?? child.label);
          return {
            id: child.id,
            name: child.name,
            label: child.label,
            status: snapshot.status,
            tools: snapshot.tools,
            latestRequest: snapshot.latestRequest,
            latestResponse: snapshot.latestResponse,
            recentTools: snapshot.recentTools,
            context: snapshot.context,
            children: snapshot.children,
          };
        }),
    };
  }
}

/**
 * Reads Copilot CLI's local session-state without installing hooks or changing
 * settings. A live inuse.<pid>.lock is mandatory; timestamps never expire agents.
 * Unlocked subagent transcripts are deliberately not invented as separate agents.
 *
 * Bootstrap streams the file once, retaining bounded message and tool previews.
 * Malformed records and nesting beyond MAX_JSON_DEPTH are ignored. Preview
 * limits never bound transcript size; unselected fields/results are discarded.
 * Logs without an explicit final/idle signal conservatively remain active.
 */
export class CopilotProvider implements FileSessionProvider {
  readonly id = COPILOT_PROVIDER_ID;
  readonly displayName = COPILOT_DISPLAY_NAME;
  private readonly sessionRoot: string;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readers = new Map<string, SessionReader>();
  private disposed = false;
  private scanning: Promise<readonly FileSessionSnapshot[]> | undefined;

  constructor(options: CopilotProviderOptions = {}) {
    this.sessionRoot =
      options.sessionRoot ??
      path.join(os.homedir(), COPILOT_SESSION_DIRECTORY, COPILOT_SESSION_STATE_DIRECTORY);
    this.isProcessAlive = options.isProcessAlive ?? processAlive;
  }

  scan(): Promise<readonly FileSessionSnapshot[]> {
    if (this.disposed) return Promise.resolve([]);
    if (this.scanning) return this.scanning;
    this.scanning = this.scanSessions()
      .catch((error: unknown) => {
        const cause = error instanceof Error ? error.message : String(error);
        const failure = new Error(`${COPILOT_LOG_PREFIX} Cannot scan local sessions: ${cause}`, {
          cause: error,
        });
        console.error(failure.message);
        throw failure;
      })
      .finally(() => {
        this.scanning = undefined;
      });
    return this.scanning;
  }

  private async live(directory: string): Promise<number | undefined> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = COPILOT_LOCK_PATTERN.exec(entry.name);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid > MAX_PROCESS_ID) continue;
      let contents: string;
      try {
        contents = (await fs.readFile(path.join(directory, entry.name), 'utf8')).trim();
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
        continue;
      }
      if (contents !== match[1]) continue;
      try {
        if (this.isProcessAlive(pid)) return pid;
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot check Copilot lock process ${pid}: ${cause}`, { cause: error });
      }
    }
    return undefined;
  }

  private async scanSessions(): Promise<readonly FileSessionSnapshot[]> {
    let entries;
    try {
      entries = await fs.readdir(this.sessionRoot, { withFileTypes: true });
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
      this.readers.clear();
      return [];
    }
    const liveReaders = new Map<string, SessionReader>();
    const snapshots: FileSessionSnapshot[] = [];
    for (const entry of entries) {
      if (this.disposed) return [];
      if (!entry.isDirectory()) continue;
      const directory = path.join(this.sessionRoot, entry.name);
      try {
        if (!(await this.live(directory))) continue;
        const workspace = metadata(
          await fs.readFile(path.join(directory, COPILOT_WORKSPACE_FILE), 'utf8'),
        );
        if (workspace.id !== entry.name || !workspace.cwd) continue;
        const reader =
          this.readers.get(entry.name) ??
          new SessionReader(path.join(directory, COPILOT_TRANSCRIPT_FILE));
        const ready = await reader.refresh();
        // Bootstrap may be long: recheck the lock before publishing this session.
        const processId = await this.live(directory);
        if (!processId) continue;
        liveReaders.set(entry.name, reader);
        if (ready)
          snapshots.push({
            ...reader.snapshot(entry.name, workspace.cwd, workspace.title),
            processId,
          });
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
      }
    }
    if (this.disposed) return [];
    this.readers = liveReaders;
    return snapshots;
  }

  dispose(): void {
    this.disposed = true;
    this.readers.clear();
  }
}
