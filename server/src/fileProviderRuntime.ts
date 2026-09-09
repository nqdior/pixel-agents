import * as path from 'node:path';

import type {
  FileChildSnapshot,
  FileSessionProvider,
  FileSessionSnapshot,
} from '../../core/src/fileProvider.js';
import { agentDetailsMessage } from './agentDetails.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  DEFAULT_MAX_CONTEXT_TOKENS,
  FILE_PROVIDER_SCAN_INTERVAL_MS,
  FILE_PROVIDER_THINKING_TOOL_ID,
} from './constants.js';
import type { DismissalTracker } from './dismissalTracker.js';
import { sendFileSubagentActivity } from './fileSubagents.js';
import { assignPaletteIfNeeded } from './paletteAssigner.js';
import { pathsMatch } from './pathKey.js';
import type { AgentState } from './types.js';

interface FileProviderRuntimeOptions {
  store: AgentStateStore;
  provider: FileSessionProvider;
  workspacePaths: readonly string[];
  watchAllSessions: { current: boolean };
  dismissals: DismissalTracker;
  removeAgent: (id: number) => void;
  onReadingToolsChanged: () => void;
}

function displayChildren(children: readonly FileChildSnapshot[]): FileChildSnapshot[] {
  return children.flatMap((child) =>
    child.name
      ? [child]
      : [
          { ...child, children: [] },
          ...displayChildren(child.children ?? []).map((nested) => ({
            ...nested,
            label: `${child.label} / ${nested.label}`,
          })),
        ],
  );
}

/** Read-only providers own discovery; the shared store still owns every character. */
export class FileProviderRuntime {
  readonly readingTools = new Set<string>();
  private readonly tracked = new Map<string, number>();
  private readonly signatures = new Map<string, string>();
  private readonly dismissed = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private disposed = false;
  private lastError?: string;
  private readonly namedChildren = new Map<string, number>();
  private readonly childSignatures = new Map<string, string>();
  private readonly dismissedChildren = new Set<string>();
  private childRevision = 0;

  constructor(private readonly options: FileProviderRuntimeOptions) {}

  async start(): Promise<void> {
    await this.scan();
    this.schedule();
  }

