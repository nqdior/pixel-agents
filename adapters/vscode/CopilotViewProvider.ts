import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { AgentRuntime } from '../../server/src/agentRuntime.js';
import { AgentStateStore } from '../../server/src/agentStateStore.js';
import { buildAssetCache } from '../../server/src/assetReload.js';
import type { AssetCache } from '../../server/src/clientMessageHandler.js';
import { handleClientMessage } from '../../server/src/clientMessageHandler.js';
import { readConfig } from '../../server/src/configPersistence.js';
import { FileStateAdapter } from '../../server/src/fileStateAdapter.js';
import { readLayoutFromFile, watchLayoutFile } from '../../server/src/layoutPersistence.js';
import { CopilotProvider } from '../../server/src/providers/file/copilot/copilot.js';
import { claudeProvider } from '../../server/src/providers/index.js';
import type { AgentState } from '../../server/src/types.js';
import {
  CONFIG_KEY_AUTO_SPAWN_AGENT,
  CONFIG_KEY_WATCH_ALL_COPILOT,
  COPILOT_TERMINAL_PREFIX,
} from './constants.js';
import { getWebviewContent } from './PixelAgentsViewProvider.js';

/** VS Code transport/terminal adapter; discovery, protocol and rendering stay shared. */
export class CopilotViewProvider implements vscode.WebviewViewProvider {
  private readonly store = new AgentStateStore();
  private readonly runtime = new AgentRuntime(this.store, claudeProvider, { hookProviders: [] });
  private readonly adapter = new FileStateAdapter({
    namespace: 'vscode',
    stateNamespace: 'vscode-copilot',
  });
  private readonly owned = new Map<string, vscode.Terminal>();
  private readonly disposables: vscode.Disposable[] = [];
  private view?: vscode.WebviewView;
  private cache?: AssetCache;
  private started = false;
  private autoSpawnAttempted = false;
  private ready = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.store.setAdapter(this.adapter);
    this.runtime.hooksEnabled.current = false;
    this.runtime.watchAllSessions.current =
      vscode.workspace.getConfiguration().get<boolean>(CONFIG_KEY_WATCH_ALL_COPILOT, false) ||
      this.adapter.getSetting('pixel-agents.watchAllSessions', false);
    for (const terminal of vscode.window.terminals) {
      const match = /^Pixel Copilot ([\da-f-]{36})$/.exec(terminal.name);
      if (match) this.owned.set(match[1], terminal);
    }
    this.store.on('agentAdded', (id, agent) => {
      this.bindTerminal(agent);
      this.send({
        type: 'agentCreated',
        id,
        folderName: agent.folderName,
        isExternal: agent.isExternal,
        isTeammate: agent.leadAgentId !== undefined,
        teammateName: agent.agentName,
        parentAgentId: agent.leadAgentId,
        palette: agent.palette,
        hueShift: agent.hueShift,
      });
    });
    this.store.on('agentRemoved', (id) => this.send({ type: 'agentClosed', id }));
    this.store.on('broadcast', (message) => this.send(message));
    this.disposables.push(
      vscode.window.onDidChangeActiveTerminal((terminal) => {
        for (const [id, agent] of this.store) {
          if (terminal && agent.terminalRef === terminal) this.send({ type: 'agentSelected', id });
        }
      }),
    );
    this.disposables.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        for (const [sessionId, owned] of this.owned) {
          if (owned !== terminal) continue;
          this.owned.delete(sessionId);
          for (const agent of this.store.values()) {
            if (agent.terminalRef === terminal) {
              agent.terminalRef = undefined;
              agent.isExternal = true;
            }
          }
        }
      }),
    );
    this.disposables.push(watchLayoutFile((layout) => this.send({ type: 'layoutLoaded', layout })));
  }

  private send(message: Record<string, unknown>): void {
    if (this.ready) void this.view?.webview.postMessage(message);
  }

  private bindTerminal(agent: AgentState): void {
    const terminal = this.owned.get(agent.sessionId);
    if (terminal) {
      agent.terminalRef = terminal;
      agent.isExternal = false;
    }
  }

  private rootAgent(id?: number): AgentState {
    let agent = id === undefined ? undefined : this.store.get(id);
    if (!agent) throw new Error('The Copilot session is no longer available.');
    while (agent.leadAgentId !== undefined) {
      agent = this.store.get(agent.leadAgentId);
      if (!agent) throw new Error('The parent Copilot session is no longer available.');
    }
    return agent;
  }

  private async terminalAction(
    action: 'launch' | 'open' | 'focus',
    id?: number,
    folderPath?: string,
  ): Promise<void> {
    const agent = action === 'launch' ? undefined : this.rootAgent(id);
    if (agent?.terminalRef) {
      agent.terminalRef.show();
      return;
    }
    if (action === 'focus') {
      throw new Error(
        'This session belongs to another terminal. Use Open session in terminal to attach explicitly.',
      );
    }
    const cwd =
      agent?.projectDir ??
      folderPath ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      os.homedir();
    if (!(await fs.stat(cwd)).isDirectory())
      throw new Error('The working directory does not exist.');
    const sessionId = agent?.sessionId ?? randomUUID();
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(sessionId)) {
      throw new Error('A valid session UUID is required.');
    }
    const terminal = vscode.window.createTerminal({
      name: `${COPILOT_TERMINAL_PREFIX} ${sessionId}`,
      cwd,
    });
    this.owned.set(sessionId, terminal);
    if (agent) this.bindTerminal(agent);
    terminal.show();
    terminal.sendText(`copilot --session-id ${sessionId}`, true);
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true };
    const assetsRoot = path.join(this.context.extensionPath, 'dist');
    this.cache ??= await buildAssetCache(assetsRoot, readConfig().externalAssetDirectories);
    const receive = view.webview.onDidReceiveMessage((message: Record<string, unknown>) => {
      void this.receive(message).catch((error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        console.error('[Pixel Agents] Copilot adapter:', text);
        void vscode.window.showErrorMessage(`Pixel Agents: ${text}`);
      });
    });
    view.onDidDispose(() => {
      receive.dispose();
      this.ready = false;
    });
    view.webview.html = getWebviewContent(view.webview, this.context.extensionUri);
  }

  private async receive(message: Record<string, unknown>): Promise<void> {
    if (message.type === 'webviewReady') {
      this.ready = true;
      if (!this.started) {
        this.started = true;
        await this.runtime.startFileProvider(
          new CopilotProvider(),
          (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
        );
      }
    }
    if (message.type === 'openSessionsFolder') {
      await vscode.env.openExternal(
        vscode.Uri.file(path.join(os.homedir(), '.copilot', 'session-state')),
      );
      return;
    }
    if (message.type === 'addExternalAssetDirectory') {
      const chosen = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
      });
      if (!chosen?.[0]) return;
      message = { ...message, path: chosen[0].fsPath };
    }
    if (message.type === 'exportLayout') {
      await this.exportDefaultLayout();
      return;
    }
    if (message.type === 'importLayout') {
      const selected = await vscode.window.showOpenDialog({
        filters: { JSON: ['json'] },
        canSelectMany: false,
      });
      if (!selected?.[0]) return;
      const layout: unknown = JSON.parse(await fs.readFile(selected[0].fsPath, 'utf8'));
      if (
        !layout ||
        typeof layout !== 'object' ||
        !('version' in layout) ||
        layout.version !== 1 ||
        !('tiles' in layout) ||
        !Array.isArray(layout.tiles)
      )
        throw new Error('Invalid layout file.');
      message = { type: 'saveLayout', layout };
    }
    handleClientMessage(message, (reply) => this.send(reply), {
      store: this.store,
      runtime: this.runtime,
      cache: this.cache ?? null,
      settingsNamespace: 'vscode',
      privileged: true,
      onTerminalAction: (action, id, folderPath) => this.terminalAction(action, id, folderPath),
      onReloadAssets: async () => {
        this.cache = await buildAssetCache(
          path.join(this.context.extensionPath, 'dist'),
          readConfig().externalAssetDirectories,
        );
        await this.receive({ type: 'webviewReady' });
      },
    });
    if (message.type === 'webviewReady') {
      this.send({
        type: 'workspaceFolders',
        folders: (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
          name: folder.name,
          path: folder.uri.fsPath,
        })),
      });
      if (!this.autoSpawnAttempted) {
        this.autoSpawnAttempted = true;
        if (
          this.store.size === 0 &&
          vscode.workspace.getConfiguration().get<boolean>(CONFIG_KEY_AUTO_SPAWN_AGENT, false)
        ) {
          await this.terminalAction('launch');
        }
      }
    }
  }

  async exportDefaultLayout(): Promise<void> {
    const layout = readLayoutFromFile();
    if (!layout) {
      void vscode.window.showWarningMessage('Pixel Agents: No saved layout to export.');
      return;
    }
    const uri = await vscode.window.showSaveDialog({ filters: { JSON: ['json'] } });
    if (uri) await fs.writeFile(uri.fsPath, JSON.stringify(layout, null, 2), 'utf8');
  }

  dispose(): void {
    this.ready = false;
    for (const disposable of this.disposables) disposable.dispose();
    this.runtime.dispose();
    this.store.dispose();
  }
}
