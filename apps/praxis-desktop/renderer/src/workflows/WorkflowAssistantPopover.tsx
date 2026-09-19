import { useEffect, useRef, useState } from 'react';
import type { WorkflowDefinition } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { Markdown } from '../ui/Markdown';

interface WorkflowAssistantPopoverProps {
  projectId: string;
  definition: WorkflowDefinition;
  onWorkflowChange: (definition: WorkflowDefinition) => void;
  onSaved?: () => void;
}

interface Message {
  role: 'user' | 'assistant';
  text: string;
}

export function WorkflowAssistantPopover({ projectId, definition, onWorkflowChange, onSaved }: WorkflowAssistantPopoverProps) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages, busy]);

  const submit = async () => {
    const text = question.trim();
    if (!text || busy) return;
    setQuestion('');
    setError(undefined);
    setMessages(current => [...current, { role: 'user', text }]);
    setBusy(true);
    try {
      const result = await window.praxis.workflows.assistant(projectId, definition, text, messages);
      if (result.workflow) {
        onWorkflowChange(result.workflow);
        onSaved?.();
      }
      setMessages(current => [...current, { role: 'assistant', text: result.message }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`workflow-assistant${open ? ' is-open' : ''}`} data-testid="workflow-assistant">
      <section className="workflow-assistant-panel" aria-label="Workflow assistant">
        <header className="workflow-assistant-header">
          <div>
            <strong><Icon name="sparkles" size={14} /> Workflow assistant</strong>
            <span>Questions, verification, and workflow changes only</span>
          </div>
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Close workflow assistant" onClick={() => setOpen(false)}>
            <Icon name="close" size={13} />
          </button>
        </header>

        <div className="workflow-assistant-messages" ref={scrollRef} data-testid="workflow-assistant-messages">
          {messages.length === 0 && (
            <div className="workflow-assistant-empty">
              <Icon name="sparkles" size={18} />
              <p>Ask how this workflow works, ask me to verify it, or request a workflow change.</p>
              <small>This assistant cannot access tickets, files, terminals, settings, or unrelated tasks.</small>
            </div>
          )}
          {messages.map((message, index) => (
            <div key={`${message.role}-${index}`} className={`workflow-assistant-message is-${message.role}`}>
              {message.role === 'assistant' ? <Markdown text={message.text} /> : <span>{message.text}</span>}
            </div>
          ))}
          {busy && <div className="workflow-assistant-message is-assistant"><span className="placeholder-text">Thinking…</span></div>}
        </div>

        {error && <div className="error-banner workflow-assistant-error">{error}</div>}
        <div className="composer workflow-assistant-composer">
          <textarea
            value={question}
            className="composer-input workflow-assistant-question"
            onChange={event => setQuestion(event.target.value)}
            placeholder="Ask about this workflow…"
            aria-label="Workflow assistant question"
            rows={2}
            disabled={busy}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <div className="composer-controls">
            <span className="spacer" />
            <button type="button" className="composer-send" aria-label="Ask workflow assistant" disabled={!question.trim() || busy} onClick={() => void submit()}>
              <Icon name="arrow-up" size={13} />
            </button>
          </div>
        </div>
      </section>

      <button
        type="button"
        className="workflow-assistant-launcher"
        aria-label={open ? 'Workflow assistant open' : 'Open workflow assistant'}
        aria-expanded={open}
        data-testid="workflow-assistant-launcher"
        onClick={() => setOpen(current => !current)}
      >
        <Icon name="sparkles" size={16} />
      </button>
    </div>
  );
}
