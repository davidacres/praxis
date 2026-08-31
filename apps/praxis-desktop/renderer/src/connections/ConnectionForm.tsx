import { useEffect, useState } from 'react';
import type { BackendMode, Connection, ConnectionCheck } from '@praxis/core';
import { backendModeMeta } from '../board/boardMeta';
import { FieldRow, Toggle } from '../ui/formControls';
import { Icon } from '../ui/Icon';
import {
  CONNECTION_MODES,
  autoSynthesizesBoard,
  createSynthesizedTrackedBoard,
  secretNamesForMode,
  supportsManualBoardSelection
} from './connectionPolicy';

/** What the parent should do after a save: open the board picker or stay put. */
export type SaveFollowUp = 'boards' | 'none';

export interface ConnectionFormProps {
  /** The connection being edited; undefined while creating a new one. */
  existing?: Connection;
  onSaved: (connection: Connection, followUp: SaveFollowUp) => void;
  /**
   * Fired when Test persists the connection without the form closing — the
   * parent refreshes its list so the new row appears while the test result
   * stays on screen. (onSaved would remount the form and lose the result.)
   */
  onPersisted?: () => void;
  onCancel: () => void;
  onRemoved: (connectionId: string) => void;
}

type FormValues = Record<string, string | boolean>;

/** Drops fields the user never touched so settings.json stays minimal. */
function pruneSettings(values: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string' && value.trim().length === 0) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * The Atlassian-hosted remote MCP endpoint targeted by Cloud mode. Lives in
 * the frontend on purpose: the frontend imports only *types* from
 * `@praxis/core` (a runtime import would drag node-only services into
 * the renderer bundle). The backend resolver reads it back from
 * `connection.settings.httpUrl`.
 */
const ATLASSIAN_REMOTE_MCP_URL = 'https://mcp.atlassian.com/v1/mcp';

/**
 * Settings keys written only by the Advanced jiracloud sub-mode. Wiped on save
 * in Cloud mode so a connection that flipped from Advanced → Cloud does not
 * leak `stdioCommand`, stale `httpUrl`, or workspace/user MCP refs into the
 * Cloud-mode resolution path.
 */
const ADVANCED_ONLY_JIRA_KEYS = [
  'connectionType',
  'httpUrl',
  'stdioCommand',
  'stdioArgs',
  'stdioCwd',
  'httpHeaders',
  'headers',
  'env',
  'workspaceMcpServerName',
  'userMcpServerRef'
] as const;

/**
 * Build the saved `settings` for a Jira connection given the form values, the
 * active sub-mode, and the Cloud sign-in method. In Cloud mode the form's
 * free-form Advanced values are dropped and the Cloud-mode keys
 * (connectionType=http, httpUrl, jiraAuthMethod, …) are layered on top; in
 * Advanced mode the form's values pass through unchanged.
 *
 * `jiraApiEmail` is only meaningful in Cloud + token mode — writing it for the
 * OAuth branch would leak PII into a settings record the OAuth path never
 * reads.
 *
 * The "bring your own OAuth app" keys (`jiraOAuthClientId`,
 * `jiraOAuthRedirectUrl`, `jiraOAuthScope`) are only meaningful in Cloud +
 * OAuth mode — token mode never reads them, so a connection that flipped
 * OAuth → token would otherwise leave stale BYO entries on disk. Empty
 * entries are already dropped by `pruneSettings`; explicit deletes here keep
 * a pre-existing BYO entry from being preserved through a token-mode save.
 */
function jiraSettingsForSave(
  values: FormValues,
  setupMode: 'cloud' | 'advanced',
  authMethod: 'oauth' | 'api-token'
): Record<string, unknown> {
  const pruned = pruneSettings(values);
  if (setupMode === 'advanced') {
    return pruned;
  }
  // Cloud: drop Advanced-only keys, then layer on the Cloud-mode keys. The
  // `url` field is shared across both sub-modes (the Jira site URL the user
  // typed) — keep whatever the form has.
  const cleaned: Record<string, unknown> = { ...pruned };
  for (const key of ADVANCED_ONLY_JIRA_KEYS) {
    delete cleaned[key];
  }
  cleaned['connectionType'] = 'http';
  cleaned['httpUrl'] = ATLASSIAN_REMOTE_MCP_URL;
  cleaned['jiraAuthMethod'] = authMethod;
  if (authMethod === 'api-token') {
    // Token mode has no use for the BYO OAuth fields — clear them so a
    // connection that flipped OAuth → token does not leave stale entries
    // on disk. `jiraApiEmail` must stay written here — it is the only place
    // the token-mode auth path reads it from.
    delete cleaned['jiraOAuthClientId'];
    delete cleaned['jiraOAuthRedirectUrl'];
    delete cleaned['jiraOAuthScope'];
  } else {
    // OAuth mode never reads `jiraApiEmail`; drop it so an email typed for
    // a previous token-mode edit does not leak through into OAuth settings.
    delete cleaned['jiraApiEmail'];
  }
  return cleaned;
}

/**
 * A folder connection stores its plans folders as `roots: string[]`. The form
 * edits them as one-per-line text (see `initialValues`), so split back on save
 * and drop the legacy single-`path` key a pre-multi-root connection may carry.
 */
function folderSettingsForSave(values: FormValues): Record<string, unknown> {
  const cleaned = pruneSettings(values);
  delete cleaned['path'];
  cleaned['roots'] = parseFolderRoots(values['roots']);
  return cleaned;
}

/** One folder per line, blanks and duplicates removed, original order kept. */
function parseFolderRoots(raw: string | boolean | undefined): string[] {
  if (typeof raw !== 'string') {
    return [];
  }
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || seen.has(trimmed.toLowerCase())) {
      continue;
    }
    seen.add(trimmed.toLowerCase());
    roots.push(trimmed);
  }
  return roots;
}

