export const COPILOT_PROVIDER_ID = 'copilot';
export const COPILOT_DISPLAY_NAME = 'GitHub Copilot';
export const COPILOT_SESSION_DIRECTORY = '.copilot';
export const COPILOT_SESSION_STATE_DIRECTORY = 'session-state';
export const COPILOT_WORKSPACE_FILE = 'workspace.yaml';
export const COPILOT_TRANSCRIPT_FILE = 'events.jsonl';
export const COPILOT_LOCK_PATTERN = /^inuse\.([1-9]\d*)\.lock$/;
export const COPILOT_LOG_PREFIX = '[CopilotProvider]';

export const READ_CHUNK_BYTES = 64 * 1024;
export const FILE_ANCHOR_BYTES = 128;
export const MAX_JSON_DEPTH = 128;
export const MAX_SCALAR_LENGTH = 16 * 1024;
export const MAX_PROCESS_ID = 0x7fffffff;
export const PREVIEW_CHAR_LIMIT = 2000;
export const ACTIVITY_LABEL_LIMIT = 96;
export const RECENT_TOOL_LIMIT = 8;
export const PREVIEW_FIELDS: ReadonlySet<string> = new Set([
  'data.content',
  'data.arguments',
  'data.result.content',
  'data.agentDisplayName',
  'data.agentDescription',
  ...[
    'path',
    'file_path',
    'filePath',
    'paths',
    'command',
    'description',
    'message',
    'query',
    'pattern',
    'url',
    'prompt',
    'name',
    'agent_type',
    'shellId',
    'agent_id',
    'input',
    'patch',
    'owner',
    'repo',
    'mode',
    'skill',
  ].map((key) => `data.arguments.${key}`),
]);

export const READING_TOOLS: ReadonlySet<string> = new Set([
  'view',
  'read',
  'read_file',
  'read_file_contents',
  'get_file_contents',
  'rg',
  'grep',
  'glob',
  'ls',
  'list_directory',
  'search',
  'search_code',
  'web_fetch',
  'web_search',
  'fetch',
  'read_powershell',
  'read_bash',
  'read_agent',
  'list_agents',
  'list_powershell',
  'list_bash',
]);

export const EVENT_FIELDS: ReadonlySet<string> = new Set([
  'type',
  'timestamp',
  'data.toolCallId',
  'data.toolName',
  'data.requestId',
  'data.parentToolCallId',
  'data.phase',
  'data.turnId',
  'data.context.cwd',
  'data.cwd',
  'data.permissionRequest.toolCallId',
  'data.success',
  'agentId',
  'data.agentId',
  'data.agentName',
  'data.agentType',
  'data.executionMode',
  'data.model',
  'data.newModel',
  'data.modelCall.model',
]);

export const NUMERIC_FIELDS: ReadonlySet<string> = new Set([
  'data.currentTokens',
  'data.tokenLimit',
  'data.modelInfo.capabilities.limits.max_context_window_tokens',
  'data.responseUsage.prompt_tokens',
  'data.responseUsage.completion_tokens',
]);
