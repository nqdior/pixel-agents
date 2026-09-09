/** A currently executing tool; status is a safe, human-readable activity label. */
export interface FileTool {
  id: string;
  name: string;
  status: string;
  isReading: boolean;
  details?: string;
}

export interface FileMessage {
  content: string;
  timestamp: string;
  truncated: boolean;
}

export interface FileToolResult extends FileTool {
  outcome: 'done' | 'error';
}

export interface FileContextUsage {
  usedTokens: number;
  maxTokens: number;
  model?: string;
}

export interface FileChildSnapshot {
  id: string;
  name?: string;
  label: string;
  status: FileSessionSnapshot['status'];
  tools: readonly FileTool[];
  latestRequest?: FileMessage;
  latestResponse?: FileMessage;
  recentTools?: readonly FileToolResult[];
  context?: FileContextUsage;
  children?: readonly FileChildSnapshot[];
}

export interface FileSessionSnapshot {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  title?: string;
  status: 'active' | 'done' | 'input' | 'permission';
  tools: readonly FileTool[];
  lastActivityAt: number;
  latestRequest?: FileMessage;
  latestResponse?: FileMessage;
  recentTools?: readonly FileToolResult[];
  context?: FileContextUsage;
  children?: readonly FileChildSnapshot[];
  processId?: number;
}

/** Read-only discovery, independent of hooks, terminals, and workspace filtering. */
export interface FileSessionProvider {
  readonly id: string;
  readonly displayName: string;
  scan(): Promise<readonly FileSessionSnapshot[]>;
  dispose(): void;
}
