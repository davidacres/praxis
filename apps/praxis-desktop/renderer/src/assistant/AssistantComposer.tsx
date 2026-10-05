import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react';
import type { WireImageAttachment } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { SessionComposerCard, SessionComposerHeader, SessionComposerInput, SessionContextRing } from '../ai/SessionComposerFrame';
import { SessionComposerToolbar } from '../ai/SessionComposerToolbar';
import { SessionComposerActivityOrbit } from '../ai/SessionComposerActivityOrbit';
import { MAX_ATTACHED_IMAGES, collectClipboardImages, collectImageFiles, encodeImageAttachment } from '../ai/imageAttachments';
import { useAssistantMention } from './useAssistantMention';

interface AssistantComposerProps {
  value: string;
  onChange: (value: string) => void;
  busy: boolean;
  onSend: (images: WireImageAttachment[]) => void;
  sendLabel: string;
  /** Bumped by the shell to pull focus into the box (on open). */
  focusSignal: number;
  composerOptions: ReactNode;
  headerOptions: ReactNode;
}

export function AssistantComposer({ value, onChange, busy, onSend, sendLabel, focusSignal, composerOptions, headerOptions }: AssistantComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const mention = useAssistantMention(value, caret);
  const [images, setImages] = useState<WireImageAttachment[]>([]);
  const [imageError, setImageError] = useState<string>();
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => { ref.current?.focus(); }, [focusSignal]);

  const insert = (id: string) => {
    const next = mention.insert(id);
    if (!next) return;
    onChange(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const stageImages = async (sources: ReturnType<typeof collectImageFiles>) => {
    const picked = await sources;
    if (picked.length === 0) return;
    setImageError(undefined);
    try {
      const encoded = await Promise.all(picked.slice(0, MAX_ATTACHED_IMAGES).map(encodeImageAttachment));
      setImages(current => [...current, ...encoded].slice(0, MAX_ATTACHED_IMAGES));
    } catch (error) {
      setImageError(error instanceof Error ? error.message : String(error));
    }
  };
  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0 || !files.every(file => file.type.toLowerCase().startsWith('image/'))) return;
    event.preventDefault();
    void stageImages(collectClipboardImages(event.clipboardData));
  };
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0 || !files.every(file => file.type.toLowerCase().startsWith('image/'))) return;
    void stageImages(collectImageFiles(files));
  };
  const send = () => {
    onSend(images);
    setImages([]);
    setImageError(undefined);
  };

  return (
    <SessionComposerCard
      className={`assistant-composer${dragOver ? ' is-drag-over' : ''}${busy ? ' is-collapsed is-running' : ''}`}
      data-testid="assistant-composer"
      onPaste={handlePaste}
      onDragOver={event => {
        if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={event => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setDragOver(false);
      }}
      onDrop={handleDrop}
    >
      {busy && <SessionComposerActivityOrbit testId="assistant-composer-activity-orbit" />}
      {!busy && <SessionComposerHeader data-testid="assistant-mode-panel">{headerOptions}</SessionComposerHeader>}
      {!busy && images.length > 0 && (
        <div className="session-image-attachments" data-testid="assistant-image-attachments">
          {images.map((image, index) => (
            <span className="session-image-chip" key={`${index}-${image.dataBase64.length}`} data-testid="assistant-image-chip">
              <img src={`data:${image.mimeType};base64,${image.dataBase64}`} alt="" />
              <button type="button" className="icon-btn icon-btn-sm" aria-label={`Remove image ${index + 1}`} onClick={() => setImages(current => current.filter((_, candidate) => candidate !== index))}>
                <Icon name="close" size={12} />
              </button>
            </span>
          ))}
          <span className="session-image-hint">{images.length}/{MAX_ATTACHED_IMAGES} · images are read through a read-only tool turn</span>
        </div>
      )}
      {imageError && <div className="error-banner assistant-error" role="alert">{imageError}</div>}
      {mention.open && (
        <ul className="assistant-mention-menu" role="listbox" aria-label="Mention a team member" data-testid="assistant-mention-menu">
          {mention.matches.map((persona, index) => (
            <li key={persona.id} role="option" aria-selected={index === mention.highlight}>
              <button
                type="button"
                className={`assistant-mention-option${index === mention.highlight ? ' is-active' : ''}`}
                onMouseDown={event => { event.preventDefault(); insert(persona.id); }}
              >
                <span className={`persona-badge persona-badge--${persona.id}`}><Icon name={persona.icon} size={12} /></span>
                <span>@{persona.id}</span>
                <small>{persona.name}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      <SessionComposerInput
        ref={ref}
        value={value}
        collapsed={busy}
        placeholder="Ask selected members… or @mention a member"
        aria-label="Message the virtual team"
        data-testid="assistant-input"
        disabled={busy}
        onChange={event => { onChange(event.target.value); setCaret(event.target.selectionStart); }}
        onSelect={event => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={event => {
          if (mention.open) {
            const count = mention.matches.length;
            if (event.key === 'ArrowDown') { event.preventDefault(); mention.setHighlight(index => (index + 1) % count); return; }
            if (event.key === 'ArrowUp') { event.preventDefault(); mention.setHighlight(index => (index - 1 + count) % count); return; }
            if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); insert(mention.matches[mention.highlight].id); return; }
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); mention.dismiss(); return; }
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            if (value.trim() && !busy) send();
          }
        }}
      />
      <SessionComposerToolbar>
        {busy ? <span className="composer-chip session-runtime-chip is-readonly session-activity-chip" data-testid="assistant-composer-activity-chip"><Icon name="sparkles" size={13} /> The team is thinking…</span> : composerOptions}
        <span className="spacer" />
        {!busy && <span className="session-context-chip" data-testid="assistant-context-indicator" title="Context usage is not reported for Virtual Team chat" role="img" aria-label="Context usage unavailable">
          <SessionContextRing percent={0} />
        </span>}
        {!busy && <button type="button" className="composer-send" aria-label={sendLabel} title={sendLabel} data-testid="assistant-send" disabled={!value.trim()} onClick={send}>
          <Icon name="arrow-up" size={15} />
        </button>}
      </SessionComposerToolbar>
    </SessionComposerCard>
  );
}
