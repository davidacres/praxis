import * as path from 'node:path';
import { toStoredFolderPath } from '../folder/pathUtils';

/** A Git repository root discovered under the selected parent folder. */
export interface DiscoveredRepository {
  /** Absolute path of the repository root (contains `.git`). */
  rootPath: string;
}

/** A plans root discovered by the markdown plan parser. */
export interface DiscoveredPlanRoot {
  /** Absolute path of the plans root. */
  plansPath: string;
  /** Number of entries in the plans root's `features/` directory. */
  featureEntryCount: number;
}

export interface BoardDraftRow {
  repositoryName: string;
  repositoryRootPath: string;
  /** Stored (forward-slash) plans root path used as the board location. */
  liveFolderPath: string;
  projectKey: string;
  projectName: string;
  name: string;
  alreadyAdded: boolean;
}

export interface PlanBoardDraftsInput {
  repositories: DiscoveredRepository[];
  planRoots: DiscoveredPlanRoot[];
  /** Plans paths already registered as User Workspace boards. */
  existingPaths?: string[];
  /** Project keys already used by User Workspace boards. */
  existingKeys?: string[];
}

const CANONICAL_PLANS_SEGMENTS = ['docs', 'plans'];

function normalizeKeySet(values: readonly string[] | undefined): Set<string> {
  return new Set((values ?? []).map(value => value.trim().toUpperCase()).filter(Boolean));
}

function normalizePathSet(values: readonly string[] | undefined): Set<string> {
  return new Set(
    (values ?? [])
      .filter(Boolean)
      .map(value => toStoredFolderPath(value).toLowerCase())
  );
}

function isSameOrInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function suggestedProjectName(folderPath: string): string {
  const name = folderPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.trim() ?? '';
  return name.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'User Workspace Project';
}

export function suggestedProjectKey(folderPath: string): string {
  const compact = suggestedProjectName(folderPath).replace(/[^A-Za-z0-9]+/g, '');
  return /^[A-Za-z]/.test(compact) ? compact.slice(0, 15).toUpperCase() : 'PLANS';
}

/**
 * Choose the plans root for a repository.
 *
 * Rules:
 *  - Prefer a plans root owned by this repository (nearest enclosing repository wins),
 *    so a parent repository never adopts a child repository's plans folder.
 *  - Ignore an "empty marker" plans root that is the repository root itself and is not
 *    already registered. These are leftovers from interrupted runs and must not become
 *    the board location instead of the canonical `docs/plans`.
 *  - Otherwise fall back to the canonical `<repository>/docs/plans`.
 */
function resolvePlansPathForRepository(
  repository: DiscoveredRepository,
  repositories: DiscoveredRepository[],
  planRoots: DiscoveredPlanRoot[],
  existingPaths: Set<string>
): string {
  const repositoryPath = path.resolve(repository.rootPath);

  const ownedPlanRoots = planRoots
    .filter(planRoot => {
      const planPath = path.resolve(planRoot.plansPath);
      const isOrphanRootMarker =
        planPath === repositoryPath &&
        planRoot.featureEntryCount === 0 &&
        // `existingPaths` is keyed by `toStoredFolderPath(raw)` with no resolve,
        // so test membership the same way — resolving a Windows-style path on a
        // posix host prepends cwd and the lookup would always miss.
        !existingPaths.has(toStoredFolderPath(planRoot.plansPath).toLowerCase());
      return !isOrphanRootMarker;
    })
    .filter(planRoot => {
      const planPath = path.resolve(planRoot.plansPath);
      const owner = repositories
        .filter(candidate => isSameOrInside(candidate.rootPath, planPath))
        .sort((left, right) => right.rootPath.length - left.rootPath.length)[0];
      return owner ? path.resolve(owner.rootPath) === repositoryPath : false;
    })
    .sort((left, right) => left.plansPath.length - right.plansPath.length);

  if (ownedPlanRoots.length > 0) {
    return ownedPlanRoots[0].plansPath;
  }
  return path.join(repository.rootPath, ...CANONICAL_PLANS_SEGMENTS);
}

/**
 * Build the editable board rows shown in the Create Boards table.
 *
 * Guarantees:
 *  - One row per discovered repository (or per plans root when no repositories exist).
 *  - Rows already registered as boards are flagged so they are never created twice.
 *  - Generated project keys are unique and never collide with existing board keys.
 */
export function planBoardDrafts(input: PlanBoardDraftsInput): BoardDraftRow[] {
  const existingPaths = normalizePathSet(input.existingPaths);
  const usedKeys = normalizeKeySet(input.existingKeys);

  const pairs = input.repositories.length > 0
    ? input.repositories.map(repository => ({
      repositoryRootPath: repository.rootPath,
      plansPath: resolvePlansPathForRepository(
        repository,
        input.repositories,
        input.planRoots,
        existingPaths
      )
    }))
    : input.planRoots.map(planRoot => ({
      repositoryRootPath: planRoot.plansPath,
      plansPath: planRoot.plansPath
    }));

  return pairs.map(pair => {
    const repositoryRootPath = toStoredFolderPath(pair.repositoryRootPath);
    const liveFolderPath = toStoredFolderPath(pair.plansPath);
    const displayName = suggestedProjectName(repositoryRootPath);

    const base = suggestedProjectKey(repositoryRootPath);
    let projectKey = base;
    let suffix = 2;
    while (usedKeys.has(projectKey)) {
      const suffixText = String(suffix++);
      projectKey = `${base.slice(0, Math.max(1, 15 - suffixText.length))}${suffixText}`;
    }
    usedKeys.add(projectKey);

    return {
      repositoryName: displayName,
      repositoryRootPath,
      liveFolderPath,
      projectKey,
      projectName: displayName,
      name: displayName,
      alreadyAdded: existingPaths.has(liveFolderPath.toLowerCase())
    };
  });
}

/** Validate edited rows before any filesystem or board changes occur. */
export function validateBoardDrafts(
  rows: readonly BoardDraftRow[],
  existingKeys: readonly string[] = []
): string | undefined {
  const keys = normalizeKeySet(existingKeys);
  for (const row of rows) {
    if (row.alreadyAdded) {
      continue;
    }
    const key = row.projectKey.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{0,14}$/.test(key)) {
      return `Project code "${row.projectKey}" is invalid. Use 1-15 letters, numbers, or underscore, starting with a letter.`;
    }
    if (keys.has(key)) {
      return `Project code "${key}" is used more than once. Give each repository a unique code.`;
    }
    keys.add(key);
    if (!row.projectName.trim() || !row.name.trim()) {
      return 'Every repository needs a project name and board name.';
    }
  }
  return undefined;
}
