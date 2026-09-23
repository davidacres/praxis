import { type AddonManifest, isAddonKind } from './catalogTypes';
import { isValidVersion } from './semver';

/**
 * Validates the `praxis` block from an add-on package's `package.json`.
 *
 * `errors` are blocking — an entry with any is dropped from the catalogue and
 * cannot be installed. `warnings` are cosmetic gaps worth surfacing but not
 * worth hiding the add-on over. Mirrors the shape of `validateAgentManifest`.
 */

export interface AddonManifestValidation {
  manifest?: AddonManifest;
  errors: string[];
  warnings: string[];
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateAddonManifest(value: unknown): AddonManifestValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isRecord(value)) {
    return { errors: ['The `praxis` manifest is missing or is not an object.'], warnings };
  }

  if (value.schemaVersion !== 1) {
    errors.push('`schemaVersion` must be 1.');
  }

  if (!isAddonKind(value.kind)) {
    errors.push('`kind` must be one of theme, surface-pack, agent, skill, workflow-template.');
  }

  const id = value.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    errors.push('`id` must be lower-kebab-case, start with a letter or digit, and be ≤ 64 characters.');
  }

  const name = value.name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    errors.push('`name` is required.');
  } else if (name.length > 80) {
    errors.push('`name` must be ≤ 80 characters.');
  }

  for (const field of ['summary', 'author', 'homepage'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') {
      errors.push(`\`${field}\` must be a string when present.`);
    }
  }

  if (value.homepage !== undefined && typeof value.homepage === 'string') {
    if (!/^https:\/\//i.test(value.homepage)) {
      errors.push('`homepage` must be an https URL.');
    }
  }

  for (const field of ['contentVersion', 'minAppVersion'] as const) {
    const raw = value[field];
    if (raw !== undefined) {
      if (typeof raw !== 'string' || !isValidVersion(raw)) {
        errors.push(`\`${field}\` must be a semver string (MAJOR.MINOR.PATCH) when present.`);
      }
    }
  }

  let display: AddonManifest['display'];
  if (value.display !== undefined) {
    if (!isRecord(value.display)) {
      errors.push('`display` must be an object when present.');
    } else {
      const rawPreview = value.display.preview;
      const preview: Record<string, string> = {};
      if (rawPreview !== undefined) {
        if (!isRecord(rawPreview)) {
          errors.push('`display.preview` must be a map of colour tokens.');
        } else {
          for (const [key, entry] of Object.entries(rawPreview)) {
            if (typeof entry === 'string') preview[key] = entry;
          }
        }
      }
      const mode =
        value.display.mode === 'light' || value.display.mode === 'dark'
          ? value.display.mode
          : undefined;
      if (value.display.mode !== undefined && mode === undefined) {
        errors.push('`display.mode` must be "light" or "dark".');
      }
      const runtime = value.display.runtime;
      if (runtime !== undefined && (typeof runtime !== 'string' || runtime.trim().length === 0 || runtime.length > 40)) {
        errors.push('`display.runtime` must be a short name (≤ 40 characters) when present.');
      }
      display = {
        ...(Object.keys(preview).length > 0 ? { preview } : {}),
        ...(mode ? { mode } : {}),
        ...(typeof runtime === 'string' && runtime.trim() ? { runtime: runtime.trim() } : {})
      };
      if (Object.keys(display).length === 0) display = undefined;
    }
  }

  if (value.replaces !== undefined) {
    if (typeof value.replaces !== 'string' || !ID_RE.test(value.replaces)) {
      errors.push('`replaces` must be the id of a built-in agent.');
    } else if (value.kind !== 'agent') {
      errors.push('Only an agent add-on can replace a built-in agent.');
    } else if (value.replaces === id) {
      errors.push('`replaces` names another agent; give the add-on its own `id`.');
    }
  }

  if (value.summary === undefined) {
    warnings.push('No `summary` — the catalogue row will have no description.');
  }
  if (value.author === undefined) {
    warnings.push('No `author`.');
  }

  if (errors.length > 0) {
    return { errors, warnings };
  }

  const manifest: AddonManifest = {
    schemaVersion: 1,
    kind: value.kind as AddonManifest['kind'],
    id: id as string,
    name: (name as string).trim(),
    summary: value.summary as string | undefined,
    contentVersion: value.contentVersion as string | undefined,
    minAppVersion: value.minAppVersion as string | undefined,
    author: value.author as string | undefined,
    homepage: value.homepage as string | undefined,
    ...(typeof value.replaces === 'string' ? { replaces: value.replaces } : {}),
    display
  };
  return { manifest, errors, warnings };
}
