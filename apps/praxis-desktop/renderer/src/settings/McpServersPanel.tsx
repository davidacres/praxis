import { useState } from 'react';
import type { McpServerConfig, McpTestResult, McpTransport } from '@praxis/core';
import { ChipSelect } from '../ui/ChipSelect';
import { useDialogs } from '../ui/dialogs';
import { Icon } from '../ui/Icon';

/**
 * Settings → AI Provider → Tools → MCP servers: the list of servers a user adds
 * for their agents, and the form to add or edit one. Built from the existing
 * settings-row, list-row, button and ChipSelect primitives, reusing the custom
 * endpoint form's layout classes.
 */

interface Row {
  name: string;
  value: string;
}

interface Draft {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransport;
  url: string;
  headers: Row[];
  command: string;
  /** One argument per line, so an argument may contain spaces. */
  args: string;
  env: Row[];
  requireApproval: boolean;
}

function newDraft(): Draft {
  return {
    id: crypto.randomUUID(),
    name: '',
    enabled: true,
    transport: 'http',
    url: '',
    headers: [],
    command: '',
    args: '',
    env: [],
    requireApproval: true
  };
}

function toRows(record: Record<string, string> | undefined): Row[] {
  return Object.entries(record ?? {}).map(([name, value]) => ({ name, value }));
}

function fromRows(rows: Row[]): Record<string, string> | undefined {
  const entries = rows.filter(row => row.name.trim()).map(row => [row.name.trim(), row.value] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function draftOf(server: McpServerConfig): Draft {
  return {
    id: server.id,
    name: server.name,
    enabled: server.enabled,
    transport: server.transport,
    url: server.url ?? '',
    headers: toRows(server.headers),
    command: server.command ?? '',
    args: (server.args ?? []).join('\n'),
    env: toRows(server.env),
    requireApproval: server.requireApproval
  };
}

function configOf(draft: Draft): McpServerConfig {
  const base = {
    id: draft.id,
    name: draft.name.trim(),
    enabled: draft.enabled,
    transport: draft.transport,
    requireApproval: draft.requireApproval
  };
  if (draft.transport === 'http') {
    const headers = fromRows(draft.headers);
    return { ...base, url: draft.url.trim(), ...(headers ? { headers } : {}) };
  }
  const args = draft.args.split('\n').map(line => line.trim()).filter(Boolean);
  const env = fromRows(draft.env);
  return { ...base, command: draft.command.trim(), ...(args.length > 0 ? { args } : {}), ...(env ? { env } : {}) };
}

/** Tool names are derived from the name, so two servers cannot share one once slugged. */
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function problemWith(draft: Draft, others: readonly McpServerConfig[]): string | undefined {
  const name = draft.name.trim();
  if (!name) return 'Enter a name.';
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,47}$/.test(name)) {
    return 'Use letters, numbers, spaces, dots, dashes or underscores in the name (48 characters at most).';
  }
  if (others.some(other => other.id !== draft.id && slug(other.name) === slug(name))) {
    return 'Another server already has a name that reads the same.';
  }
  if (draft.transport === 'http') {
    try {
      const url = new URL(draft.url.trim());
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'The URL must start with http:// or https://.';
    } catch {
      return 'Enter the full URL of the server, starting with https://.';
    }
    return undefined;
  }
  return draft.command.trim() ? undefined : 'Enter the command to run.';
}

function describe(server: McpServerConfig): string {
  if (server.transport === 'http') return server.url ?? '';
  return [server.command, ...(server.args ?? [])].join(' ');
}

function FormRow({ label, description, stacked, children }: { label: string; description?: string; stacked?: boolean; children: React.ReactNode }) {
  return (
    <div className={`settings-field-row${stacked ? ' settings-field-row--stacked' : ''}`}>
      <div className="settings-field-label">
        <strong>{label}</strong>
        {description && <div className="settings-field-help">{description}</div>}
      </div>
      <div className="settings-field-control settings-field-control--field">{children}</div>
    </div>
  );
}

