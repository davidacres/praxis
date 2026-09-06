import * as path from 'node:path';
import { folderFs } from './folderFs';
import type { ProjectWorkflowStage } from '../projects/projectTypes';
import { normalizeWorkflowStages, validateWorkflowStages } from '../projects/projectWorkflow';

/**
 * Optional per-plans-root board settings, stored as `board.praxis.json` in the
 * plans root (next to `master-plan.md` / `features/`). When present these values
 * win over the folder connection's settings, so a board's identity travels
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
  /**
   * The board's columns, in order (FX-BE-045). Absent means "the five statuses
   * folders have always used" — which is what keeps every existing folder board
   * byte-identical. A malformed or invalid workflow is ignored rather than
   * failing the load, in keeping with this file's "no overrides" contract.
   */
  workflow?: ProjectWorkflowStage[];
}

export const BOARD_CONFIG_FILENAME = 'board.praxis.json';

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Reads `<plansRoot>/board.praxis.json`. Returns `{}` when it is absent or invalid. */
export async function readBoardConfigFile(plansRootPath: string): Promise<BoardConfigFile> {
  let raw: string;
  try {
    raw = await folderFs().readFile(path.join(plansRootPath, BOARD_CONFIG_FILENAME));
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
  const workflow = readWorkflow(record.workflow);
  if (workflow) config.workflow = workflow;
  return config;
}

/**
 * A workflow is only accepted when it is well-formed *and* valid — a folder
 * that ships a broken workflow falls back to the default rather than rendering
 * a board nothing can land on.
 */
function readWorkflow(value: unknown): ProjectWorkflowStage[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const stages: ProjectWorkflowStage[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const stage = entry as Record<string, unknown>;
    const name = readString(stage.name);
    if (!name) return undefined;
    const category = stage.category;
    stages.push({
      id: readString(stage.id) ?? `stage-${index + 1}`,
      name,
      ...(category === 'todo' || category === 'indeterminate' || category === 'done'
        ? { category }
        : {})
    });
  }
  const normalized = normalizeWorkflowStages(stages);
  return validateWorkflowStages(normalized) ? undefined : normalized;
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
  if (config.workflow && config.workflow.length > 0) {
    body.workflow = normalizeWorkflowStages(config.workflow);
  }
  await folderFs().writeFile(
    path.join(plansRootPath, BOARD_CONFIG_FILENAME),
    `${JSON.stringify(body, null, 2)}\n`
  );
}
