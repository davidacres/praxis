/**
 * Replaces window.show*Message / showOpenDialog / withProgress / clipboard / openExternal.
 */
export interface HostBridge {
  showMessage(kind: 'info' | 'warning' | 'error', text: string): void;
  showOpenDialog(opts: { canSelectFolders?: boolean; canSelectFiles?: boolean }): Promise<string[] | undefined>;
  withProgress<T>(title: string, task: () => Promise<T>): Promise<T>;
  openExternal(url: string): Promise<void>;
  copyToClipboard(text: string): Promise<void>;
}
