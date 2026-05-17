import * as vscode from 'vscode';
import type {
  BackendMode,
  Board,
  Connection,
  ConnectionCheck,
  TrackedBoard
} from '../types';
import { ConnectionStore } from '../config/connectionStore';
import type { BackendRouter } from '../backends/backendRouter';

/**
 * The Connections & Boards panel — the canonical UI for setting up and
 * managing multiple backend connections plus their tracked boards. Serves
 * both as the first-run wizard and as the ongoing manager.
 *
 * UI flow:
 *   - View 'list'    → table of connections, each with its tracked boards.
 *   - View 'connection' → Add/Edit Connection form (mode-aware fields).
 *   - View 'boards'  → Pick boards to track for a connection.
 *
 * Follows the project webview conventions (CSP with nonce, html set
 * synchronously after createWebviewPanel — see CLAUDE.md).
 */
export class ConnectionsManagerPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private state: PanelState = createInitialState();

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connectionStore: ConnectionStore,
    private readonly backendRouter: BackendRouter
  ) {}

  /**
   * Opens (or focuses) the panel. Optional `initialAction` lets callers jump
   * straight into a sub-wizard:
   *   - 'addConnection' opens the new-connection form.
   *   - 'addBoard'      opens the board picker for the given connection id.
   */
  public open(initialAction?: InitialAction): void {
    this.state = createInitialState();
    this.applyInitialAction(initialAction);

    if (this.panel) {
      this.panel.reveal();
      this.rerender();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'ticketManager.connectionsManager',
      'Connections & Boards',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.panel.webview.onDidReceiveMessage(
      message => {
        void this.handleMessage(message);
      },
      undefined,
      []
    );

    this.panel.webview.html = this.getHtml();
  }

  public dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  // ──────────────────────────────────────────────────────────────────
  // State / message handling
  // ──────────────────────────────────────────────────────────────────

  private applyInitialAction(action: InitialAction | undefined): void {
    if (!action) {
      return;
    }
    if (action.kind === 'addConnection') {
      this.state.view = 'connection';
      this.state.connectionForm = createNewConnectionForm();
      return;
    }
    if (action.kind === 'addBoard') {
      const connection = this.connectionStore.getConnection(action.connectionId);
      if (connection && supportsManualBoardSelection(connection.mode)) {
        this.state.view = 'boards';
        this.state.boardPicker = {
          connectionId: connection.id,
          loading: true,
          boards: [],
          selectedBoardIds: new Set<string>(),
          errorMessage: undefined
        };
        // Kick off async board fetch; rerender will happen when it completes.
        void this.refreshBoardPicker(connection.id);
      }
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message)) {
      return;
    }
    const command = typeof message.command === 'string' ? message.command : '';
    const handler = this.messageHandlers[command];
    if (handler) {
      await handler.call(this, message);
    }
  }

  private readonly messageHandlers: Record<string, (this: ConnectionsManagerPanel, message: Record<string, unknown>) => Promise<void> | void> = {
    navigateList: () => this.handleNavigateList(),
    addConnection: () => this.handleAddConnection(),
    editConnection: m => this.handleEditConnection(m),
    removeConnection: m => this.handleRemoveConnection(m),
    addBoard: m => this.handleAddBoardCommand(m),
    removeBoard: m => this.handleRemoveBoard(m),
    updateConnectionField: m => this.handleUpdateConnectionField(m),
    testConnection: () => this.handleTestConnection(),
    saveConnection: () => this.handleSaveConnection(),
    toggleBoardSelection: m => this.handleToggleBoardSelection(m),
    searchBoards: m => this.handleSearchBoards(m),
    addCustomJqlBoard: () => this.handleAddCustomJqlBoard(),
    saveBoardSelection: () => this.handleSaveBoardSelection(),
    refreshBoardPicker: () => this.handleRefreshBoardPicker(),
    disconnectJiraCloud: async () => this.handleDisconnectJiraCloud()
  };

  private handleNavigateList(): void {
    this.state.view = 'list';
    this.state.connectionForm = undefined;
    this.state.boardPicker = undefined;
    this.rerender();
  }

  private handleAddConnection(): void {
    this.state.view = 'connection';
    this.state.connectionForm = createNewConnectionForm();
    this.rerender();
  }

  private async handleDisconnectJiraCloud(): Promise<void> {
    try {
      await vscode.commands.executeCommand('ticketManager.disconnectJiraCloud');
      this.state.view = 'list';
      this.state.connectionForm = undefined;
      this.state.boardPicker = undefined;
      this.rerender();
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to disconnect Jira Cloud: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleEditConnection(message: Record<string, unknown>): Promise<void> {
    const id = stringField(message, 'connectionId');
    const connection = id ? this.connectionStore.getConnection(id) : undefined;
    if (connection) {
      this.state.view = 'connection';
      this.state.connectionForm = await this.buildEditForm(connection);
      this.rerender();
    }
  }

  private async handleRemoveConnection(message: Record<string, unknown>): Promise<void> {
    const id = stringField(message, 'connectionId');
    if (id) {
      await this.removeConnectionWithConfirm(id);
      this.rerender();
    }
  }

  private handleAddBoardCommand(message: Record<string, unknown>): void {
    const id = stringField(message, 'connectionId');
    if (id) {
      const connection = this.connectionStore.getConnection(id);
      if (!connection || !supportsManualBoardSelection(connection.mode)) {
        return;
      }
      this.applyInitialAction({ kind: 'addBoard', connectionId: id });
      this.rerender();
    }
  }

  private async handleRemoveBoard(message: Record<string, unknown>): Promise<void> {
    const connectionId = stringField(message, 'connectionId');
    const boardId = stringField(message, 'boardId');
    if (connectionId && boardId) {
      await this.connectionStore.removeTrackedBoard({ connectionId, boardId });
      this.rerender();
    }
  }

  private handleUpdateConnectionField(message: Record<string, unknown>): void {
    if (!this.state.connectionForm) {
      return;
    }
    const field = stringField(message, 'field');
    if (field) {
      const previousMode = this.state.connectionForm.mode;
      this.applyConnectionFormUpdate(field, message.value);
      // Avoid full webview replacement on every keystroke. Only rerender when
      // the mode changes because that swaps the dynamic field set.
      if (field === 'mode' && this.state.connectionForm.mode !== previousMode) {
        this.rerender();
      }
    }
  }

  private async handleTestConnection(): Promise<void> {
    if (this.state.connectionForm) {
      await this.testCurrentConnectionForm();
      this.rerender();
    }
  }

  private async handleSaveConnection(): Promise<void> {
    if (this.state.connectionForm) {
      await this.saveCurrentConnectionForm();
      this.rerender();
    }
  }

  private handleToggleBoardSelection(message: Record<string, unknown>): void {
    const boardId = stringField(message, 'boardId');
    if (!boardId || !this.state.boardPicker) {
      return;
    }
    if (this.state.boardPicker.selectedBoardIds.has(boardId)) {
      this.state.boardPicker.selectedBoardIds.delete(boardId);
    } else {
      this.state.boardPicker.selectedBoardIds.add(boardId);
    }
    this.rerender();
  }

  private handleSearchBoards(message: Record<string, unknown>): void {
    if (this.state.boardPicker) {
      this.state.boardPicker.search = typeof message.value === 'string' ? message.value : '';
    }
  }

  private async handleAddCustomJqlBoard(): Promise<void> {
    const picker = this.state.boardPicker;
    if (!picker) {
      return;
    }
    const connection = this.connectionStore.getConnection(picker.connectionId);
    if (!connection || (connection.mode !== 'jiraapi' && connection.mode !== 'jira')) {
      return;
    }

    try {
      const boardName = await vscode.window.showInputBox({
        title: 'Custom Jira Cloud Board',
        prompt: 'Display name for this local JQL board',
        value: 'Custom JQL Board',
        ignoreFocusOut: true,
        validateInput: value => (value.trim().length > 0 ? undefined : 'Board name is required.')
      });
      if (boardName === undefined) {
        return;
      }

      const jql = await vscode.window.showInputBox({
        title: 'Custom Jira Cloud Board',
        prompt: 'Enter the Jira JQL query for this local board',
        ignoreFocusOut: true,
        validateInput: value => (value.trim().length > 0 ? undefined : 'JQL is required.')
      });
      if (jql === undefined) {
        return;
      }

      const trimmedName = boardName.trim();
      const trimmedJql = jql.trim();
      const boardId = `jql:custom:${encodeURIComponent(trimmedJql)}`;

      const service = await this.backendRouter.serviceFor(picker.connectionId);
      const jqlValidator = service as unknown as { validateBoardJql?: (query: string) => Promise<void> };
      if (typeof jqlValidator.validateBoardJql === 'function') {
        await jqlValidator.validateBoardJql(trimmedJql);
      }

      const existing = picker.boards.find(board => board.id === boardId);
      if (existing) {
        existing.name = trimmedName;
        const rawPayload = isRecord(existing.raw) ? existing.raw : {};
        existing.raw = { ...rawPayload, jql: trimmedJql, custom: true };
      } else {
        picker.boards.unshift({
          id: boardId,
          name: trimmedName,
          type: 'jql',
          raw: { jql: trimmedJql, custom: true }
        });
      }

      picker.selectedBoardIds.add(boardId);
      this.rerender();
    } catch (error) {
      await vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private async handleSaveBoardSelection(): Promise<void> {
    await this.saveSelectedBoards();
    this.rerender();
  }

  private handleRefreshBoardPicker(): void {
    if (this.state.boardPicker) {
      void this.refreshBoardPicker(this.state.boardPicker.connectionId);
    }
  }

  private rerender(): void {
    if (this.panel) {
      this.panel.webview.html = this.getHtml();
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Connection form: editing
  // ──────────────────────────────────────────────────────────────────

  private async buildEditForm(connection: Connection): Promise<ConnectionFormState> {
    const settings = connection.settings ?? {};
    const form: ConnectionFormState = {
      mode: connection.mode,
      isEditing: true,
      connectionId: connection.id,
      name: connection.name,
      settings: { ...settings },
      secrets: {},
      testResult: undefined,
      isTesting: false,
      isSaving: false,
      saveError: undefined
    };
    // Pre-fill secrets so the user can edit/clear them.
    for (const name of secretNamesForMode(connection.mode)) {
      const value = await this.connectionStore.getSecret(connection.id, name);
      if (value) {
        form.secrets[name] = value;
      }
    }
    return form;
  }

  private applyConnectionFormUpdate(field: string, rawValue: unknown): void {
    const form = this.state.connectionForm;
    if (!form) {
      return;
    }
    if (field === 'name') {
      form.name = typeof rawValue === 'string' ? rawValue : '';
      return;
    }
    if (field === 'mode') {
      const next = typeof rawValue === 'string' ? (rawValue as BackendMode) : form.mode;
      if (next !== form.mode) {
        form.mode = next;
        form.settings = {};
        form.secrets = {};
        form.testResult = undefined;
      }
      return;
    }
    if (field.startsWith('secret:')) {
      const secretName = field.slice('secret:'.length);
      form.secrets[secretName] = typeof rawValue === 'string' ? rawValue : '';
      return;
    }
    // Otherwise: regular setting field.
    if (
      typeof rawValue === 'string' ||
      typeof rawValue === 'boolean' ||
      rawValue === null ||
      Array.isArray(rawValue)
    ) {
      form.settings[field] = rawValue;
    }
  }

  private async testCurrentConnectionForm(): Promise<void> {
    const form = this.state.connectionForm;
    if (!form) {
      return;
    }
    form.isTesting = true;
    form.testResult = undefined;
    this.rerender();
    try {
      // Persist a temporary connection so the router can instantiate against it.
      const connection = await this.materializeFormConnection(form, { temporary: true });
      const service = await this.backendRouter.serviceFor(connection.id);
      const result = await service.checkConnection();
      form.testResult = result;
    } catch (error) {
      form.testResult = {
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        toolCount: 0
      };
    } finally {
      form.isTesting = false;
    }
  }

  private async saveCurrentConnectionForm(): Promise<void> {
    const form = this.state.connectionForm;
    if (!form) {
      return;
    }
    form.isSaving = true;
    form.saveError = undefined;
    this.rerender();
    try {
      const connection = await this.materializeFormConnection(form, { temporary: false });
      // Auto-synthesize one board for modes without discoverable boards so
      // the explicit-assignment flow stays uniform.
      if (autoSynthesizesBoard(connection.mode)) {
        const canonicalBoard = createSynthesizedTrackedBoard(connection);
        if (canonicalBoard) {
          const existing = this.connectionStore.getTrackedBoardsForConnection(connection.id);
          const existingCanonical = existing.find(board => board.boardId === canonicalBoard.boardId);

          if (existingCanonical) {
            if (existingCanonical.displayName !== canonicalBoard.displayName) {
              await this.connectionStore.updateTrackedBoard(canonicalBoard);
            }
          } else {
            await this.connectionStore.addTrackedBoard(canonicalBoard);
          }

          for (const board of existing) {
            if (board.boardId !== canonicalBoard.boardId) {
              await this.connectionStore.removeTrackedBoard({
                connectionId: connection.id,
                boardId: board.boardId
              });
            }
          }
        }
        this.state.view = 'list';
        this.state.connectionForm = undefined;
      } else {
        // Chain into the board picker for backends with discoverable boards.
        this.state.connectionForm = undefined;
        this.applyInitialAction({ kind: 'addBoard', connectionId: connection.id });
      }
    } catch (error) {
      form.saveError = error instanceof Error ? error.message : String(error);
    } finally {
      form.isSaving = false;
    }
  }

  /**
   * Persists the form into a `Connection` (create or update) and writes any
   * non-empty secrets to SecretStorage. Returns the resulting connection.
   * When `temporary` is true the connection is still persisted (so the router
   * can resolve it) but the panel state continues to track it as an in-flight
   * form for further edits.
   */
  private async materializeFormConnection(
    form: ConnectionFormState,
    options: { temporary: boolean }
  ): Promise<Connection> {
    const trimmedName = form.name.trim();
    if (!trimmedName) {
      throw new Error('Connection name is required.');
    }

    let id = form.connectionId;
    let isNew = false;
    if (!id) {
      id = this.connectionStore.generateConnectionId(trimmedName);
      isNew = true;
      form.connectionId = id;
    } else if (!this.connectionStore.getConnection(id)) {
      // Recover from partial saves where an id was generated in the form but
      // the settings write failed before the connection was actually persisted.
      isNew = true;
    }

    const connection: Connection = {
      id,
      name: trimmedName,
      mode: form.mode,
      settings: pruneSettings(form.settings)
    };

    if (isNew) {
      await this.connectionStore.addConnection(connection);
    } else {
      await this.connectionStore.updateConnection(connection);
    }

    // Persist secrets.
    for (const [name, value] of Object.entries(form.secrets)) {
      const trimmed = typeof value === 'string' ? value.trim() : '';
      if (trimmed.length > 0) {
        await this.connectionStore.setSecret(id, name, trimmed);
        await this.connectionStore.trackSecretName(id, name);
      } else if (form.isEditing || options.temporary) {
        await this.connectionStore.setSecret(id, name, undefined);
      }
    }

    // Evict any previously-cached service so the next serviceFor() rebuilds
    // against the updated settings/secrets.
    return connection;
  }

  private async removeConnectionWithConfirm(connectionId: string): Promise<void> {
    const connection = this.connectionStore.getConnection(connectionId);
    if (!connection) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Remove connection "${connection.name}"? Its tracked boards and stored secrets will also be removed.`,
      { modal: true },
      'Remove'
    );
    if (answer === 'Remove') {
      await this.connectionStore.removeConnection(connectionId);
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Board picker
  // ──────────────────────────────────────────────────────────────────

  private async refreshBoardPicker(connectionId: string): Promise<void> {
    if (!this.state.boardPicker) {
      return;
    }
    this.state.boardPicker.loading = true;
    this.state.boardPicker.errorMessage = undefined;
    this.rerender();
    try {
      const service = await this.backendRouter.serviceFor(connectionId);
      const boards = await service.getBoards({ projectKeys: [], types: [], searchText: '' });
      if (this.state.boardPicker?.connectionId === connectionId) {
        const tracked = this.connectionStore.getTrackedBoardsForConnection(connectionId);
        const trackedIds = new Set(tracked.map(b => b.boardId));
        this.state.boardPicker.boards = boards;
        this.state.boardPicker.selectedBoardIds = new Set(trackedIds);
        this.state.boardPicker.loading = false;
      }
    } catch (error) {
      if (this.state.boardPicker?.connectionId === connectionId) {
        this.state.boardPicker.loading = false;
        this.state.boardPicker.boards = [];
        this.state.boardPicker.errorMessage =
          error instanceof Error ? error.message : String(error);
      }
    }
    this.rerender();
  }

  private async saveSelectedBoards(): Promise<void> {
    const picker = this.state.boardPicker;
    if (!picker) {
      return;
    }
    const tracked = this.connectionStore.getTrackedBoardsForConnection(picker.connectionId);
    const trackedById = new Map(tracked.map(b => [b.boardId, b]));

    const toAdd: TrackedBoard[] = [];
    for (const boardId of picker.selectedBoardIds) {
      if (!trackedById.has(boardId)) {
        const board = picker.boards.find(b => b.id === boardId);
        toAdd.push({
          connectionId: picker.connectionId,
          boardId,
          displayName: board?.name ?? boardId
        });
      }
    }
    if (toAdd.length > 0) {
      await this.connectionStore.addTrackedBoards(toAdd);
    }

    for (const board of tracked) {
      if (!picker.selectedBoardIds.has(board.boardId)) {
        await this.connectionStore.removeTrackedBoard({
          connectionId: picker.connectionId,
          boardId: board.boardId
        });
      }
    }

    this.state.view = 'list';
    this.state.boardPicker = undefined;
  }

  // ──────────────────────────────────────────────────────────────────
  // Rendering
  // ──────────────────────────────────────────────────────────────────

  private getHtml(): string {
    const nonce = createNonce();
    const body = this.renderBody();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <style>${getCss()}</style>
</head>
<body>
  <div class="manager">
    ${body}
  </div>
  <script nonce="${nonce}">${getScript()}</script>
</body>
</html>`;
  }

  private renderBody(): string {
    if (this.state.view === 'connection') {
      return this.renderConnectionForm();
    }
    if (this.state.view === 'boards') {
      return this.renderBoardPicker();
    }
    return this.renderList();
  }

  private renderList(): string {
    const connections = this.connectionStore.getConnections();
    const tracked = this.connectionStore.getTrackedBoards();
    const headerHtml = `
      <header class="manager-header">
        <div>
          <h1>Connections &amp; Boards</h1>
          <p class="subtle">Manage backend connections and the boards you track from each.</p>
        </div>
        <button class="primary" data-action="addConnection">+ Add Connection</button>
      </header>
    `;

    if (connections.length === 0) {
      return `${headerHtml}
        <section class="empty-state">
          <h2>Welcome to Ticket Manager</h2>
          <p>You have no backend connections yet. Add one to start tracking boards.</p>
          <button class="primary large" data-action="addConnection">+ Add your first connection</button>
        </section>
      `;
    }

    const rows = connections
      .map(connection => this.renderConnectionRow(connection, tracked))
      .join('');
    
    const jiraCloudConnection = connections.find(c => c.mode === 'jira');
    const jiraCloudActionHtml = jiraCloudConnection
      ? `<div class="jira-cloud-action">
           <button class="danger" data-action="disconnectJiraCloud">Disconnect Jira Cloud</button>
           <p class="subtle">Clears your OAuth token and requires reconnecting to refresh permissions.</p>
         </div>`
      : '';
    
    return `${headerHtml}
      ${jiraCloudActionHtml}
      <section class="connection-list">${rows}</section>
    `;
  }

  private renderConnectionRow(connection: Connection, tracked: TrackedBoard[]): string {
    const boards = getDisplayedTrackedBoards(connection, tracked.filter(b => b.connectionId === connection.id));
    const canAddBoard = supportsManualBoardSelection(connection.mode);
    const boardsHtml = boards.length === 0
      ? `<div class="boards-empty">No tracked boards yet.</div>`
      : boards
          .map(
            board => `
            <div class="board-row">
              <span class="board-name">${esc(board.displayName ?? board.boardId)}</span>
              <span class="board-id">${esc(board.boardId)}</span>
              <button class="link danger"
                data-action="removeBoard"
                data-connection-id="${esc(connection.id)}"
                data-board-id="${esc(board.boardId)}">Remove</button>
            </div>`
          )
          .join('');

    return `
      <article class="connection-card">
        <header>
          <div class="connection-title">
            <span class="mode-badge mode-${esc(connection.mode)}">${esc(modeLabel(connection.mode))}</span>
            <h2>${esc(connection.name)}</h2>
            <span class="connection-id">${esc(connection.id)}</span>
          </div>
          <div class="actions">
            ${canAddBoard ? `<button data-action="addBoard" data-connection-id="${esc(connection.id)}">+ Add Board</button>` : ''}
            <button data-action="editConnection" data-connection-id="${esc(connection.id)}">Edit</button>
            <button class="danger" data-action="removeConnection" data-connection-id="${esc(connection.id)}">Remove</button>
          </div>
        </header>
        <div class="boards">${boardsHtml}</div>
      </article>
    `;
  }

  private renderConnectionForm(): string {
    const form = this.state.connectionForm;
    if (!form) {
      return this.renderList();
    }
    const title = form.isEditing ? 'Edit Connection' : 'Add Connection';
    const modeOptions = SUPPORTED_MODES
      .map(
        mode => `
        <option value="${esc(mode)}" ${form.mode === mode ? 'selected' : ''}>${esc(modeLabel(mode))}</option>
      `
      )
      .join('');

    const testHtml = form.testResult
      ? `<div class="test-result test-${esc(form.testResult.status)}">
           <strong>${esc(form.testResult.status.toUpperCase())}</strong>
           <span>${esc(form.testResult.message)}</span>
         </div>`
      : '';

    const errorHtml = form.saveError
      ? `<div class="error-banner">${esc(form.saveError)}</div>`
      : '';

    return `
      <header class="manager-header">
        <div>
          <h1>${esc(title)}</h1>
          <p class="subtle">${form.isEditing ? 'Update the settings for this connection.' : 'Configure a backend Ticket Manager can connect to.'}</p>
        </div>
        <button data-action="navigateList">Back to list</button>
      </header>

      <section class="form">
        ${errorHtml}

        <label class="field">
          <span>Connection name</span>
          <input type="text" data-field="name" value="${esc(form.name)}" placeholder="e.g. AA Jira Prod" />
        </label>

        <label class="field">
          <span>Backend type</span>
          <select data-field="mode" ${form.isEditing ? 'disabled' : ''}>${modeOptions}</select>
          ${form.isEditing ? '<small class="subtle">Backend type cannot be changed after creation.</small>' : ''}
        </label>

        ${this.renderConnectionModeFields(form)}

        ${testHtml}

        <div class="form-actions">
          <button data-action="testConnection" ${form.isTesting ? 'disabled' : ''}>
            ${form.isTesting ? 'Testing…' : 'Test connection'}
          </button>
          <button class="primary" data-action="saveConnection" ${form.isSaving ? 'disabled' : ''}>
            ${form.isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </section>
    `;
  }

  private renderConnectionModeFields(form: ConnectionFormState): string {
    switch (form.mode) {
      case 'jiraapi':
        return [
          textField(form, 'baseUrl', 'Site URL', 'https://your-tenant.atlassian.net'),
          secretField(form, 'token', 'API token (Atlassian PAT or basic-auth token)'),
          textField(form, 'epicKey', 'Linked epic key (optional)', 'PROJ-123'),
          textField(form, 'epicBoardName', 'Epic board name (optional)', 'My Epic Board'),
          textField(form, 'boardJql', 'Board JQL (optional)', 'project = PROJ AND status != Done'),
          textField(form, 'boardName', 'Default board name (optional)', '')
        ].join('');
      case 'jira':
        return [
          textField(form, 'url', 'Site URL', 'https://your-tenant.atlassian.net'),
          textField(form, 'clientId', 'OAuth client ID', ''),
          secretField(form, 'oauthClientSecret', 'OAuth client secret'),
          textField(form, 'cloudId', 'Cloud ID (optional, auto-detected after OAuth)', '')
        ].join('');
      case 'gitlab':
        return [
          textField(form, 'url', 'GitLab base URL', 'https://gitlab.com'),
          secretField(form, 'apiKey', 'API key (Personal Access Token)'),
          textField(form, 'projectPath', 'Project path (optional)', 'group/project')
        ].join('');
      case 'livefolder':
        return [
          textField(form, 'path', 'Folder path', String.raw`C:\path\to\folder`),
          textField(form, 'projectKey', 'Project key', 'LIVE'),
          textField(form, 'projectName', 'Project name', 'Live Folder Project'),
          booleanField(form, 'allowIssueCreation', 'Allow issue creation in this folder')
        ].join('');
      case 'github':
        return [
          textField(form, 'url', 'GitHub URL', 'https://github.com'),
          textField(form, 'owner', 'Owner/org', ''),
          secretField(form, 'pat', 'Personal access token')
        ].join('');
      case 'userworkspace':
        return `<p class="subtle">User Workspace stores boards locally — no further configuration needed.</p>`;
      case 'demo':
        return `<p class="subtle">Demo mode uses sample data — no further configuration needed.</p>`;
      default:
        return '';
    }
  }

  private renderBoardPicker(): string {
    const picker = this.state.boardPicker;
    if (!picker) {
      return this.renderList();
    }
    const connection = this.connectionStore.getConnection(picker.connectionId);
    const title = connection ? `Tracked boards — ${connection.name}` : 'Tracked boards';

    let content: string;
    if (picker.loading) {
      content = `<div class="loading">Loading boards…</div>`;
    } else if (picker.errorMessage) {
      content = `
        <div class="error-banner">${esc(picker.errorMessage)}</div>
        <button data-action="refreshBoardPicker">Retry</button>
      `;
    } else if (picker.boards.length === 0) {
      content = `<div class="empty-state-inline">No boards reported by this backend.</div>`;
    } else {
      const search = (picker.search ?? '').toLowerCase();
      const filtered = search
        ? picker.boards.filter(b => `${b.name} ${b.id}`.toLowerCase().includes(search))
        : picker.boards;
      content = `
        <input type="search" class="board-search" placeholder="Filter boards…"
               value="${esc(picker.search ?? '')}" data-field="boardSearch" />
        <div class="board-picker-list">
          ${filtered
            .map(
              b => `
              <label class="board-picker-row">
                <input type="checkbox"
                       data-board-id="${esc(b.id)}"
                       ${picker.selectedBoardIds.has(b.id) ? 'checked' : ''} />
                <span class="board-name">${esc(b.name)}</span>
                <span class="board-id">${esc(b.id)}</span>
              </label>`
            )
            .join('')}
        </div>
      `;
    }

    return `
      <header class="manager-header">
        <div>
          <h1>${esc(title)}</h1>
          <p class="subtle">Pick the boards you want Ticket Manager to track from this connection.</p>
        </div>
        <button data-action="navigateList">Back to list</button>
      </header>
      <section class="form">
        ${content}
        <div class="form-actions">
          ${connection && (connection.mode === 'jiraapi' || connection.mode === 'jira')
            ? '<button data-action="addCustomJqlBoard">+ Add Custom JQL Board</button>'
            : ''}
          <button data-action="navigateList">Cancel</button>
          <button class="primary" data-action="saveBoardSelection">Save selection</button>
        </div>
      </section>
    `;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Types & helpers
// ─────────────────────────────────────────────────────────────────────

type View = 'list' | 'connection' | 'boards';

interface PanelState {
  view: View;
  connectionForm?: ConnectionFormState;
  boardPicker?: BoardPickerState;
}

interface ConnectionFormState {
  mode: BackendMode;
  isEditing: boolean;
  connectionId?: string;
  name: string;
  settings: Record<string, unknown>;
  secrets: Record<string, string>;
  testResult?: ConnectionCheck;
  isTesting: boolean;
  isSaving: boolean;
  saveError?: string;
}

interface BoardPickerState {
  connectionId: string;
  loading: boolean;
  boards: Board[];
  selectedBoardIds: Set<string>;
  errorMessage?: string;
  search?: string;
}

export type InitialAction =
  | { kind: 'addConnection' }
  | { kind: 'addBoard'; connectionId: string };

const SUPPORTED_MODES: readonly BackendMode[] = [
  'jiraapi',
  'gitlab',
  'livefolder',
  'userworkspace',
  'demo'
];

function createInitialState(): PanelState {
  return { view: 'list' };
}

function createNewConnectionForm(): ConnectionFormState {
  return {
    mode: 'jiraapi',
    isEditing: false,
    name: '',
    settings: {},
    secrets: {},
    isTesting: false,
    isSaving: false
  };
}

function modeLabel(mode: BackendMode): string {
  switch (mode) {
    case 'jira':
      return 'Jira Cloud (OAuth)';
    case 'jiraapi':
      return 'Jira REST (API token)';
    case 'gitlab':
      return 'GitLab';
    case 'livefolder':
      return 'Live Folder';
    case 'userworkspace':
      return 'User Workspace';
    case 'github':
      return 'GitHub';
    case 'demo':
      return 'Demo';
    default:
      return mode;
  }
}

function autoSynthesizesBoard(mode: BackendMode): boolean {
  return mode === 'livefolder' || mode === 'userworkspace' || mode === 'demo';
}

function supportsManualBoardSelection(mode: BackendMode): boolean {
  return mode !== 'livefolder';
}

function getDisplayedTrackedBoards(connection: Connection, boards: TrackedBoard[]): TrackedBoard[] {
  if (connection.mode !== 'livefolder') {
    return boards;
  }

  const canonical = createSynthesizedTrackedBoard(connection);
  if (!canonical) {
    return boards;
  }

  return boards.length > 0 ? [canonical] : [];
}

function createSynthesizedTrackedBoard(connection: Connection): TrackedBoard | undefined {
  if (connection.mode === 'livefolder') {
    const projectKey = getConnectionStringSetting(connection, 'projectKey') || 'LIVE';
    const projectName = getConnectionStringSetting(connection, 'projectName') || 'Live Folder';
    return {
      connectionId: connection.id,
      boardId: `livefolder-${projectKey.toLowerCase()}`,
      displayName: `${projectName} (Live)`
    };
  }

  if (connection.mode === 'userworkspace' || connection.mode === 'demo') {
    return {
      connectionId: connection.id,
      boardId: connection.id,
      displayName: connection.name
    };
  }

  return undefined;
}

function getConnectionStringSetting(connection: Connection, key: string): string | undefined {
  const value = connection.settings?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function secretNamesForMode(mode: BackendMode): readonly string[] {
  switch (mode) {
    case 'jiraapi':
      return ['token'];
    case 'jira':
      return ['oauthClientSecret'];
    case 'gitlab':
      return ['apiKey'];
    case 'github':
      return ['pat'];
    default:
      return [];
  }
}

function pruneSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(settings)) {
    if (v === undefined || v === null) {
      continue;
    }
    if (typeof v === 'string' && v.trim().length === 0) {
      continue;
    }
    out[k] = v;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(message: Record<string, unknown>, name: string): string | undefined {
  const value = message[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function createNonce(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function textField(form: ConnectionFormState, key: string, label: string, placeholder: string): string {
  const value = typeof form.settings[key] === 'string' ? form.settings[key] : '';
  return `
    <label class="field">
      <span>${esc(label)}</span>
      <input type="text" data-field="${esc(key)}" value="${esc(value)}" placeholder="${esc(placeholder)}" />
    </label>
  `;
}

function secretField(form: ConnectionFormState, key: string, label: string): string {
  const value = form.secrets[key] ?? '';
  return `
    <label class="field">
      <span>${esc(label)}</span>
      <input type="password" data-field="secret:${esc(key)}" value="${esc(value)}" placeholder="${esc('•'.repeat(8))}" />
      <small class="subtle">Stored securely in the OS keychain.</small>
    </label>
  `;
}

function booleanField(form: ConnectionFormState, key: string, label: string): string {
  const checked = form.settings[key] === true;
  return `
    <label class="field-inline">
      <input type="checkbox" data-field="${esc(key)}" ${checked ? 'checked' : ''} />
      <span>${esc(label)}</span>
    </label>
  `;
}

function getCss(): string {
  return `
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 0; }
    .manager { max-width: 880px; margin: 0 auto; padding: 24px; }
    .manager-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 24px; }
    .manager-header h1 { margin: 0 0 4px 0; font-size: 1.4rem; }
    .subtle { color: var(--vscode-descriptionForeground); font-size: 0.9rem; margin: 0; }
    .empty-state { text-align: center; padding: 60px 20px; border: 1px dashed var(--vscode-panel-border); border-radius: 6px; }
    .empty-state h2 { margin-top: 0; }
    .connection-card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 16px; margin-bottom: 16px; }
    .connection-card header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
    .connection-title { display: flex; flex-direction: column; gap: 4px; }
    .connection-title h2 { margin: 0; font-size: 1.1rem; }
    .connection-id { font-family: var(--vscode-editor-font-family); font-size: 0.8rem; color: var(--vscode-descriptionForeground); }
    .mode-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.75rem; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); width: fit-content; }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .boards { margin-top: 12px; border-top: 1px solid var(--vscode-panel-border); padding-top: 12px; display: flex; flex-direction: column; gap: 6px; }
    .boards-empty { color: var(--vscode-descriptionForeground); font-size: 0.85rem; padding: 4px 0; }
    .board-row { display: grid; grid-template-columns: 1fr auto auto; gap: 12px; align-items: center; padding: 4px 0; }
    .board-name { font-weight: 500; }
    .board-id { font-family: var(--vscode-editor-font-family); font-size: 0.8rem; color: var(--vscode-descriptionForeground); }
    button { padding: 6px 12px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border-radius: 3px; cursor: pointer; font-family: inherit; font-size: 0.9rem; }
    button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
    button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    button.primary.large { padding: 10px 20px; font-size: 1rem; margin-top: 16px; }
    button.link { background: transparent; border: none; color: var(--vscode-textLink-foreground); padding: 2px 6px; }
    button.danger { color: var(--vscode-errorForeground); }
    button.link.danger { color: var(--vscode-errorForeground); }
    .form { display: flex; flex-direction: column; gap: 16px; max-width: 640px; }
    .field { display: flex; flex-direction: column; gap: 4px; }
    .field span { font-weight: 500; font-size: 0.9rem; }
    .field input, .field select { padding: 6px 10px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; font-family: inherit; font-size: 0.9rem; }
    .field-inline { display: flex; align-items: center; gap: 8px; }
    .form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
    .test-result { padding: 10px 12px; border-radius: 4px; display: flex; gap: 12px; align-items: flex-start; font-size: 0.9rem; }
    .test-ok { background: rgba(0,180,0,0.1); border: 1px solid rgba(0,180,0,0.3); }
    .test-warning { background: rgba(255,180,0,0.1); border: 1px solid rgba(255,180,0,0.3); }
    .test-error { background: rgba(220,50,50,0.1); border: 1px solid rgba(220,50,50,0.3); }
    .error-banner { background: rgba(220,50,50,0.12); border: 1px solid rgba(220,50,50,0.35); border-radius: 4px; padding: 8px 12px; color: var(--vscode-errorForeground); font-size: 0.9rem; }
    .loading { color: var(--vscode-descriptionForeground); padding: 12px 0; font-style: italic; }
    .board-search { padding: 6px 10px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; }
    .board-picker-list { max-height: 360px; overflow-y: auto; border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: 4px; }
    .board-picker-row { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; padding: 6px 8px; align-items: center; cursor: pointer; }
    .board-picker-row:hover { background: var(--vscode-list-hoverBackground); }
    .empty-state-inline { color: var(--vscode-descriptionForeground); padding: 12px 0; }
    .jira-cloud-action { background: rgba(100, 150, 200, 0.08); border: 1px solid rgba(100, 150, 200, 0.25); border-radius: 6px; padding: 12px 16px; margin-bottom: 16px; }
    .jira-cloud-action button { margin: 0; }
  `;
}

function getScript(): string {
  return `
    const vscode = acquireVsCodeApi();
    function post(message) { vscode.postMessage(message); }
    function applyBoardSearchFilter(query) {
      const q = String(query || '').toLowerCase().trim();
      const rows = document.querySelectorAll('.board-picker-row');
      for (const row of rows) {
        const text = (row.textContent || '').toLowerCase();
        row.style.display = !q || text.includes(q) ? '' : 'none';
      }
    }
    document.addEventListener('click', event => {
      const target = event.target.closest('[data-action]');
      if (!target) return;
      const action = target.dataset.action;
      const connectionId = target.dataset.connectionId;
      const boardId = target.dataset.boardId;
      post({ command: action, connectionId, boardId });
    });
    document.addEventListener('input', event => {
      const el = event.target;
      const field = el.dataset?.field;
      if (!field) return;
      if (field === 'boardSearch') {
        applyBoardSearchFilter(el.value);
        post({ command: 'searchBoards', value: el.value });
        return;
      }
      const value = el.type === 'checkbox' ? el.checked : el.value;
      post({ command: 'updateConnectionField', field, value });
    });
    document.addEventListener('change', event => {
      const el = event.target;
      const field = el.dataset?.field;
      if (field && field !== 'boardSearch') {
        const value = el.type === 'checkbox' ? el.checked : el.value;
        post({ command: 'updateConnectionField', field, value });
      }
      if (el.type === 'checkbox' && el.dataset.boardId) {
        post({ command: 'toggleBoardSelection', boardId: el.dataset.boardId });
      }
    });
  `;
}