function initialValues(connection: Connection | undefined): FormValues {
  const values: FormValues = {};
  for (const [key, value] of Object.entries(connection?.settings ?? {})) {
    if (typeof value === 'string' || typeof value === 'boolean') {
      values[key] = value;
    } else if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
      // Multi-value settings (e.g. Jira stdio args) edit as one-per-line text;
      // the desktop config provider accepts both shapes.
      values[key] = (value as string[]).join('\n');
    }
  }
  // A folder connection written before multi-root has a single `path`; surface
  // it as the first root so editing one does not silently drop its folder.
  if (connection?.mode === 'folder' && !values['roots'] && typeof values['path'] === 'string') {
    values['roots'] = values['path'];
  }
  return values;
}

/**
 * Post-save policy for demo/folder: the connection derives one canonical board
 * from its own settings, so upsert that synthesized tracked board and prune
 * anything else (e.g. stale entries from before a project-key rename). A folder
 * connection's extra roots are not tracked here — `getBoards()` surfaces them.
 */
async function syncSynthesizedTrackedBoard(connection: Connection): Promise<void> {
  const canonical = createSynthesizedTrackedBoard(connection);
  if (!canonical) {
    return;
  }
  const tracked = await window.praxis.connection.getTrackedBoards(connection.id);
  const existingCanonical = tracked.find(board => board.boardId === canonical.boardId);
  if (existingCanonical) {
    if (existingCanonical.displayName !== canonical.displayName) {
      await window.praxis.connection.updateTrackedBoard(canonical);
    }
  } else {
    await window.praxis.connection.addTrackedBoards([canonical]);
  }
  for (const board of tracked) {
    if (board.boardId !== canonical.boardId) {
      await window.praxis.connection.removeTrackedBoard(connection.id, board.boardId);
    }
  }
}

/**
 * The add/edit form for one connection. Mode-aware field set; saving applies
 * the per-mode post-save policy's persistence half (the parent decides the
 * navigation half — e.g. chaining into the board picker).
 *
 * "Test connection" persists first (the backend registry resolves services by
 * connection id from the store, so there is no way to health-check settings
 * that exist only in form state). This mirrors the extension's manager; a
 * test of a brand-new connection therefore leaves it saved even if the user
 * cancels afterwards.
 */
