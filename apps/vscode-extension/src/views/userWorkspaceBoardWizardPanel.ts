import * as vscode from 'vscode';
import {
  discoverPlanFolders,
  discoverRepositoryFolders
} from '@praxis/core';
import { toStoredFolderPath } from '@praxis/core';
import {
  planBoardDrafts,
  validateBoardDrafts,
  type BoardDraftRow
} from '@praxis/core';

export interface UserWorkspaceBoardDraft {
  name: string;
  projectKey: string;
  projectName: string;
  liveFolderPath: string;
}

type RepoDetails = BoardDraftRow;

interface WizardState {
  step: 'folder' | 'details';
  selectedFolder: string;
  repositories: RepoDetails[];
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function createInitialState(): WizardState {
  return { step: 'folder', selectedFolder: '', repositories: [] };
}

export class UserWorkspaceBoardWizardPanel {
  private panel: vscode.WebviewPanel | undefined;
  private state = createInitialState();
  private resolver: ((drafts: UserWorkspaceBoardDraft[] | undefined) => void) | undefined;
  private existingPaths = new Set<string>();
  private existingKeys = new Set<string>();

  public open(existingPaths: string[] = [], existingKeys: string[] = []): Promise<UserWorkspaceBoardDraft[] | undefined> {
    return new Promise(resolve => {
      this.resolver = resolve;
      this.state = createInitialState();
      this.existingPaths = new Set(existingPaths.map(value => toStoredFolderPath(value).toLowerCase()));
      this.existingKeys = new Set(existingKeys.map(value => value.trim().toUpperCase()));
      this.panel = vscode.window.createWebviewPanel(
        'ticketManager.userWorkspaceBoardWizard',
        'Create User Workspace Boards',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.resolver?.(undefined);
        this.resolver = undefined;
      });
      this.panel.webview.onDidReceiveMessage(message => { void this.handleMessage(message); }, undefined, []);
      this.panel.webview.html = this.getHtml();
    });
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message) || typeof message.command !== 'string') {
      return;
    }
    switch (message.command) {
      case 'browse':
        await this.browseForFolder();
        break;
      case 'findRepositories':
        await this.findRepositories(typeof message.folder === 'string' ? message.folder : this.state.selectedFolder);
        break;
      case 'updateDetails':
        this.updateRepository(message);
        break;
      case 'backToFolder':
        this.state.step = 'folder';
        this.rerender();
        break;
      case 'create': {
        const validationError = this.validateRepositories();
        if (validationError) {
          void vscode.window.showErrorMessage(validationError);
          return;
        }
        // Nothing is written to disk here. A board is just a folder path;
        // ticket files are created on demand when issues are added.
        this.resolve(
          this.state.repositories
            .filter(repository => !repository.alreadyAdded)
            .map(({
              repositoryName: _repositoryName,
              repositoryRootPath: _repositoryRootPath,
              alreadyAdded: _alreadyAdded,
              ...draft
            }) => draft)
        );
        break;
      }
      case 'cancel':
        this.resolve(undefined);
        break;
    }
  }

  private async browseForFolder(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFolders: true,
      canSelectFiles: false,
      openLabel: 'Select Parent Folder',
      title: 'Select folder containing repositories'
    });
    if (uris?.[0]) {
      this.state.selectedFolder = uris[0].fsPath;
      this.rerender();
    }
  }

  private async findRepositories(folder: string): Promise<void> {
    if (!folder.trim()) {
      return;
    }
    try {
      const [matches, gitRepositories] = await Promise.all([
        vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Finding repository plan folders...', cancellable: false },
          async progress => discoverPlanFolders(folder, message => progress.report({ message }))
        ),
        vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Finding Git repositories...', cancellable: false },
          async progress => discoverRepositoryFolders(folder, message => progress.report({ message }))
        )
      ]);
      const rows = planBoardDrafts({
        repositories: gitRepositories.map(rootPath => ({ rootPath })),
        planRoots: matches.map(match => ({
          plansPath: match.plansRootPath,
          featureEntryCount: match.featureEntries.length
        })),
        existingPaths: [...this.existingPaths],
        existingKeys: [...this.existingKeys]
      });
      if (rows.length === 0) {
        void vscode.window.showErrorMessage('No plan folders or Git repositories were found under the selected folder.');
        return;
      }
      this.state.selectedFolder = folder;
      this.state.repositories = rows;
      this.state.step = 'details';
      this.rerender();
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  private updateRepository(message: Record<string, unknown>): void {
    const index = typeof message.index === 'number' ? message.index : -1;
    const repository = this.state.repositories[index];
    if (!repository || repository.alreadyAdded || typeof message.field !== 'string' || typeof message.value !== 'string') {
      return;
    }
    if (message.field === 'name' || message.field === 'projectKey' || message.field === 'projectName') {
      repository[message.field] = message.value;
    }
  }

  private validateRepositories(): string | undefined {
    return validateBoardDrafts(this.state.repositories, [...this.existingKeys]);
  }

  private resolve(value: UserWorkspaceBoardDraft[] | undefined): void {
    this.resolver?.(value);
    this.resolver = undefined;
    this.panel?.dispose();
  }

  private rerender(): void {
    if (this.panel) {
      this.panel.webview.html = this.getHtml();
    }
  }

  private getHtml(): string {
    const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><style>${this.getCss()}</style></head><body><main class="wizard"><h1>Create User Workspace Boards</h1>${this.renderBody()}</main><script nonce="${nonce}">${this.getScript()}</script></body></html>`;
  }

  private renderBody(): string {
    if (this.state.step === 'folder') {
      return `<p class="muted">Choose a parent folder. Each plans folder or Git repository found below it becomes a board. A board is just a folder — tickets are markdown files added to it later, so nothing is written to your repositories now.</p><label for="folder">Parent folder</label><div class="row"><input id="folder" data-folder value="${esc(this.state.selectedFolder)}" placeholder="Select a folder containing repositories"><button data-action="browse">Browse...</button></div><div class="actions"><button data-action="cancel">Cancel</button><button class="primary" data-action="findRepositories">Find repositories</button></div>`;
    }
    const newCount = this.state.repositories.filter(repository => !repository.alreadyAdded).length;
    const rows = this.state.repositories.map((repo, index) => {
      const disabled = repo.alreadyAdded ? ' disabled' : '';
      return `<tr class="${repo.alreadyAdded ? 'existing' : ''}"><td><strong>${esc(repo.repositoryName)}</strong><small>${esc(repo.liveFolderPath)}</small>${repo.alreadyAdded ? '<span class="status">Already added</span>' : ''}</td><td><input aria-label="Project code" data-index="${index}" data-field="projectKey" value="${esc(repo.projectKey)}"${disabled}></td><td><input aria-label="Project name" data-index="${index}" data-field="projectName" value="${esc(repo.projectName)}"${disabled}></td><td><input aria-label="Board name" data-index="${index}" data-field="name" value="${esc(repo.name)}"${disabled}></td></tr>`;
    }).join('');
    return `<p class="muted">Edit all board details below. Existing boards are shown but will not be created again.</p><div class="table-wrap"><table><thead><tr><th>Repository</th><th>Project code</th><th>Project name</th><th>Board name</th></tr></thead><tbody>${rows}</tbody></table></div><div class="actions"><button data-action="backToFolder">Back</button><button class="primary" data-action="create" ${newCount === 0 ? 'disabled' : ''}>Create ${newCount} board${newCount === 1 ? '' : 's'}</button></div>`;
  }

  private getCss(): string {
    return `*{box-sizing:border-box}body{margin:0;padding:24px 16px;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family,sans-serif);font-size:var(--vscode-font-size,13px);line-height:1.5}.wizard{max-width:1180px;margin:0 auto}h1{font-size:1.6em;margin:0 0 8px}.muted{color:var(--vscode-descriptionForeground)}label{display:block;font-weight:600;margin:16px 0 5px}input{width:100%;min-width:120px;padding:7px 8px;border:1px solid var(--vscode-input-border);border-radius:4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font:inherit}input:focus{outline:1px solid var(--vscode-focusBorder)}input:disabled{opacity:.65}.row{display:flex;gap:8px}.row input{flex:1}.actions{display:flex;gap:8px;justify-content:flex-end;margin-top:24px}button{border:1px solid var(--vscode-button-border,transparent);border-radius:4px;padding:7px 12px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);font:inherit;cursor:pointer}button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button:disabled{opacity:.5;cursor:default}button:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}.table-wrap{overflow-x:auto;margin-top:18px;border:1px solid var(--vscode-editorWidget-border);border-radius:6px}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{text-align:left;vertical-align:top;padding:10px;border-bottom:1px solid var(--vscode-editorWidget-border)}th{background:var(--vscode-editorWidget-background);font-weight:600}th:first-child{width:29%}tr:last-child td{border-bottom:0}td small{display:block;color:var(--vscode-descriptionForeground);font-family:var(--vscode-editor-font-family,monospace);overflow-wrap:anywhere;margin-top:2px}.existing{opacity:.7}.status{display:inline-block;margin-top:6px;color:var(--vscode-testing-iconPassed);font-weight:600}@media(max-width:700px){body{padding:16px 8px}.row{flex-direction:column}table{min-width:850px}.actions{flex-wrap:wrap}.actions button{flex:1}}`;
  }

  private getScript(): string {
    return `const api=acquireVsCodeApi();document.addEventListener('input',event=>{const target=event.target;if(target.dataset.field){api.postMessage({command:'updateDetails',index:Number(target.dataset.index),field:target.dataset.field,value:target.value})}});document.addEventListener('click',event=>{const target=event.target.closest('[data-action]');if(!target||target.disabled)return;const action=target.dataset.action;if(action==='findRepositories'){api.postMessage({command:action,folder:document.querySelector('[data-folder]')?.value||''})}else{api.postMessage({command:action})}});`;
  }
}
