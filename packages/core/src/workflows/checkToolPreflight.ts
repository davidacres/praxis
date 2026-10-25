/**
 * Are the tools a workflow's check stages run actually installed?
 *
 * A check stage runs one command, and a missing command is otherwise found out
 * only when the run reaches that stage — after Implement has spent the agent's
 * time. Checking at run start turns that into a refusal in seconds, naming each
 * missing tool, the stages that need it, and how to install it.
 *
 * Pure: the caller supplies `isAvailable`, which looks the command up the way
 * the check runner would spawn it (no shell, the app's PATH).
 */

import type { WorkflowCheckNode, WorkflowNode } from './workflowTypes';

export interface MissingCheckTool {
  command: string;
  /** Names of the stages that run it, in definition order. */
  stages: string[];
  /** How to install it on this platform. */
  install: string;
}

interface InstallHints {
  darwin?: string;
  win32?: string;
  other: string;
}

/** Tools the bundled templates and check presets run that are not part of a normal dev setup. */
const INSTALL_HINTS: Record<string, InstallHints> = {
  semgrep: { darwin: 'brew install semgrep', other: 'pipx install semgrep (or pip install semgrep)' },
  gitleaks: { darwin: 'brew install gitleaks', win32: 'scoop install gitleaks', other: 'download a release from https://github.com/gitleaks/gitleaks/releases' },
  'osv-scanner': { darwin: 'brew install osv-scanner', other: 'go install github.com/google/osv-scanner/v2/cmd/osv-scanner@latest' },
  trivy: { darwin: 'brew install trivy', other: 'see https://trivy.dev/latest/getting-started/installation/' },
  'license-checker': { other: 'npm install -g license-checker' },
  ruff: { darwin: 'brew install ruff', other: 'pipx install ruff' },
  mypy: { other: 'pipx install mypy' },
  pytest: { other: 'pip install pytest pytest-cov' },
  behave: { other: 'pip install behave' },
  dotnet: { other: 'install the .NET SDK from https://dotnet.microsoft.com/download' }
};

export function checkToolInstallHint(command: string, platform: string): string {
  const hints = INSTALL_HINTS[command];
  if (!hints) return `install ${command} and make sure it is on your PATH`;
  return (platform === 'darwin' ? hints.darwin : platform === 'win32' ? hints.win32 : undefined) ?? hints.other;
}

/**
 * The command to look up, or undefined when it cannot be judged before the run:
 * a relative path (`./scripts/lint.sh`) resolves inside the run's worktree,
 * which does not exist yet.
 */
function lookupTarget(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  const isAbsolute = trimmed.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\');
  if (!isAbsolute && /[\\/]/.test(trimmed)) return undefined;
  return trimmed;
}

export function missingCheckTools(
  nodes: WorkflowNode[],
  isAvailable: (command: string) => boolean,
  platform: string
): MissingCheckTool[] {
  const byCommand = new Map<string, MissingCheckTool>();
  const checked = new Map<string, boolean>();
  for (const node of nodes) {
    // `enabled: false` is not skipped: the run engine does not honour it, so a
    // switched-off check stage still runs and still needs its tool.
    if (node.type !== 'check') continue;
    const command = lookupTarget((node as WorkflowCheckNode).command);
    if (!command) continue;
    if (!checked.has(command)) checked.set(command, isAvailable(command));
    if (checked.get(command)) continue;
    const entry = byCommand.get(command) ?? { command, stages: [], install: checkToolInstallHint(command, platform) };
    entry.stages.push(node.name || node.id);
    byCommand.set(command, entry);
  }
  return [...byCommand.values()];
}

/** One message for a refused start, or undefined when nothing is missing. */
export function describeMissingCheckTools(missing: MissingCheckTool[]): string | undefined {
  if (missing.length === 0) return undefined;
  const lines = missing.map(tool => `${tool.command} (needed by ${tool.stages.join(', ')}): ${tool.install}.`);
  const noun = missing.length === 1 ? 'a tool that is' : 'tools that are';
  return `Cannot start this workflow: its check stages need ${noun} not installed. ${lines.join(' ')} Then try again, or change or remove those stages in the workflow.`;
}
