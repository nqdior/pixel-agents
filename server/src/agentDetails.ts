import type { FileSessionSnapshot } from '../../core/src/fileProvider.js';
import type { AgentDetails } from '../../core/src/messages.js';

export function agentDetailsMessage(id: number, session: FileSessionSnapshot): AgentDetails {
  return {
    type: 'agentDetails',
    id,
    details: {
      sessionId: session.sessionId,
      cwd: session.cwd,
      title: session.title,
      status: session.status,
      tools: session.tools.map((tool) => ({ ...tool })),
      recentTools: (session.recentTools ?? []).map((tool) => ({ ...tool })),
      lastActivityAt: session.lastActivityAt,
      latestRequest: session.latestRequest,
      latestResponse: session.latestResponse,
      context: session.context,
    },
  };
}