export function ConnectionForm({ existing, onSaved, onPersisted, onCancel, onRemoved }: ConnectionFormProps) {
  const [name, setName] = useState(existing?.name ?? '');
  const [mode, setMode] = useState<BackendMode>(existing?.mode ?? 'demo');
  const [values, setValues] = useState<FormValues>(() => initialValues(existing));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [savedSecretNames, setSavedSecretNames] = useState<readonly string[]>([]);
  /**
   * For jiracloud: the Cloud sub-mode is the recommended one-page setup; the
   * Advanced sub-mode is today's hand-rolled MCP server config and stays for
   * existing connections that already store manual settings.
   */
  const [jiraSetupMode, setJiraSetupMode] = useState<'cloud' | 'advanced'>(
    existing?.mode === 'jiracloud' && existing?.settings?.['jiraAuthMethod'] === undefined
      ? 'advanced'
      : 'cloud'
  );
  /**
   * Only relevant while `jiraSetupMode === 'cloud'`. Defaults to OAuth because
   * that is the recommended one-click flow; an existing token-mode connection
   * reopens in token mode.
   */
  const [jiraAuthMethod, setJiraAuthMethod] = useState<'oauth' | 'api-token'>(
    existing?.mode === 'jiracloud' && existing?.settings?.['jiraAuthMethod'] === 'api-token'
      ? 'api-token'
      : 'oauth'
  );
  /**
   * Set once a brand-new form has been persisted (by Test or Save) so further
   * saves update instead of failing the store's duplicate-id check.
   */
  const [persistedId, setPersistedId] = useState<string | undefined>(existing?.id);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionCheck | undefined>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  // Which secrets already exist decides the placeholder text ("A key is saved —
  // leave blank to keep it") without the value ever crossing IPC.
  useEffect(() => {
    if (!existing) {
      setSavedSecretNames([]);
      return;
    }
    let cancelled = false;
    void Promise.all(
      secretNamesForMode(existing.mode).map(async secretName => {
        const has = await window.praxis.connection.hasSecret(existing.id, secretName);
        return has ? secretName : undefined;
      })
    ).then(results => {
      if (!cancelled) {
        setSavedSecretNames(results.filter((r): r is string => r !== undefined));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [existing]);

  const setValue = (key: string, value: string | boolean) =>
    setValues(current => ({ ...current, [key]: value }));

  const persist = async (): Promise<Connection> => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new Error('Connection name is required.');
    }
    // Jira has two sub-modes whose on-disk shapes differ (Cloud layers on a
    // fixed httpUrl + drops Advanced-only keys; Advanced passes values
    // through). Other modes are unaffected.
    const settings =
      mode === 'jiracloud'
        ? jiraSettingsForSave(values, jiraSetupMode, jiraAuthMethod)
        : mode === 'folder'
          ? folderSettingsForSave(values)
          : pruneSettings(values);

    let connection: Connection;
    if (persistedId) {
      // Mode is immutable after creation, so `mode` here is always the
      // connection's own — the select is disabled in edit mode.
      connection = { id: persistedId, name: trimmedName, mode, settings };
      await window.praxis.connection.update(connection);
    } else {
      const id = await window.praxis.connection.generateId(trimmedName);
      connection = { id, name: trimmedName, mode, settings };
      await window.praxis.connection.add(connection);
      setPersistedId(id);
    }

    // Blank secret fields mean "keep the saved one" — only non-empty input writes.
    for (const [secretName, value] of Object.entries(secrets)) {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        await window.praxis.connection.setSecret(connection.id, secretName, trimmed);
      }
    }

    // Cloud + OAuth: make sure we do not leave a stale token around from a
    // previous token-mode edit of this same connection, and never write the
    // token-mode email blob into OAuth settings (jiraSettingsForSave already
    // strips it). The setSecret(undefined) call reuses the existing IPC path
    // for removing a secret.
    if (mode === 'jiracloud' && jiraSetupMode === 'cloud' && jiraAuthMethod === 'oauth') {
      if (savedSecretNames.includes('jiraApiToken')) {
        await window.praxis.connection.setSecret(connection.id, 'jiraApiToken', undefined);
        setSavedSecretNames(prev => prev.filter(name => name !== 'jiraApiToken'));
      }
    }
    // Cloud + token: symmetrically drop the BYO OAuth client secret so a
    // connection that flipped OAuth → token does not keep a credential the
    // token path cannot use.
    if (mode === 'jiracloud' && jiraSetupMode === 'cloud' && jiraAuthMethod === 'api-token') {
      if (savedSecretNames.includes('jiraOAuthClientSecret')) {
        await window.praxis.connection.setSecret(
          connection.id,
          'jiraOAuthClientSecret',
          undefined
        );
        setSavedSecretNames(prev => prev.filter(name => name !== 'jiraOAuthClientSecret'));
      }
    }
    return connection;
  };

  const save = async () => {
    setSaving(true);
    setSaveError(undefined);
    try {
      const connection = await persist();
      if (autoSynthesizesBoard(connection.mode)) {
        await syncSynthesizedTrackedBoard(connection);
      }
      onSaved(connection, supportsManualBoardSelection(connection.mode) ? 'boards' : 'none');
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(undefined);
    setSaveError(undefined);
    try {
      const connection = await persist();
      onPersisted?.();
      setTestResult(await window.praxis.connection.check(connection.id));
    } catch (error) {
      setTestResult({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        toolCount: 0
      });
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    // `persistedId` is state — seeded at mount, set on first save — while
    // `existing` is the prop the parent supplies once the connection reaches
    // the list. Right after saving a new connection the two can disagree for a
    // frame, and this used to `return` on that gap: the row stayed, no error
    // appeared, and the click was simply lost. Fall back to the prop, and if
    // there genuinely is no id, say so rather than failing silently.
    const targetId = persistedId ?? existing?.id;
    if (!targetId) {
      setSaveError('This connection has not been saved yet, so there is nothing to remove.');
      setConfirmingRemove(false);
      return;
    }
    setSaving(true);
    setSaveError(undefined);
    try {
      await window.praxis.connection.remove(targetId);
      onRemoved(targetId);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
      setConfirmingRemove(false);
    } finally {
      setSaving(false);
    }
  };

  const busy = saving || testing;

  return (
    <div className="conn-form" data-testid="conn-form">
      <header className="view-header">
        <span className="view-title">
          {existing ? existing.name : `New ${backendModeMeta(mode).label} connection`}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="btn"
          data-testid="conn-test-btn"
          disabled={busy || !name.trim()}
          onClick={() => void test()}
        >
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          data-testid="conn-save-btn"
          disabled={busy || !name.trim()}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn" data-testid="conn-cancel-btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </header>

      <div className="conn-form-body">
        {saveError && (
          <div className="error-banner" data-testid="conn-save-error">
            {saveError}
          </div>
        )}

        {testResult && (
          <div className={`test-result test-${testResult.status}`} data-testid="conn-test-result">
            <strong>{testResult.status.toUpperCase()}</strong>
            <span>{testResult.message}</span>
          </div>
        )}

        <FieldRow label="Name" description="Shown in the sidebar and on boards from this backend.">
          <input
            className="input"
            data-testid="conn-field-name"
            value={name}
            placeholder="e.g. Team Jira"
            onChange={event => setName(event.target.value)}
          />
        </FieldRow>

        <FieldRow
          label="Backend"
          description={existing ? 'Backend type cannot be changed after creation.' : undefined}
        >
          <select
            className="select"
            data-testid="conn-field-mode"
            value={mode}
            disabled={existing !== undefined}
            onChange={event => {
              // Switching mode swaps the whole field set — stale values from the
              // previous mode would silently persist into the new one's settings.
              setMode(event.target.value as BackendMode);
              setValues({});
              setSecrets({});
              setTestResult(undefined);
              // Jira sub-state follows the new mode's recommended defaults; an
              // existing jiracloud connection keeps its existing sub-mode (the
              // form is locked to mode in edit, so this branch is only the
              // "new connection" path anyway).
              setJiraSetupMode('cloud');
              setJiraAuthMethod('oauth');
            }}
          >
            {CONNECTION_MODES.map(candidate => (
              <option key={candidate} value={candidate}>
                {backendModeMeta(candidate).label}
              </option>
            ))}
          </select>
        </FieldRow>

        <ModeFields
          mode={mode}
          values={values}
          secrets={secrets}
          savedSecretNames={savedSecretNames}
          setValue={setValue}
          setSecret={(secretName, value) => setSecrets(current => ({ ...current, [secretName]: value }))}
          jiraSetupMode={jiraSetupMode}
          setJiraSetupMode={setJiraSetupMode}
          jiraAuthMethod={jiraAuthMethod}
          setJiraAuthMethod={setJiraAuthMethod}
        />

        {existing && (
          <div className="conn-danger-zone">
            {confirmingRemove ? (
              <>
                <span className="conn-remove-warning">
                  Removes this connection, its tracked boards, and its saved secrets.
                </span>
                <button
                  type="button"
                  className="btn btn-danger"
                  data-testid="conn-remove-confirm-btn"
                  disabled={busy}
                  onClick={() => void remove()}
                >
                  Confirm remove
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => setConfirmingRemove(false)}
                >
                  Keep
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-danger"
                data-testid="conn-remove-btn"
                disabled={busy}
                onClick={() => setConfirmingRemove(true)}
              >
                <Icon name="trash" size={13} />
                Remove connection
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Per-mode field sets
// ─────────────────────────────────────────────────────────────────────

interface ModeFieldsProps {
  mode: BackendMode;
  values: FormValues;
  secrets: Record<string, string>;
  savedSecretNames: readonly string[];
  setValue: (key: string, value: string | boolean) => void;
  setSecret: (name: string, value: string) => void;
  /** Jira Cloud ↔ Advanced sub-mode (jiracloud only). */
  jiraSetupMode: 'cloud' | 'advanced';
  setJiraSetupMode: (next: 'cloud' | 'advanced') => void;
  /** Jira Cloud sign-in method (jiracloud + Cloud only). */
  jiraAuthMethod: 'oauth' | 'api-token';
  setJiraAuthMethod: (next: 'oauth' | 'api-token') => void;
}

function ModeFields({
  mode,
  values,
  secrets,
  savedSecretNames,
  setValue,
  setSecret,
  jiraSetupMode,
  setJiraSetupMode,
  jiraAuthMethod,
  setJiraAuthMethod
}: ModeFieldsProps) {
  const textValue = (key: string): string => {
    const value = values[key];
    return typeof value === 'string' ? value : '';
  };

  const textField = (key: string, label: string, placeholder: string, description?: string) => (
    <FieldRow key={key} label={label} description={description}>
      <input
        className="input"
        data-testid={`conn-field-${key}`}
        value={textValue(key)}
        placeholder={placeholder}
        onChange={event => setValue(key, event.target.value)}
      />
    </FieldRow>
  );

  const secretField = (secretName: string, label: string, testIdOverride?: string) => (
    <FieldRow
      key={secretName}
      label={label}
      description={
        savedSecretNames.includes(secretName)
          ? 'A key is saved — leave blank to keep it. Stored encrypted via the OS keychain.'
          : 'Stored encrypted via the OS keychain, never in settings.json.'
      }
    >
      <input
        className="input"
        type="password"
        data-testid={testIdOverride ?? `conn-field-secret-${secretName}`}
        value={secrets[secretName] ?? ''}
        placeholder={savedSecretNames.includes(secretName) ? '(saved)' : ''}
        onChange={event => setSecret(secretName, event.target.value)}
      />
    </FieldRow>
  );

  switch (mode) {
    case 'demo':
      return (
        <p className="placeholder-text" data-testid="conn-mode-note">
          Demo mode uses built-in sample data — no further configuration needed.
        </p>
      );
    case 'folder': {
      // Edited as one-per-line text; `folderSettingsForSave` splits it into the
      // stored `roots` array. An empty list still renders one blank row so
      // there is always something to browse into.
      const roots = textValue('roots').split('\n');
      const rootRows = roots.length > 0 ? roots : [''];
      const writeRoots = (next: string[]) => setValue('roots', next.join('\n'));
      return (
        <>
          <FieldRow
            label="Folders"
            description="Each folder is searched for plans structures (features/…). Every plans root found becomes its own board."
          >
            <div className="conn-roots-list" data-testid="conn-field-roots">
              {rootRows.map((root, index) => (
                <div className="conn-path-row" key={index}>
                  <input
                    className="input"
                    data-testid={`conn-field-root-${index}`}
                    value={root}
                    placeholder={'C:\\path\\to\\plans'}
                    onChange={event =>
                      writeRoots(rootRows.map((value, i) => (i === index ? event.target.value : value)))
                    }
                  />
                  <button
                    type="button"
                    className="btn"
                    data-testid={`conn-browse-root-${index}`}
                    onClick={() => {
                      void window.praxis.dialog.pickFolder('Select plans folder').then(picked => {
                        if (picked) {
                          writeRoots(rootRows.map((value, i) => (i === index ? picked : value)));
                        }
                      });
                    }}
                  >
                    <Icon name="folder-open" size={13} />
                    Browse…
                  </button>
                  {rootRows.length > 1 && (
                    <button
                      type="button"
                      className="btn"
                      aria-label={`Remove folder ${index + 1}`}
                      data-testid={`conn-remove-root-${index}`}
                      onClick={() => writeRoots(rootRows.filter((_, i) => i !== index))}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                className="btn"
                data-testid="conn-add-root"
                onClick={() => writeRoots([...rootRows, ''])}
              >
                <Icon name="plus" size={13} />
                Add folder
              </button>
            </div>
          </FieldRow>
          {textField('projectKey', 'Project key', 'LIVE', 'Default prefix for issue keys. A folder with its own board.praxis.json overrides it.')}
          {textField('projectName', 'Project name', 'Folder Project')}
          <Toggle
            label="Allow issue creation"
            description="When off, boards from this folder are read-only and the New issue button is disabled."
            checked={values.allowIssueCreation === true}
            onChange={next => setValue('allowIssueCreation', next)}
            testId="conn-field-allowIssueCreation"
          />
        </>
      );
    }
    case 'jiracloud':
      return (
        <>
          <FieldRow
            label="Setup mode"
            description="Cloud is the recommended one-page setup. Advanced lets you point at a custom MCP server (used by existing manual setups)."
          >
            <div
              role="radiogroup"
              aria-label="Setup mode"
              style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}
            >
              <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                <input
                  type="radio"
                  name="jira-setup-mode"
                  value="cloud"
                  data-testid="jira-setup-mode-cloud"
                  checked={jiraSetupMode === 'cloud'}
                  onChange={() => setJiraSetupMode('cloud')}
                />
                <span>Atlassian Cloud (recommended)</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                <input
                  type="radio"
                  name="jira-setup-mode"
                  value="advanced"
                  data-testid="jira-setup-mode-advanced"
                  checked={jiraSetupMode === 'advanced'}
                  onChange={() => setJiraSetupMode('advanced')}
                />
                <span>Advanced (custom MCP server)</span>
              </label>
            </div>
          </FieldRow>

          {jiraSetupMode === 'cloud' ? (
            <>
              {textField('url', 'Jira site URL', 'https://your-team.atlassian.net')}
              <FieldRow
                label="Sign in"
                description="How the connection authenticates with Atlassian Cloud."
              >
                <div
                  role="radiogroup"
                  aria-label="Sign-in method"
                  style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}
                >
                  <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                    <input
                      type="radio"
                      name="jira-auth-method"
                      value="oauth"
                      data-testid="jira-auth-oauth"
                      checked={jiraAuthMethod === 'oauth'}
                      onChange={() => setJiraAuthMethod('oauth')}
                    />
                    <span>Login with OAuth (browser)</span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                    <input
                      type="radio"
                      name="jira-auth-method"
                      value="api-token"
                      data-testid="jira-auth-token"
                      checked={jiraAuthMethod === 'api-token'}
                      onChange={() => setJiraAuthMethod('api-token')}
                    />
                    <span>Login with API Token</span>
                  </label>
                </div>
              </FieldRow>

              {jiraAuthMethod === 'oauth' ? (
                <>
                  <p className="placeholder-text" data-testid="conn-mode-note">
                    Sign in with your Atlassian account in the browser when you test or use the
                    connection.
                  </p>
                  <details className="conn-byo-oauth" data-testid="jira-byo-oauth">
                    <summary data-testid="jira-byo-oauth-summary">
                      Use my own Atlassian OAuth app (optional)
                    </summary>
                    <div className="conn-byo-oauth-body">
                      <p className="placeholder-text" data-testid="jira-byo-oauth-help">
                        Register an OAuth 2.0 (3LO) app at developer.atlassian.com, add
                        praxis://oauth-callback to its callback URLs, and grant it the
                        Jira API scopes (Permissions → Jira API). The scope string below must
                        match the scopes granted to the app. Useful when your organization
                        blocks dynamically-registered apps.
                      </p>
                      <FieldRow
                        label="Client ID"
                        description="The OAuth 2.0 (3LO) client ID of your registered Atlassian app."
                      >
                        <input
                          className="input"
                          data-testid="jira-oauth-client-id"
                          value={textValue('jiraOAuthClientId')}
                          placeholder="your-3lo-client-id"
                          onChange={event => setValue('jiraOAuthClientId', event.target.value)}
                        />
                      </FieldRow>
                      {secretField('jiraOAuthClientSecret', 'Client secret', 'jira-oauth-client-secret')}
                      <FieldRow
                        label="Redirect URL (optional override)"
                        description="Callback URL registered with your OAuth app. Leave blank to use the default praxis:// callback."
                      >
                        <input
                          className="input"
                          data-testid="jira-oauth-redirect-url"
                          value={textValue('jiraOAuthRedirectUrl')}
                          placeholder="praxis://oauth-callback"
                          onChange={event => setValue('jiraOAuthRedirectUrl', event.target.value)}
                        />
                      </FieldRow>
                      <FieldRow
                        label="Scopes (optional override)"
                        description="Space-separated OAuth scopes. Leave blank to use the default Jira scope set."
                      >
                        <input
                          className="input"
                          data-testid="jira-oauth-scope"
                          value={textValue('jiraOAuthScope')}
                          placeholder="read:jira-work write:jira-work read:jira-user offline_access"
                          onChange={event => setValue('jiraOAuthScope', event.target.value)}
                        />
                      </FieldRow>
                    </div>
                  </details>
                </>
              ) : (
                <>
                  <FieldRow label="Account email" description="The Atlassian account the API token belongs to.">
                    <input
                      className="input"
                      type="email"
                      data-testid="jira-api-email"
                      value={textValue('jiraApiEmail')}
                      placeholder="you@example.com"
                      onChange={event => setValue('jiraApiEmail', event.target.value)}
                    />
                  </FieldRow>
                  {secretField('jiraApiToken', 'API token', 'jira-api-token')}
                  <p className="placeholder-text" data-testid="conn-mode-note">
                    Boards and issues load through the Atlassian-hosted remote MCP server. Some
                    MCP tools are unavailable with API-token auth, and your Atlassian org admin
                    can disable API tokens entirely.
                  </p>
                </>
              )}
            </>
          ) : (
            <>
              <FieldRow label="Connection type" description="How the Jira MCP server is reached.">
                <select
                  className="select"
                  data-testid="conn-field-connectionType"
                  value={textValue('connectionType') || 'stdio'}
                  onChange={event => setValue('connectionType', event.target.value)}
                >
                  <option value="stdio">stdio (local MCP server)</option>
                  <option value="http">HTTP (remote MCP server)</option>
                </select>
              </FieldRow>
              {textValue('connectionType') === 'http' ? (
                textField('httpUrl', 'MCP server URL', 'https://mcp.example.atlassian.net/v1/sse')
              ) : (
                <>
                  {textField('stdioCommand', 'MCP server command (optional)', 'npx')}
                  <FieldRow
                    label="MCP server arguments (optional)"
                    description="One argument per line — e.g. -y, then the jira-mcp-server package."
                  >
                    <textarea
                      className="input"
                      data-testid="conn-field-stdioArgs"
                      rows={3}
                      value={textValue('stdioArgs')}
                      onChange={event => setValue('stdioArgs', event.target.value)}
                    />
                  </FieldRow>
                  {textField('stdioCwd', 'MCP server working directory (optional)', '')}
                </>
              )}
              {textField('url', 'Jira site URL', 'https://your-team.atlassian.net')}
              <FieldRow
                label="Workspace folder (optional)"
                description="When no command/URL is set, the app looks for a Jira server in this folder's .vscode/mcp.json, then in ~/.vscode/mcp.json."
              >
                <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
                  <input
                    className="input"
                    data-testid="conn-field-workspaceFolder"
                    value={textValue('workspaceFolder')}
                    placeholder={'C:\\path\\to\\workspace'}
                    onChange={event => setValue('workspaceFolder', event.target.value)}
                  />
                  <button
                    type="button"
                    className="btn"
                    data-testid="conn-browse-workspaceFolder"
                    onClick={() => {
                      void window.praxis.dialog
                        .pickFolder('Select workspace folder')
                        .then(picked => {
                          if (picked) {
                            setValue('workspaceFolder', picked);
                          }
                        });
                    }}
                  >
                    <Icon name="folder-open" size={13} />
                    Browse…
                  </button>
                </div>
              </FieldRow>
              {textField('defaultProjectKey', 'Default project key (optional)', 'PROJ')}
              {textField('epicKey', 'Linked epic key (optional)', 'PROJ-123')}
              {textField('epicBoardName', 'Epic board name (optional)', 'My Epic Board')}
              {textField('boardJql', 'Board JQL (optional)', 'project = PROJ AND status != Done')}
              {textField('boardName', 'Default board name (optional)', '')}
              <p className="placeholder-text" data-testid="conn-mode-note">
                Boards and issues load through the configured Jira MCP server. Servers that require
                OAuth sign-in are not supported yet — use a personal access token in the server
                environment or headers instead.
              </p>
            </>
          )}
        </>
      );
    case 'gitlab':
      return (
        <>
          {textField('url', 'GitLab base URL', 'https://gitlab.com')}
          {textField('projectPath', 'Project path (optional)', 'group/project')}
          {secretField('apiKey', 'API key (personal access token)')}
          <Toggle
            label="List all accessible boards"
            description="When on, boards are listed across every project the token can reach instead of just the configured project."
            checked={values.listAllAccessibleBoards === true}
            onChange={next => setValue('listAllAccessibleBoards', next)}
            testId="conn-field-listAllAccessibleBoards"
          />
          <p className="placeholder-text" data-testid="conn-mode-note">
            Boards and issues load through the GitLab REST API using the saved token. Issue
            creation is not supported by the GitLab backend; editing covers summary,
            description, and assignee.
          </p>
        </>
      );
    case 'userworkspace':
      return (
        <p className="placeholder-text" data-testid="conn-mode-note">
          User Workspace boards are local plans folders. Save the connection, then use
          Create board in its Boards section below.
        </p>
      );
    case 'github':
      return (
        <p className="placeholder-text" data-testid="conn-mode-note">
          GitHub mode is not implemented yet — there is no GitHub board backend in either the
          extension or the desktop app. The connection saves as metadata only.
        </p>
      );
    default:
      return null;
  }
}
