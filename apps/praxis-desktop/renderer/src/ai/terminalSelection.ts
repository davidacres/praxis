let activeTerminalId: string | undefined;

export function getActiveTerminalId(): string | undefined {
  return activeTerminalId;
}

export function setActiveTerminalId(sessionId: string | undefined): void {
  activeTerminalId = sessionId;
  window.dispatchEvent(new CustomEvent('tm-active-terminal-changed', { detail: sessionId }));
}

export function onActiveTerminalChanged(listener: (sessionId: string | undefined) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<string | undefined>).detail);
  window.addEventListener('tm-active-terminal-changed', handler);
  return () => window.removeEventListener('tm-active-terminal-changed', handler);
}
