import { useState } from 'react';

import type { SessionDetails, SessionMessage, SessionTool } from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';

interface SessionDetailsPanelProps {
  sessions: Record<number, SessionDetails>;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onClose: () => void;
  terminalControls?: boolean;
}

const STATUS_LABELS = {
  active: 'Working',
  done: 'Done',
  input: 'Waiting for input',
  permission: 'Needs approval',
} as const;

function MessagePreview({ title, message }: { title: string; message?: SessionMessage }) {
  if (!message) return null;
  return (
    <section className="border-t-2 border-border pt-10">
      <h3 className="text-accent-bright text-sm mb-6">{title}</h3>
      {message.timestamp && (
        <time className="text-text-muted text-xs" dateTime={message.timestamp}>
          {new Date(message.timestamp).toLocaleTimeString()}
        </time>
      )}
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed mt-6">
        {message.content}
      </p>
      {message.truncated && (
        <p className="text-text-muted text-xs mt-6">Preview truncated (2,000 characters).</p>
      )}
    </section>
  );
}

function ToolDetails({ tool }: { tool: SessionTool }) {
  return (
    <article className="border-2 border-border p-8">
      <div className="flex justify-between gap-8 text-xs text-text-muted">
        <span className="break-all">{tool.name}</span>
        <span>
          {tool.outcome === 'error' ? 'Failed' : tool.outcome === 'done' ? 'Done' : 'Running'}
        </span>
      </div>
      <p className="text-sm break-words mt-6">{tool.status}</p>
      {tool.details && (
        <pre className="whitespace-pre-wrap break-all text-xs leading-relaxed mt-6">
          {tool.details}
        </pre>
      )}
    </article>
  );
}

export function SessionDetailsPanel({
  sessions,
  selectedId,
  onSelect,
  onClose,
  terminalControls = false,
}: SessionDetailsPanelProps) {
  const [listOpen, setListOpen] = useState(false);
  const entries = Object.entries(sessions);
  if (!entries.length) return null;
  const selected = selectedId === null ? undefined : sessions[selectedId];
  const open = !!selected || listOpen;
  return (
    <aside className="absolute top-8 right-8 z-45 max-w-[calc(100vw-1rem)]">
      {!open ? (
        <Button size="md" onClick={() => setListOpen(true)}>
          Sessions ({entries.length})
        </Button>
      ) : (
        <section
          aria-label="Session details"
          data-testid="session-details"
          className="bg-bg border-2 border-border shadow-pixel w-[calc(100vw-1rem)] max-w-md max-h-[calc(100dvh-6rem)] overflow-y-auto p-12 space-y-12"
        >
          <header className="flex items-center justify-between gap-12">
            <h2 className="text-accent-bright">Session details</h2>
            <Button
              size="sm"
              aria-label="Close session details"
              onClick={() => {
                setListOpen(false);
                onClose();
              }}
            >
              x
            </Button>
          </header>
          <label className="block text-xs text-text-muted">
            Session
            <select
              aria-label="Select session"
              value={selectedId ?? ''}
              className="block w-full min-w-0 mt-6 bg-bg border-2 border-border p-6 text-text"
              onChange={(event) => onSelect(Number(event.target.value))}
            >
              <option value="" disabled>
                Select a character or session
              </option>
              {entries.map(([id, session]) => (
                <option key={id} value={id}>
                  {session.title || session.sessionId.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          {selected ? (
            <>
              <div className="space-y-6">
                <h3 className="text-sm break-words">{selected.title || selected.sessionId}</h3>
                <p className="text-accent-bright text-xs">{STATUS_LABELS[selected.status]}</p>
                <p className="text-text-muted text-xs break-all">{selected.cwd}</p>
                <p className="text-text-muted text-xs break-all">Session: {selected.sessionId}</p>
                {terminalControls && selectedId !== null && (
                  <div className="flex flex-wrap gap-6">
                    <Button
                      size="sm"
                      onClick={() => transport.send({ type: 'openAgentTerminal', id: selectedId })}
                    >
                      Open session in terminal
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => transport.send({ type: 'focusAgent', id: selectedId })}
                    >
                      Focus terminal
                    </Button>
                  </div>
                )}
                {selected.context ? (
                  <div className="text-xs space-y-6">
                    <p>
                      Context: {selected.context.usedTokens.toLocaleString()} /{' '}
                      {selected.context.maxTokens.toLocaleString()} tokens (
                      {Math.round((selected.context.usedTokens / selected.context.maxTokens) * 100)}
                      %)
                    </p>
                    <meter
                      className="w-full"
                      min={0}
                      max={selected.context.maxTokens}
                      value={selected.context.usedTokens}
                      aria-label="Context usage"
                    />
                  </div>
                ) : (
                  <p className="text-text-muted text-xs">
                    Context usage: not reported by this CLI session.
                  </p>
                )}
              </div>
              <section className="space-y-8">
                <h3 className="text-accent-bright text-sm">Current activity</h3>
                {selected.tools.length ? (
                  selected.tools.map((tool) => <ToolDetails key={tool.id} tool={tool} />)
                ) : (
                  <p className="text-sm">
                    {selected.status === 'active'
                      ? 'Thinking / preparing the next action'
                      : STATUS_LABELS[selected.status]}
                  </p>
                )}
              </section>
              <MessagePreview title="Latest request" message={selected.latestRequest} />
              <MessagePreview title="Latest response" message={selected.latestResponse} />
              {!!selected.recentTools.length && (
                <section className="space-y-8 border-t-2 border-border pt-10">
                  <h3 className="text-accent-bright text-sm">Recent actions</h3>
                  {selected.recentTools.map((tool) => (
                    <ToolDetails key={tool.id} tool={tool} />
                  ))}
                </section>
              )}
              <p className="text-text-muted text-xs">
                Local, read-only previews. Tool output and internal reasoning are not included.
              </p>
            </>
          ) : (
            <p className="text-sm">
              Select a session to see its request, response, files and commands.
            </p>
          )}
        </section>
      )}
    </aside>
  );
}
