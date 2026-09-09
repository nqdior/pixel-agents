import type { FileChildSnapshot } from '../../core/src/fileProvider.js';

export function sendFileSubagentActivity(
  send: (message: Record<string, unknown>) => void,
  parentId: number,
  child: FileChildSnapshot,
): void {
  for (const tool of child.tools) {
    send({
      type: 'subagentToolStart',
      id: parentId,
      parentToolId: child.id,
      toolId: tool.id,
      toolName: tool.name,
      status: tool.status,
      label: child.label,
    });
    if (child.status === 'done' || child.status === 'input') {
      send({ type: 'subagentToolDone', id: parentId, parentToolId: child.id, toolId: tool.id });
    }
  }
  if (child.status === 'permission') {
    send({ type: 'subagentToolPermission', id: parentId, parentToolId: child.id });
  }
}
