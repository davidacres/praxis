import { useEffect, useState } from 'react';
import type { BackendMode, Connection } from '@ticket-manager/core';

const MODES: BackendMode[] = ['demo', 'jiracloud', 'github', 'gitlab', 'livefolder', 'userworkspace'];

export function Connections() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [name, setName] = useState('');
  const [mode, setMode] = useState<BackendMode>('demo');
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const reload = () => {
    void window.ticketManager.connection.list().then(setConnections);
  };

  useEffect(() => {
    reload();
  }, []);

  const addConnection = async () => {
    if (!name.trim()) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const id = name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
      const settings = mode === 'livefolder' && path.trim() ? { path: path.trim() } : {};
      await window.ticketManager.connection.add({ id, name: name.trim(), mode, settings });
      setName('');
      setPath('');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const removeConnection = async (id: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await window.ticketManager.connection.remove(id);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connections-page">
      <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 600 }}>Connections</h3>

      {error && <div className="error-banner">{error}</div>}

      <div style={{ marginBottom: 20 }}>
        {connections.length === 0 && <p className="placeholder-text">No connections yet.</p>}
        {connections.map(connection => (
          <div key={connection.id} data-testid="connection-row" className="list-row" style={{ justifyContent: 'space-between' }}>
            <div>
              <div className="list-row-title">{connection.name}</div>
              <div className="list-row-meta">{connection.mode}</div>
            </div>
            <button className="btn" disabled={busy} onClick={() => void removeConnection(connection.id)}>
              Remove
            </button>
          </div>
        ))}
      </div>

      <div className="section-divider">
        <strong style={{ fontSize: 13 }}>Add connection</strong>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input
            className="input"
            value={name}
            onChange={event => setName(event.target.value)}
            placeholder="Connection name"
            style={{ flex: 1 }}
          />
          <select className="select" value={mode} onChange={event => setMode(event.target.value as BackendMode)}>
            {MODES.map(m => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void addConnection()}>
            Add
          </button>
        </div>
        {mode === 'livefolder' && (
          <input
            data-testid="livefolder-path-input"
            className="input"
            value={path}
            onChange={event => setPath(event.target.value)}
            placeholder="Live Folder path"
            style={{ width: '100%', marginTop: 8 }}
          />
        )}
      </div>
    </div>
  );
}
