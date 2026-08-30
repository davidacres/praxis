import * as path from 'node:path';
import { liveFolderFs } from './liveFolderFs';

/**
 * Optional per-plans-root board settings, stored as `board.praxis.json` in the
 * plans root (next to `master-plan.md` / `features/`). When present these values
 * win over the Live Folder connection's settings, so a board's identity travels
 * with its folder instead of living only in the app's `settings.json`.
 *
 * Every field is optional; a missing or malformed file is treated as "no
 * overrides" rather than an error.
 */
export interface BoardConfigFile {
  /** Stable project key for issue ids (e.g. `APP`). */
  projectKey?: string;
  /** Human-readable board / project name. */
  projectName?: string;
  /** Whether the AI and the UI may create new plan files in this folder. */
  allowIssueCreation?: boolean;
}

export const BOARD_CONFIG_FILENAME = 'board.praxis.json';

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Reads `<plansRoot>/board.praxis.json`. Returns `{}` when it is absent or invalid. */
export async function readBoardConfigFile(plansRootPath: string): Promise<BoardConfigFile> {
  let raw: string;
  try {
    raw = await liveFolderFs().readFile(path.join(plansRootPath, BOARD_CONFIG_FILENAME));
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const record = parsed as Record<string, unknown>;
  const config: BoardConfigFile = {};
  const projectKey = readString(record.projectKey);
  if (projectKey) config.projectKey = projectKey;
  const projectName = readString(record.projectName);
  if (projectName) config.projectName = projectName;
  if (typeof record.allowIssueCreation === 'boolean') {
    config.allowIssueCreation = record.allowIssueCreation;
  }
  return config;
}

/** Writes `<plansRoot>/board.praxis.json`, omitting empty fields. */
export async function writeBoardConfigFile(
  plansRootPath: string,
  config: BoardConfigFile
): Promise<void> {
  const body: BoardConfigFile = {};
  if (config.projectKey?.trim()) body.projectKey = config.projectKey.trim();
  if (config.projectName?.trim()) body.projectName = config.projectName.trim();
  if (typeof config.allowIssueCreation === 'boolean') {
    body.allowIssueCreation = config.allowIssueCreation;
  }
  await liveFolderFs().writeFile(
    path.join(plansRootPath, BOARD_CONFIG_FILENAME),
    `${JSON.stringify(body, null, 2)}\n`
  );
}