function RowsEditor({
  rows,
  onChange,
  namePlaceholder,
  valuePlaceholder,
  addLabel,
  label,
  testId
}: {
  rows: Row[];
  onChange: (rows: Row[]) => void;
  namePlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
  label: string;
  testId: string;
}) {
  return (
    <div className="custom-endpoint-headers" data-testid={testId}>
      {rows.map((row, index) => (
        <div key={index} className="custom-endpoint-header-row">
          <input
            className="input custom-endpoint-mono"
            aria-label={`${label} ${index + 1} name`}
            placeholder={namePlaceholder}
            value={row.name}
            onChange={event => onChange(rows.map((r, i) => (i === index ? { ...r, name: event.target.value } : r)))}
          />
          <input
            className="input custom-endpoint-mono"
            aria-label={`${label} ${index + 1} value`}
            placeholder={valuePlaceholder}
            value={row.value}
            onChange={event => onChange(rows.map((r, i) => (i === index ? { ...r, value: event.target.value } : r)))}
          />
          <button type="button" className="btn-icon" aria-label={`Remove ${label.toLowerCase()} ${index + 1}`} onClick={() => onChange(rows.filter((_, i) => i !== index))}>
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-compact custom-endpoint-add-header" onClick={() => onChange([...rows, { name: '', value: '' }])}>
        <Icon name="plus" size={12} />
        {addLabel}
      </button>
    </div>
  );
}

function TestResult({ result, testId }: { result: McpTestResult | 'testing' | undefined; testId: string }) {
  if (!result) return null;
  if (result === 'testing') return <p className="settings-hint" data-testid={testId}>Connecting…</p>;
  if (!result.ok) {
    return <p className="hint is-danger" role="alert" data-testid={testId}>Could not connect: {result.error}</p>;
  }
  const names = result.tools.map(tool => tool.name);
  return (
    <p className="settings-hint" data-testid={testId}>
      Connected{result.serverName ? ` to ${result.serverName}` : ''} — {names.length} {names.length === 1 ? 'tool' : 'tools'}
      {names.length > 0 ? `: ${names.slice(0, 8).join(', ')}${names.length > 8 ? `, +${names.length - 8} more` : ''}` : '.'}
    </p>
  );
}

export function McpServersPanel({
  servers,
  onChange
}: {
  servers: McpServerConfig[];
  onChange: (next: McpServerConfig[]) => Promise<void>;
}) {
  const { confirm } = useDialogs();
  const [draft, setDraft] = useState<Draft | undefined>();
  const [editingExisting, setEditingExisting] = useState(false);
  const [tests, setTests] = useState<Record<string, McpTestResult | 'testing'>>({});
  const [saving, setSaving] = useState(false);

  const problem = draft ? problemWith(draft, servers) : undefined;

  const runTest = async (key: string, config: McpServerConfig) => {
    setTests(current => ({ ...current, [key]: 'testing' }));
    const result = await window.praxis.ai.testMcpServer(config).catch((error): McpTestResult => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }));
    setTests(current => ({ ...current, [key]: result }));
  };

  const save = async () => {
    if (!draft || problem) return;
    setSaving(true);
    try {
      const config = configOf(draft);
      const next = editingExisting
        ? servers.map(server => (server.id === config.id ? config : server))
        : [...servers, config];
      await onChange(next);
      setDraft(undefined);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (server: McpServerConfig) => {
    const ok = await confirm({
      title: `Remove ${server.name}?`,
      message: 'Agents will stop being offered its tools. Sessions already running keep what they started with.',
      confirmLabel: 'Remove',
      danger: true
    });
    if (ok) await onChange(servers.filter(entry => entry.id !== server.id));
  };

  return (
    <div className="mcp-servers" data-testid="mcp-servers">
      <div className="settings-section-subhead"><span>MCP servers</span></div>
      <p className="settings-hint">
        Servers you add here are given to full-tools sessions. CLI agents (Claude Code, Codex…) connect to them
        directly; API providers get their tools through Praxis, named <code>mcp__server__tool</code>. Read-only
        sessions never get them. Headers and environment values are stored in your settings file.
      </p>

      {servers.length > 0 && (
        <div data-testid="mcp-servers-list">
          {servers.map(server => (
            <div key={server.id} data-testid={`mcp-server-row-${server.id}`}>
              <div className="list-row is-static">
                <div className="list-row-title">
                  <strong>{server.name}</strong>{' '}
                  <span className="chip">{server.transport === 'http' ? 'Remote' : 'Local'}</span>
                  <div className="list-row-meta">
                    {describe(server)}
                    {!server.requireApproval && ' · runs without asking'}
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={server.enabled}
                  aria-label={`${server.enabled ? 'Turn off' : 'Turn on'} ${server.name}`}
                  className="switch"
                  data-testid={`mcp-server-toggle-${server.id}`}
                  onClick={() => void onChange(servers.map(entry => (entry.id === server.id ? { ...entry, enabled: !entry.enabled } : entry)))}
                />
                <button type="button" className="btn btn-compact" data-testid={`mcp-server-test-${server.id}`} onClick={() => void runTest(server.id, server)}>
                  Test
                </button>
                <button
                  type="button"
                  className="btn-icon"
                  aria-label={`Edit ${server.name}`}
                  onClick={() => {
                    setEditingExisting(true);
                    setDraft(draftOf(server));
                  }}
                >
                  <Icon name="pencil" size={13} />
                </button>
                <button type="button" className="btn-icon" aria-label={`Remove ${server.name}`} data-testid={`mcp-server-remove-${server.id}`} onClick={() => void remove(server)}>
                  <Icon name="trash" size={13} />
                </button>
              </div>
              <TestResult result={tests[server.id]} testId={`mcp-server-result-${server.id}`} />
            </div>
          ))}
        </div>
      )}

      {draft ? (
        <div className="custom-endpoint-form" data-testid="mcp-server-form">
          <FormRow label="Name" description="Also used in tool names.">
            <input className="input" aria-label="Server name" data-testid="mcp-server-name" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} />
          </FormRow>
          <FormRow label="Type">
            <ChipSelect
              block
              ariaLabel="Server type"
              data-testid="mcp-server-transport"
              value={draft.transport}
              onChange={value => setDraft({ ...draft, transport: value as McpTransport })}
              options={[
                { value: 'http', label: 'Remote (HTTP)', description: 'A server at a URL' },
                { value: 'stdio', label: 'Local command', description: 'A program Praxis or the agent starts, e.g. npx' }
              ]}
            />
          </FormRow>
          {draft.transport === 'http' ? (
            <>
              <FormRow label="URL">
                <input className="input custom-endpoint-mono" aria-label="Server URL" data-testid="mcp-server-url" placeholder="https://example.com/mcp" value={draft.url} onChange={event => setDraft({ ...draft, url: event.target.value })} />
              </FormRow>
              <FormRow label="Headers" description="For example Authorization: Bearer … " stacked>
                <RowsEditor label="Header" testId="mcp-server-headers" rows={draft.headers} onChange={headers => setDraft({ ...draft, headers })} namePlaceholder="Header" valuePlaceholder="Value" addLabel="Add header" />
              </FormRow>
            </>
          ) : (
            <>
              <FormRow label="Command">
                <input className="input custom-endpoint-mono" aria-label="Command" data-testid="mcp-server-command" placeholder="npx" value={draft.command} onChange={event => setDraft({ ...draft, command: event.target.value })} />
              </FormRow>
              <FormRow label="Arguments" description="One per line." stacked>
                <textarea className="input custom-endpoint-mono" aria-label="Arguments" data-testid="mcp-server-args" rows={3} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/folder'} value={draft.args} onChange={event => setDraft({ ...draft, args: event.target.value })} />
              </FormRow>
              <FormRow label="Environment" description="Variables the program needs, such as an API token." stacked>
                <RowsEditor label="Variable" testId="mcp-server-env" rows={draft.env} onChange={env => setDraft({ ...draft, env })} namePlaceholder="NAME" valuePlaceholder="Value" addLabel="Add variable" />
              </FormRow>
            </>
          )}
          <div className="settings-toggle-row">
            <div className="settings-toggle-text">
              <strong>Ask before each tool call</strong>
              <div className="settings-field-help">Turn off only for a server you trust — its tools can do whatever they are built to.</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={draft.requireApproval}
              aria-label="Ask before each tool call"
              className="switch"
              data-testid="mcp-server-approval"
              onClick={() => setDraft({ ...draft, requireApproval: !draft.requireApproval })}
            />
          </div>
          {problem && <p className="hint" data-testid="mcp-server-problem">{problem}</p>}
          <TestResult result={tests.draft} testId="mcp-server-test-result" />
          <div className="ai-key-controls">
            <button type="button" className="btn btn-primary" data-testid="mcp-server-save" disabled={Boolean(problem) || saving} onClick={() => void save()}>
              {editingExisting ? 'Save changes' : 'Add server'}
            </button>
            <button type="button" className="btn" data-testid="mcp-server-test" disabled={Boolean(problem)} onClick={() => void runTest('draft', configOf(draft))}>
              Test connection
            </button>
            <button type="button" className="btn" data-testid="mcp-server-cancel" onClick={() => setDraft(undefined)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="btn btn-compact"
          data-testid="mcp-add-server"
          onClick={() => {
            setEditingExisting(false);
            setTests(current => {
              const { draft: _discard, ...rest } = current;
              return rest;
            });
            setDraft(newDraft());
          }}
        >
          <Icon name="plus" size={12} />
          Add MCP server
        </button>
      )}
    </div>
  );
}
