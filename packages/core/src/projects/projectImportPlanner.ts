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

export interface ProjectImportRow {
  repositoryName: string;
  repositoryRootPath: string;
  /** Stored (forward-slash) plans root path used as the board location. */
  plansFolderPath: string;
  projectKey: string;
  projectName: string;
  name: string;
  alreadyAdded: boolean;
}

export interface PlanProjectImportsInput {
  repositories: DiscoveredRepository[];
  planRoots: DiscoveredPlanRoot[];
  /** Plans folders already imported as projects. */
  existingPaths?: string[];
  /** Project keys already in use. */
  existingKeys?: string[];
}

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
  return name.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Imported Project';
}

export function suggestedProjectKey(folderPath: string): string {
  const compact = suggestedProjectName(folderPath).replace(/[^A-Za-z0-9]+/g, '');
  return /^[A-Za-z]/.test(compact) ? compact.slice(0, 15).toUpperCase() : 'PLANS';
}

/**
 * Choose the plans root for a repository, or `undefined` when it has none.
 *
 * Prefers a plans root owned by this repository — nearest enclosing repository
 * wins — so a parent repository never adopts a child's plans folder. The
 * shallowest owned root is used.
 *
 * Returning `undefined` is the point. This used to fall back to a hardcoded
 * `<repository>/docs/plans` guess, and it also discarded a plans root sitting
 * at the repository root whenever that root had no `features/` entries — which
 * is exactly what a plans folder tracking only bugs/tasks looks like. Between
 * them, a repository whose plans lived anywhere but `docs/plans` got a project
 * pointed at a guessed path: if that path happened to exist, the board was
 * created and silently showed nothing. A repository with no discoverable plans
 * is now simply not offered for import.
 */
function resolvePlansPathForRepository(
  repository: DiscoveredRepository,
  repositories: DiscoveredRepository[],
  planRoots: DiscoveredPlanRoot[]
): string | undefined {
  const repositoryPath = path.resolve(repository.rootPath);

  const ownedPlanRoots = planRoots
    .filter(planRoot => {
      const planPath = path.resolve(planRoot.plansPath);
      const owner = repositories
        .filter(candidate => isSameOrInside(candidate.rootPath, planPath))
        .sort((left, right) => right.rootPath.length - left.rootPath.length)[0];
      return owner ? path.resolve(owner.rootPath) === repositoryPath : false;
    })
    .sort((left, right) => left.plansPath.length - right.plansPath.length);

  return ownedPlanRoots[0]?.plansPath;
}

/**
 * Build the editable rows shown in the import table.
 *
 * Guarantees:
 *  - One row per discovered repository that actually has a plans root, plus a
 *    row per bare plans root when no repositories were found at all.
 *  - A repository with no discoverable plans is skipped, never guessed at.
 *  - Rows already imported are flagged so they are never created twice.
 *  - Generated project keys are unique and never collide with existing keys.
 */
export function planProjectImports(input: PlanProjectImportsInput): ProjectImportRow[] {
  const existingPaths = normalizePathSet(input.existingPaths);
  const usedKeys = normalizeKeySet(input.existingKeys);

  const pairs = input.repositories.length > 0
    ? input.repositories
      .map(repository => ({
        repositoryRootPath: repository.rootPath,
        plansPath: resolvePlansPathForRepository(repository, input.repositories, input.planRoots)
      }))
      .filter((pair): pair is { repositoryRootPath: string; plansPath: string } =>
        pair.plansPath !== undefined)
    : input.planRoots.map(planRoot => ({
      repositoryRootPath: planRoot.plansPath,
      plansPath: planRoot.plansPath
    }));

  return pairs.map(pair => {
    const repositoryRootPath = toStoredFolderPath(pair.repositoryRootPath);
    const plansFolderPath = toStoredFolderPath(pair.plansPath);
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
      plansFolderPath,
      projectKey,
      projectName: displayName,
      name: displayName,
      alreadyAdded: existingPaths.has(plansFolderPath.toLowerCase())
    };
  });
}

/** Validate edited rows before any filesystem or board changes occur. */
export function validateProjectImports(
  rows: readonly ProjectImportRow[],
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