  scan(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.pending ??= this.reconcile().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private schedule(): void {
    if (this.disposed) return;
    this.timer = setTimeout(() => {
      void this.scan()
        .then(() => {
          if (this.lastError) console.log('[Pixel Agents] Session monitoring recovered.');
          this.lastError = undefined;
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (message !== this.lastError) {
            console.error(
              `[Pixel Agents] ${this.options.provider.displayName} scan failed: ${message}`,
            );
            this.lastError = message;
          }
        })
        .finally(() => this.schedule());
    }, FILE_PROVIDER_SCAN_INTERVAL_MS);
  }

  private async reconcile(): Promise<void> {
    const snapshots = await this.options.provider.scan();
    if (this.disposed) return;
    const { store, provider, watchAllSessions, workspacePaths, dismissals } = this.options;
    const live = new Set(snapshots.map((session) => session.sessionId));
    for (const sessionId of this.dismissed) {
      if (!live.has(sessionId)) this.dismissed.delete(sessionId);
    }
    const visible = new Set<string>();
    const visibleChildren = new Set<string>();
    for (const session of snapshots) {
      if (
        !watchAllSessions.current &&
        !workspacePaths.some((cwd) => pathsMatch(cwd, session.cwd))
      ) {
        continue;
      }
      visible.add(session.sessionId);
      let id = this.tracked.get(session.sessionId);
      if (id !== undefined && !store.has(id)) {
        this.tracked.delete(session.sessionId);
        this.signatures.delete(session.sessionId);
        if (dismissals.isDismissed(session.transcriptPath)) this.dismissed.add(session.sessionId);
        id = undefined;
      }
      if (this.dismissed.has(session.sessionId)) continue;
      if (id === undefined) {
        if (dismissals.isDismissed(session.transcriptPath)) {
          this.dismissed.add(session.sessionId);
          continue;
        }
        id = store.nextAgentId.current++;
        const agent: AgentState = {
          id,
          sessionId: session.sessionId,
          providerId: provider.id,
          fileProvider: true,
          isExternal: true,
          projectDir: session.cwd,
          jsonlFile: session.transcriptPath,
          folderName: path.basename(session.cwd) || session.cwd,
          agentName: this.label(session),
          fileOffset: 0,
          lineBuffer: '',
          activeToolIds: new Set(),
          activeToolStatuses: new Map(),
          activeToolNames: new Map(),
          activeSubagentToolIds: new Map(),
          activeSubagentToolNames: new Map(),
          backgroundAgentToolIds: new Set(),
          isWaiting: false,
          permissionSent: false,
          hadToolsInTurn: false,
          lastDataAt: session.lastActivityAt,
          linesProcessed: 0,
          seenUnknownRecordTypes: new Set(),
          hookDelivered: false,
          contextTokens: 0,
          maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
        };
        assignPaletteIfNeeded(agent, store);
        store.set(id, agent);
        this.tracked.set(session.sessionId, id);
      }
      const agent = store.get(id)!;
      agent.lastDataAt = session.lastActivityAt;
      const signature = JSON.stringify([
        session.status,
        session.title,
        session.cwd,
        session.tools,
        session.latestRequest,
        session.latestResponse,
        session.recentTools,
        session.context,
        session.children,
      ]);
      if (this.signatures.get(session.sessionId) !== signature) {
        this.applySnapshot(agent, session);
        this.signatures.set(session.sessionId, signature);
      }
      this.reconcileChildren(agent, session.children ?? [], visibleChildren);
    }
    for (const [key, id] of this.namedChildren) {
      if (visibleChildren.has(key)) continue;
      this.options.removeAgent(id);
      this.namedChildren.delete(key);
      this.childSignatures.delete(key);
      this.dismissedChildren.delete(key);
    }
    for (const [sessionId, id] of this.tracked) {
      if (visible.has(sessionId)) continue;
      this.options.removeAgent(id);
      this.tracked.delete(sessionId);
      this.signatures.delete(sessionId);
    }
  }

  private label(session: FileSessionSnapshot): string {
    return `${this.options.provider.displayName}: ${session.title || session.sessionId.slice(0, 8)}`;
  }

  private applySnapshot(agent: AgentState, session: FileSessionSnapshot): void {
    const { store } = this.options;
    const id = agent.id;
    agent.details = session;
    agent.projectDir = session.cwd;
    agent.folderName = path.basename(session.cwd) || session.cwd;
    if (
      agent.contextTokens !== (session.context?.usedTokens ?? 0) ||
      agent.maxContextTokens !== (session.context?.maxTokens ?? 0)
    ) {
      agent.contextTokens = session.context?.usedTokens ?? 0;
      agent.maxContextTokens = session.context?.maxTokens ?? 0;
      store.broadcast({
        type: 'agentContextUsage',
        id,
        contextTokens: agent.contextTokens,
        maxContextTokens: agent.maxContextTokens,
      });
    }
    store.broadcast({ ...agentDetailsMessage(id, session) });
    agent.agentName = this.label(session);
    store.broadcast({
      type: 'agentTeamInfo',
      id,
      agentName: agent.agentName,
      isTeamLead: agent.isTeamLead,
      leadAgentId: agent.leadAgentId,
    });
    if (session.status === 'done' || (agent.isWaiting && session.status === 'active')) {
      agent.activeToolIds.clear();
      agent.activeToolStatuses.clear();
      agent.activeToolNames.clear();
      store.broadcast({ type: 'agentToolsClear', id });
    }
    const tools =
      session.status === 'active' && session.tools.length === 0
        ? [
            {
              id: `${FILE_PROVIDER_THINKING_TOOL_ID}:${session.lastActivityAt}`,
              name: 'Thinking',
              status: agent.leadAgentId === undefined ? 'Thinking' : 'Working',
              isReading: false,
            },
          ]
        : session.tools;
    let capabilitiesChanged = false;
    for (const tool of tools) {
      if (tool.isReading && !this.readingTools.has(tool.name)) {
        this.readingTools.add(tool.name);
        capabilitiesChanged = true;
      }
    }
    if (capabilitiesChanged) this.options.onReadingToolsChanged();
    const liveTools = new Set(tools.map((tool) => tool.id));
    for (const toolId of agent.activeToolIds) {
      if (liveTools.has(toolId)) continue;
      agent.activeToolIds.delete(toolId);
      agent.activeToolStatuses.delete(toolId);
      agent.activeToolNames.delete(toolId);
      store.broadcast({ type: 'agentToolDone', id, toolId });
    }
    for (const tool of tools) {
      if (
        agent.activeToolStatuses.get(tool.id) === tool.status &&
        agent.activeToolNames.get(tool.id) === tool.name
      )
        continue;
      agent.activeToolIds.add(tool.id);
      agent.activeToolStatuses.set(tool.id, tool.status);
      agent.activeToolNames.set(tool.id, tool.name);
      store.broadcast({
        type: 'agentToolStart',
        id,
        toolId: tool.id,
        toolName: tool.name,
        status: tool.status,
        permissionActive: session.status === 'permission',
      });
    }
    const wasWaiting = agent.isWaiting;
    const wasInput = agent.awaitingInput;
    const hadPermission = agent.permissionSent;
    agent.isWaiting = session.status === 'done' || session.status === 'input';
    agent.awaitingInput = session.status === 'input';
    agent.permissionSent = session.status === 'permission';
    if (hadPermission && !agent.permissionSent) {
      store.broadcast({ type: 'agentToolPermissionClear', id });
    }
    if (agent.permissionSent && !hadPermission) {
      store.broadcast({ type: 'agentToolPermission', id });
    }
    if (
      agent.isWaiting !== wasWaiting ||
      agent.awaitingInput !== wasInput ||
      !this.signatures.has(session.sessionId)
    ) {
      store.broadcast({
        type: 'agentStatus',
        id,
        status: agent.isWaiting ? 'waiting' : 'active',
        awaitingInput: agent.awaitingInput,
      });
    }
  }

  private reconcileChildren(
    parent: AgentState,
    children: readonly FileChildSnapshot[],
    visible: Set<string>,
  ): void {
    children = displayChildren(children);
    const { store } = this.options;
    parent.fileSubagents ??= new Map();
    const unnamedIds = new Set(children.filter((child) => !child.name).map((child) => child.id));
    for (const [id] of parent.fileSubagents) {
      if (unnamedIds.has(id)) continue;
      store.broadcast({ type: 'subagentClear', id: parent.id, parentToolId: id });
      parent.fileSubagents.delete(id);
      this.childSignatures.delete(`${parent.id}:${id}`);
    }
    const isTeamLead = children.some((child) => !!child.name);
    if (!!parent.isTeamLead !== isTeamLead) {
      parent.isTeamLead = isTeamLead;
      store.broadcast({
        type: 'agentTeamInfo',
        id: parent.id,
        isTeamLead,
        agentName: parent.agentName,
        leadAgentId: parent.leadAgentId,
      });
    }
    for (const child of children) {
      const key = `${parent.id}:${child.id}`;
      if (child.name) {
        visible.add(key);
        let id = this.namedChildren.get(key);
        if (this.dismissedChildren.has(key)) continue;
        if (id !== undefined && !store.has(id)) {
          this.dismissedChildren.add(key);
          continue;
        }
        if (id === undefined || !store.has(id)) {
          id = store.nextAgentId.current++;
          const agent: AgentState = {
            ...parent,
            id,
            sessionId: `${parent.sessionId}:${child.id}`,
            agentName: child.name,
            leadAgentId: parent.id,
            isTeamLead: false,
            spawnToolUseId: child.id,
            details: undefined,
            fileSubagents: new Map(),
            isExternal: true,
            terminalRef: undefined,
            activeToolIds: new Set(),
            activeToolStatuses: new Map(),
            activeToolNames: new Map(),
            activeSubagentToolIds: new Map(),
            activeSubagentToolNames: new Map(),
            backgroundAgentToolIds: new Set(),
            isWaiting: false,
            permissionSent: false,
            awaitingInput: false,
            contextTokens: 0,
            maxContextTokens: 0,
            palette: undefined,
            hueShift: undefined,
          };
          assignPaletteIfNeeded(agent, store);
          store.set(id, agent);
          this.namedChildren.set(key, id);
        }
        const agent = store.get(id)!;
        const signature = JSON.stringify(child);
        if (this.childSignatures.get(key) !== signature) {
          this.applySnapshot(agent, {
            ...child,
            sessionId: agent.sessionId,
            transcriptPath: parent.jsonlFile,
            cwd: parent.projectDir,
            title: child.name,
            lastActivityAt: parent.lastDataAt,
          });
          store.broadcast({
            type: 'agentTeamInfo',
            id,
            agentName: child.name,
            leadAgentId: parent.id,
            isTeamLead: agent.isTeamLead,
          });
          agent.agentName = child.name;
          this.childSignatures.set(key, signature);
        }
        this.reconcileChildren(agent, child.children ?? [], visible);
      } else {
        const signature = JSON.stringify(child);
        if (this.childSignatures.get(key) === signature) continue;
        const activity: FileChildSnapshot = child.tools.length
          ? child
          : {
              ...child,
              tools: [
                {
                  id: `${child.id}:activity:${++this.childRevision}`,
                  name: 'Thinking',
                  status: `Subtask: ${child.label}`,
                  isReading: false,
                },
              ],
            };
        const nextIds = new Set(activity.tools.map((tool) => tool.id));
        for (const tool of parent.fileSubagents.get(child.id)?.tools ?? []) {
          if (!nextIds.has(tool.id))
            store.broadcast({
              type: 'subagentToolDone',
              id: parent.id,
              parentToolId: child.id,
              toolId: tool.id,
            });
        }
        for (const tool of activity.tools) {
          if (tool.isReading && !this.readingTools.has(tool.name)) {
            this.readingTools.add(tool.name);
            this.options.onReadingToolsChanged();
          }
        }
        parent.fileSubagents.set(child.id, activity);
        sendFileSubagentActivity((message) => store.broadcast(message), parent.id, activity);
        this.childSignatures.set(key, signature);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.options.provider.dispose();
  }
}
