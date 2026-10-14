import { homedir } from 'node:os';
import path from 'node:path';

export function codeIntelligenceDataDirectory(): string {
  if (process.env.PRAXIS_CODE_INTELLIGENCE_DATA_DIRECTORY) return path.resolve(process.env.PRAXIS_CODE_INTELLIGENCE_DATA_DIRECTORY);
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'Praxis', 'code-intelligence');
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Application Support', 'Praxis', 'code-intelligence');
  const xdg = process.env.XDG_DATA_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(homedir(), '.local', 'share'), 'Praxis', 'code-intelligence');
}
