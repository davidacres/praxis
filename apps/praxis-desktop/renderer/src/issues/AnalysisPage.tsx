import { useCallback, useEffect, useRef, useState } from 'react';
import type { AiAnalysisState, AiProvider, IssueDetails } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { Markdown } from '../ui/Markdown';

interface AnalysisPageProps {
  issueKey: string;
  connectionId?: string;
  provider?: AiProvider;
  model?: string;
  onClose: () => void;
}

/**
 * Per-issue analysis chat — the desktop port of the extension's Issue Analysis
 * panel. The conversation persists in the main process (`ai-analysis.json`);
 * confirming the analysis satisfies the delegation gate when it's enabled.
 */
export function AnalysisPage({ issueKey, connectionId, provider, model, onClose }: AnalysisPageProps) {
  const [issue, setIssue] = useState<IssueDetails | undefined>();
  const [state, setState] = useState<AiAnalysisState | undefined>();
  const [question, setQuestion] = useState('');
  const [error, setError] = useState<string | undefined>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoStartedIssueRef = useRef<string | undefined>();

  useEffect(() => {
    setIssue(undefined);
    setState(undefined);
    setError(undefined);
    autoStartedIssueRef.current = undefined;
    void window.ticketManager.issue.get(issueKey, connectionId).then(setIssue);
    void window.ticketManager.ai.getAnalysis(issueKey).then(setState);
    const unsubscribe = window.ticketManager.ai.onAnalysisChanged(next => {
      if (next.issueKey === issueKey) {
        setState(next);
      }
    });
    return unsubscribe;
  }, [issueKey, connectionId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [state?.messages.length, state?.busy]);

  const submit = useCallback(async (text: string) => {
    setError(undefined);
    setQuestion('');
    try {
      await window.ticketManager.ai.submitAnalysis(issueKey, text, connectionId, provider, model);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [issueKey, connectionId, provider, model]);

  // Entering analysis from the state-aware ticket header is an action, not
  // another navigation step: run the configured base analysis immediately.
  useEffect(() => {
    if (
      !state ||
      state.busy ||
      state.messages.length > 0 ||
      autoStartedIssueRef.current === issueKey
    ) {
      return;
    }
    autoStartedIssueRef.current = issueKey;
    void submit('');
  }, [state, issueKey, submit]);

  const busy = state?.busy ?? false;
  const messages = state?.messages ?? [];

  return (
    <div className="ai-tool-page" data-testid="analysis-page">
      <div className="ai-tool-header">
        <Icon name="robot" size={14} />
        <h3>Analysis — {issueKey}</h3>
        <span className="detail-meta">{issue?.summary ?? ''}</span>
        {(provider || model) && (
          <span className="detail-meta" data-testid="analysis-runtime">
            {[provider, model].filter(Boolean).join(' · ')}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button className="icon-btn icon-btn-sm" aria-label="Close analysis" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>

      <div className="ai-tool-actions">
        {state && (
          <button
            className={`btn${state.confirmed ? ' btn-primary' : ''}`}
            data-testid="analysis-confirm-btn"
            disabled={busy}
            onClick={() =>
              void window.ticketManager.ai
                .setAnalysisConfirmed(issueKey, !state.confirmed)
                .catch(err => setError(err instanceof Error ? err.message : String(err)))
            }
          >
            <Icon name="check-square" size={13} />
            {state.confirmed ? 'Analysis confirmed' : 'Confirm analysis'}
          </button>
        )}
        {messages.length > 0 && (
          <button
            className="btn"
            data-testid="analysis-clear-btn"
            disabled={busy}
            onClick={() =>
              void window.ticketManager.ai
                .clearAnalysis(issueKey)
                .catch(err => setError(err instanceof Error ? err.message : String(err)))
            }
          >
            Clear
          </button>
        )}
        {state?.confirmedAt && (
          <span className="detail-meta" data-testid="analysis-confirmed-at">
            Confirmed {new Date(state.confirmedAt).toLocaleString()}
          </span>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="ai-tool-content analysis-chat" ref={scrollRef} data-testid="analysis-messages">
        {messages.length === 0 && (
          <p className="placeholder-text">
            Ask a question about this ticket, or run the base analysis to assess implementation
            readiness.
          </p>
        )}
        {messages.map((message, index) => (
          <div
            key={index}
            className={`analysis-message analysis-message-${message.role}`}
            data-testid={`analysis-message-${message.role}`}
          >
            {message.role === 'assistant' ? (
              message.text ? (
                <Markdown text={message.text} />
              ) : (
                <span className="placeholder-text">Thinking…</span>
              )
            ) : (
              <span>{message.text}</span>
            )}
          </div>
        ))}
      </div>

      <div className="analysis-input-row">
        {messages.length === 0 && (
          <button
            className="btn"
            data-testid="analysis-run-base"
            disabled={busy}
            onClick={() => void submit('')}
          >
            Run analysis
          </button>
        )}
        <textarea
          className="textarea"
          data-testid="analysis-question-input"
          value={question}
          onChange={event => setQuestion(event.target.value)}
          placeholder="Ask a question about this ticket…"
          rows={2}
          disabled={busy}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              if (question.trim() && !busy) {
                void submit(question.trim());
              }
            }
          }}
        />
        {busy ? (
          <button
            className="btn"
            data-testid="analysis-cancel-btn"
            onClick={() => void window.ticketManager.ai.cancelAnalysis(issueKey)}
          >
            Cancel
          </button>
        ) : (
          <button
            className="btn btn-primary"
            data-testid="analysis-submit-btn"
            disabled={!question.trim()}
            onClick={() => void submit(question.trim())}
          >
            Ask
          </button>
        )}
      </div>
    </div>
  );
}
