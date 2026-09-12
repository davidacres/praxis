import type { CheckFinding } from './workflowTypes';

export interface FindingWaiver {
  fingerprint: string;
  reason: string;
  actor: string;
  createdAt: string;
  expiresAt: string;
  snapshotRef?: string;
}

export interface WaiverRegister {
  waivers: FindingWaiver[];
  maxLifetimeDays?: number;
}

export function validateFindingWaiver(
  waiver: Partial<FindingWaiver>,
  maxLifetimeDays?: number
): void {
  if (!waiver.fingerprint || !waiver.fingerprint.trim()) {
    throw new Error('Waiver fingerprint is required.');
  }
  if (!waiver.reason || !waiver.reason.trim()) {
    throw new Error('Waiver reason is required and cannot be blank.');
  }
  if (!waiver.actor || !waiver.actor.trim()) {
    throw new Error('Waiver actor is required and cannot be blank.');
  }
  if (!waiver.createdAt || isNaN(Date.parse(waiver.createdAt))) {
    throw new Error('Waiver createdAt must be a valid ISO date.');
  }
  if (!waiver.expiresAt || isNaN(Date.parse(waiver.expiresAt))) {
    throw new Error('Waiver expiresAt must be a valid ISO date.');
  }

  const createdTime = new Date(waiver.createdAt).getTime();
  const expiresTime = new Date(waiver.expiresAt).getTime();
  if (expiresTime <= createdTime) {
    throw new Error('Waiver expiresAt must be in the future relative to createdAt.');
  }

  if (maxLifetimeDays !== undefined) {
    const lifetimeDays = (expiresTime - createdTime) / (1000 * 60 * 60 * 24);
    if (lifetimeDays > maxLifetimeDays) {
      throw new Error(
        `Waiver lifetime (${lifetimeDays.toFixed(1)} days) exceeds maximum allowed lifetime of ${maxLifetimeDays} days.`
      );
    }
  }
}

/**
 * Checks if a waiver is currently active.
 * A waiver is inactive if expired relative to `now`, or if it is bound to a specific
 * snapshotRef that does not match the `currentSnapshotRef`.
 */
export function isWaiverActive(
  waiver: FindingWaiver,
  now?: Date | string,
  currentSnapshotRef?: string
): boolean {
  const nowDate = now ? new Date(now) : new Date();
  const expiresDate = new Date(waiver.expiresAt);
  if (nowDate >= expiresDate) {
    return false;
  }

  if (waiver.snapshotRef !== undefined) {
    if (!currentSnapshotRef || waiver.snapshotRef !== currentSnapshotRef) {
      return false;
    }
  }

  return true;
}

export function filterUnwaivedFindings(
  findings: CheckFinding[],
  waivers: FindingWaiver[],
  now?: Date | string,
  currentSnapshotRef?: string
): { activeFindings: CheckFinding[]; waivedFindings: CheckFinding[] } {
  const activeWaiversByFingerprint = new Set<string>();

  for (const waiver of waivers) {
    if (isWaiverActive(waiver, now, currentSnapshotRef)) {
      activeWaiversByFingerprint.add(waiver.fingerprint);
    }
  }

  const activeFindings: CheckFinding[] = [];
  const waivedFindings: CheckFinding[] = [];

  for (const finding of findings) {
    if (activeWaiversByFingerprint.has(finding.fingerprint)) {
      waivedFindings.push(finding);
    } else {
      activeFindings.push(finding);
    }
  }

  return { activeFindings, waivedFindings };
}

/**
 * Composes organization and project waiver registers with strictest-wins semantics.
 * A project may tighten (reduce) maxLifetimeDays, but cannot loosen (increase) past the org ceiling.
 */
export function composeWaiverRegisters(
  org?: WaiverRegister,
  project?: WaiverRegister
): WaiverRegister {
  if (!org) {
    return project ? { ...project, waivers: [...project.waivers] } : { waivers: [] };
  }
  if (!project) {
    return { ...org, waivers: [...org.waivers] };
  }

  let effectiveMaxLifetimeDays = org.maxLifetimeDays;
  if (project.maxLifetimeDays !== undefined) {
    if (org.maxLifetimeDays !== undefined && project.maxLifetimeDays > org.maxLifetimeDays) {
      throw new Error(
        `Project waiver maxLifetimeDays (${project.maxLifetimeDays}) exceeds organization ceiling (${org.maxLifetimeDays}).`
      );
    }
    effectiveMaxLifetimeDays =
      org.maxLifetimeDays !== undefined
        ? Math.min(org.maxLifetimeDays, project.maxLifetimeDays)
        : project.maxLifetimeDays;
  }

  // Validate that all project waivers obey the effective max lifetime
  for (const waiver of project.waivers) {
    validateFindingWaiver(waiver, effectiveMaxLifetimeDays);
  }

  // Deduplicate by fingerprint + snapshotRef + actor
  const waiverMap = new Map<string, FindingWaiver>();
  for (const w of org.waivers) {
    waiverMap.set(`${w.fingerprint}:${w.snapshotRef ?? ''}`, w);
  }
  for (const w of project.waivers) {
    waiverMap.set(`${w.fingerprint}:${w.snapshotRef ?? ''}`, w);
  }

  return {
    waivers: Array.from(waiverMap.values()),
    maxLifetimeDays: effectiveMaxLifetimeDays
  };
}
