/**
 * Replaces vscode.SecretStorage (context.secrets). VS Code adapter wraps context.secrets
 * directly; Electron adapter backs this with Electron's safeStorage (OS-backed encryption)
 * wrapping values written to a JSON file under app.getPath('userData').
 */
export interface SecretsStore {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
