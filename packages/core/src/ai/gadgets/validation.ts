/**
 * Deterministic validation for gadget envelopes and action values (TASK-278).
 *
 * A gadget request is untrusted input — it may come from a model, a workflow
 * template a user wrote, or an older client. Validation runs host-side, before
 * anything is persisted or sent to a renderer, and it *normalises* as well as
 * checks: oversized collections are trimmed and marked `truncated`, secrets are
 * masked. What reaches a renderer is always in-bounds, so no renderer needs a
 * defensive branch for a 40 000-row table.
 */
import {
  GADGET_CONTRACT_VERSION,
  GADGET_KINDS,
  type AnyGadgetEnvelope,
  type ChatBlock,
  type GadgetAction,
  type GadgetActionDescriptor,
  type GadgetActionValue,
  type GadgetCapability,
  type GadgetError,
  type GadgetErrorCode,
  type GadgetKind,
  type GadgetScope
} from './contracts';
import { GADGET_LIMITS } from './limits';
import { redactDeep } from './redaction';
import { gadgetFallbackText } from './fallback';

class SchemaFailure extends Error {
  public constructor(public readonly error: GadgetError) {
    super(error.message);
  }
}

function fail(code: GadgetErrorCode, message: string, path?: string): never {
  throw new SchemaFailure({ code, message, path, retryable: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(
  source: Record<string, unknown>,
  key: string,
  path: string,
  options: { required?: boolean; max?: number; allowEmpty?: boolean } = {}
): string | undefined {
  const value = source[key];
  const full = `${path}.${key}`;
  if (value === undefined || value === null) {
    if (options.required) fail('schema-invalid', `"${full}" is required.`, full);
    return undefined;
  }
  if (typeof value !== 'string') fail('schema-invalid', `"${full}" must be a string.`, full);
  if (!options.allowEmpty && options.required && value.trim() === '') {
    fail('schema-invalid', `"${full}" must not be empty.`, full);
  }
  const max = options.max ?? GADGET_LIMITS.stringLength;
  if (value.length > max) {
    fail('payload-too-large', `"${full}" exceeds ${max} characters.`, full);
  }
  return value;
}

function readNumber(
  source: Record<string, unknown>,
  key: string,
  path: string,
  options: { required?: boolean; min?: number; max?: number } = {}
): number | undefined {
  const value = source[key];
  const full = `${path}.${key}`;
  if (value === undefined || value === null) {
    if (options.required) fail('schema-invalid', `"${full}" is required.`, full);
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('schema-invalid', `"${full}" must be a finite number.`, full);
  }
  if (options.min !== undefined && value < options.min) fail('schema-invalid', `"${full}" must be at least ${options.min}.`, full);
  if (options.max !== undefined && value > options.max) fail('schema-invalid', `"${full}" must be at most ${options.max}.`, full);
  return value;
}

function readBoolean(source: Record<string, unknown>, key: string, path: string): boolean | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') fail('schema-invalid', `"${path}.${key}" must be a boolean.`, `${path}.${key}`);
  return value;
}

/**
 * Read an array, trimming to `max` rather than rejecting.
 *
 * Trimming is the right call for *data* collections (rows, points, files): the
 * user still gets a usable surface and the `truncated` flag tells them it is
 * partial. It is the wrong call for *controls* — see `readBoundedArray`.
 */
function readTrimmedArray(
  source: Record<string, unknown>,
  key: string,
  path: string,
  max: number,
  options: { required?: boolean } = {}
): { items: unknown[]; truncated: boolean } {
  const value = source[key];
  const full = `${path}.${key}`;
  if (value === undefined || value === null) {
    if (options.required) fail('schema-invalid', `"${full}" is required.`, full);
    return { items: [], truncated: false };
  }
  if (!Array.isArray(value)) fail('schema-invalid', `"${full}" must be an array.`, full);
  return { items: value.slice(0, max), truncated: value.length > max };
}

/**
 * Read an array that must fit, refusing when it does not.
 *
 * Silently dropping the 25th choice option or the 9th action would hide a
 * decision the user was meant to be offered — a quietly wrong gadget is worse
 * than a visible rejection with a fallback.
 */
function readBoundedArray(
  source: Record<string, unknown>,
  key: string,
  path: string,
  max: number,
  options: { required?: boolean; minLength?: number } = {}
): unknown[] {
  const value = source[key];
  const full = `${path}.${key}`;
  if (value === undefined || value === null) {
    if (options.required) fail('schema-invalid', `"${full}" is required.`, full);
    return [];
  }
  if (!Array.isArray(value)) fail('schema-invalid', `"${full}" must be an array.`, full);
  if (value.length > max) fail('payload-too-large', `"${full}" has ${value.length} entries; the limit is ${max}.`, full);
  if (options.minLength !== undefined && value.length < options.minLength) {
    fail('schema-invalid', `"${full}" needs at least ${options.minLength} entr${options.minLength === 1 ? 'y' : 'ies'}.`, full);
  }
  return value;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail('schema-invalid', `"${path}" must be an object.`, path);
  return value;
}

function readIsoTimestamp(source: Record<string, unknown>, key: string, path: string, required = false): string | undefined {
  const raw = readString(source, key, path, { required });
  if (raw === undefined) return undefined;
  if (Number.isNaN(Date.parse(raw))) fail('schema-invalid', `"${path}.${key}" must be an ISO timestamp.`, `${path}.${key}`);
  return raw;
}

// ── Per-kind payload validation ──────────────────────────────────────────

function validateChoiceOption(raw: unknown, path: string) {
  const option = requireRecord(raw, path);
  return {
    value: readString(option, 'value', path, { required: true, max: 200 })!,
    label: readString(option, 'label', path, { required: true, max: 400 })!,
    description: readString(option, 'description', path, { max: 2_000 }),
    disabledReason: readString(option, 'disabledReason', path, { max: 400 })
  };
}

const PAYLOAD_VALIDATORS: { [K in GadgetKind]: (payload: Record<string, unknown>) => Record<string, unknown> } = {
  choice(payload) {
    const options = readBoundedArray(payload, 'options', 'payload', GADGET_LIMITS.choiceOptions, {
      required: true,
      minLength: 1
    }).map((option, index) => validateChoiceOption(option, `payload.options[${index}]`));
    const defaultValue = readString(payload, 'defaultValue', 'payload', { max: 200 });
    if (defaultValue !== undefined && !options.some(option => option.value === defaultValue)) {
      fail('schema-invalid', '"payload.defaultValue" must name one of the options.', 'payload.defaultValue');
    }
    const seen = new Set<string>();
    for (const option of options) {
      if (seen.has(option.value)) fail('schema-invalid', `Duplicate option value "${option.value}".`, 'payload.options');
      seen.add(option.value);
    }
    return {
      question: readString(payload, 'question', 'payload', { required: true, max: 2_000 }),
      detail: readString(payload, 'detail', 'payload'),
      multiple: readBoolean(payload, 'multiple', 'payload'),
      defaultValue,
      options
    };
  },

  confirmation(payload) {
    const consequences = readBoundedArray(payload, 'consequences', 'payload', 20).map((entry, index) => {
      if (typeof entry !== 'string') fail('schema-invalid', `"payload.consequences[${index}]" must be a string.`, `payload.consequences[${index}]`);
      return entry;
    });
    return {
      question: readString(payload, 'question', 'payload', { required: true, max: 2_000 }),
      detail: readString(payload, 'detail', 'payload'),
      confirmLabel: readString(payload, 'confirmLabel', 'payload', { max: 80 }),
      cancelLabel: readString(payload, 'cancelLabel', 'payload', { max: 80 }),
      ...(consequences.length ? { consequences } : {})
    };
  },

  form(payload) {
    const fields = readBoundedArray(payload, 'fields', 'payload', GADGET_LIMITS.formFields, {
      required: true,
      minLength: 1
    }).map((raw, index) => {
      const path = `payload.fields[${index}]`;
      const field = requireRecord(raw, path);
      const type = readString(field, 'type', path, { required: true, max: 20 })!;
      if (!['text', 'textarea', 'number', 'boolean', 'select'].includes(type)) {
        fail('schema-invalid', `"${path}.type" is not a supported field type.`, `${path}.type`);
      }
      const options = readBoundedArray(field, 'options', path, GADGET_LIMITS.choiceOptions).map((option, optionIndex) =>
        validateChoiceOption(option, `${path}.options[${optionIndex}]`)
      );
      if (type === 'select' && options.length === 0) {
        fail('schema-invalid', `"${path}.options" is required for a select field.`, `${path}.options`);
      }
      const defaultValue = field.defaultValue;
      if (defaultValue !== undefined && !['string', 'number', 'boolean'].includes(typeof defaultValue)) {
        fail('schema-invalid', `"${path}.defaultValue" must be a string, number or boolean.`, `${path}.defaultValue`);
      }
      return {
        name: readString(field, 'name', path, { required: true, max: 120 })!,
        label: readString(field, 'label', path, { required: true, max: 400 })!,
        type,
        required: readBoolean(field, 'required', path),
        placeholder: readString(field, 'placeholder', path, { max: 200 }),
        help: readString(field, 'help', path, { max: 2_000 }),
        defaultValue,
        min: readNumber(field, 'min', path),
        max: readNumber(field, 'max', path),
        maxLength: readNumber(field, 'maxLength', path, { min: 1, max: GADGET_LIMITS.stringLength }),
        ...(options.length ? { options } : {})
      };
    });
    const names = new Set<string>();
    for (const field of fields) {
      if (names.has(field.name)) fail('schema-invalid', `Duplicate field name "${field.name}".`, 'payload.fields');
      names.add(field.name);
    }
    return {
      title: readString(payload, 'title', 'payload', { required: true, max: 400 }),
      description: readString(payload, 'description', 'payload'),
      fields
    };
  },

  table(payload) {
    const columns = readBoundedArray(payload, 'columns', 'payload', GADGET_LIMITS.tableColumns, {
      required: true,
      minLength: 1
    }).map((raw, index) => {
      const path = `payload.columns[${index}]`;
      const column = requireRecord(raw, path);
      const align = readString(column, 'align', path, { max: 10 });
      if (align !== undefined && align !== 'start' && align !== 'end') {
        fail('schema-invalid', `"${path}.align" must be "start" or "end".`, `${path}.align`);
      }
      return {
        key: readString(column, 'key', path, { required: true, max: 120 })!,
        label: readString(column, 'label', path, { required: true, max: 200 })!,
        align,
        mono: readBoolean(column, 'mono', path)
      };
    });
    const { items, truncated } = readTrimmedArray(payload, 'rows', 'payload', GADGET_LIMITS.tableRows, { required: true });
    const rows = items.map((raw, index) => {
      const path = `payload.rows[${index}]`;
      const row = requireRecord(raw, path);
      const out: Record<string, string | number | boolean | null> = {};
      for (const column of columns) {
        const cell = row[column.key];
        if (cell === undefined || cell === null) {
          out[column.key] = null;
        } else if (typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') {
          out[column.key] = typeof cell === 'string' && cell.length > 1_000 ? `${cell.slice(0, 1_000)}…` : cell;
        } else {
          fail('schema-invalid', `"${path}.${column.key}" must be a string, number, boolean or null.`, `${path}.${column.key}`);
        }
      }
      return out;
    });
    return {
      title: readString(payload, 'title', 'payload', { max: 400 }),
      caption: readString(payload, 'caption', 'payload'),
      emptyText: readString(payload, 'emptyText', 'payload', { max: 400 }),
      columns,
      rows,
      // A producer may also declare truncation itself, when it trimmed upstream.
      truncated: truncated || readBoolean(payload, 'truncated', 'payload') === true
    };
  },

  chart(payload) {
    const chartKind = readString(payload, 'chartKind', 'payload', { required: true, max: 20 })!;
    if (chartKind !== 'bar' && chartKind !== 'line') {
      fail('schema-invalid', '"payload.chartKind" must be "bar" or "line".', 'payload.chartKind');
    }
    const series = readBoundedArray(payload, 'series', 'payload', GADGET_LIMITS.chartSeries, {
      required: true,
      minLength: 1
    }).map((raw, index) => {
      const path = `payload.series[${index}]`;
      const entry = requireRecord(raw, path);
      const { items } = readTrimmedArray(entry, 'points', path, GADGET_LIMITS.chartPoints, { required: true });
      return {
        label: readString(entry, 'label', path, { required: true, max: 200 })!,
        points: items.map((rawPoint, pointIndex) => {
          const pointPath = `${path}.points[${pointIndex}]`;
          const point = requireRecord(rawPoint, pointPath);
          const x = point.x;
          if (typeof x !== 'string' && typeof x !== 'number') {
            fail('schema-invalid', `"${pointPath}.x" must be a string or number.`, `${pointPath}.x`);
          }
          return { x, y: readNumber(point, 'y', pointPath, { required: true })! };
        })
      };
    });
    return {
      title: readString(payload, 'title', 'payload', { max: 400 }),
      xLabel: readString(payload, 'xLabel', 'payload', { max: 200 }),
      yLabel: readString(payload, 'yLabel', 'payload', { max: 200 }),
      summary: readString(payload, 'summary', 'payload'),
      chartKind,
      series
    };
  },

  progress(payload) {
    const status = readString(payload, 'status', 'payload', { required: true, max: 20 })!;
    if (!['running', 'blocked', 'succeeded', 'failed', 'cancelled'].includes(status)) {
      fail('schema-invalid', `"payload.status" is not a supported progress status.`, 'payload.status');
    }
    const steps = readBoundedArray(payload, 'steps', 'payload', GADGET_LIMITS.progressSteps).map((raw, index) => {
      const path = `payload.steps[${index}]`;
      const step = requireRecord(raw, path);
      const state = readString(step, 'state', path, { required: true, max: 20 })!;
      if (!['pending', 'running', 'done', 'failed'].includes(state)) {
        fail('schema-invalid', `"${path}.state" is not a supported step state.`, `${path}.state`);
      }
      return { label: readString(step, 'label', path, { required: true, max: 400 })!, state };
    });
    return {
      title: readString(payload, 'title', 'payload', { required: true, max: 400 }),
      detail: readString(payload, 'detail', 'payload'),
      percent: readNumber(payload, 'percent', 'payload', { min: 0, max: 100 }),
      status,
      ...(steps.length ? { steps } : {})
    };
  },

  diff(payload) {
    const { items, truncated } = readTrimmedArray(payload, 'files', 'payload', GADGET_LIMITS.diffFiles, { required: true });
    const files = items.map((raw, index) => {
      const path = `payload.files[${index}]`;
      const file = requireRecord(raw, path);
      const status = readString(file, 'status', path, { required: true, max: 20 })!;
      if (!['added', 'modified', 'deleted', 'renamed'].includes(status)) {
        fail('schema-invalid', `"${path}.status" is not a supported file status.`, `${path}.status`);
      }
      return {
        path: readString(file, 'path', path, { required: true, max: 1_000 })!,
        previousPath: readString(file, 'previousPath', path, { max: 1_000 }),
        additions: readNumber(file, 'additions', path, { required: true, min: 0 })!,
        deletions: readNumber(file, 'deletions', path, { required: true, min: 0 })!,
        preview: readString(file, 'preview', path, { max: GADGET_LIMITS.diffPreviewLength }),
        status
      };
    });
    return {
      title: readString(payload, 'title', 'payload', { max: 400 }),
      summary: readString(payload, 'summary', 'payload'),
      openInChangesRef: readString(payload, 'openInChangesRef', 'payload', { max: 400 }),
      files,
      truncated: truncated || readBoolean(payload, 'truncated', 'payload') === true
    };
  },

  artifact(payload) {
    const artifacts = readBoundedArray(payload, 'artifacts', 'payload', GADGET_LIMITS.artifacts, {
      required: true,
      minLength: 1
    }).map((raw, index) => {
      const path = `payload.artifacts[${index}]`;
      const artifact = requireRecord(raw, path);
      const filePath = readString(artifact, 'path', path, { required: true, max: 1_000 })!;
      // An artifact link is resolved against the session's folder by the host.
      // Refusing traversal here keeps that resolution from ever seeing `..`.
      if (filePath.includes('..')) {
        fail('schema-invalid', `"${path}.path" must not traverse outside the workspace.`, `${path}.path`);
      }
      const category = readString(artifact, 'category', path, { max: 50 });
      if (category !== undefined && !['deliverable', 'evidence', 'report', 'diff', 'log'].includes(category)) {
        fail('schema-invalid', `"${path}.category" must be one of: deliverable, evidence, report, diff, log.`, `${path}.category`);
      }
      const verdict = readString(artifact, 'verdict', path, { max: 50 });
      if (verdict !== undefined && !['passed', 'failed', 'needs-review'].includes(verdict)) {
        fail('schema-invalid', `"${path}.verdict" must be one of: passed, failed, needs-review.`, `${path}.verdict`);
      }
      return {
        name: readString(artifact, 'name', path, { required: true, max: 400 })!,
        path: filePath,
        mediaType: readString(artifact, 'mediaType', path, { max: 200 }),
        description: readString(artifact, 'description', path),
        sizeBytes: readNumber(artifact, 'sizeBytes', path, { min: 0 }),
        ...(category ? { category } : {}),
        ...(verdict ? { verdict } : {})
      };
    });

    let handover: Record<string, unknown> | undefined;
    if (payload.handover !== undefined && payload.handover !== null) {
      const rawHandover = requireRecord(payload.handover, 'payload.handover');
      const hoVerdict = readString(rawHandover, 'verdict', 'payload.handover', { max: 50 });
      if (hoVerdict !== undefined && !['passed', 'failed', 'needs-review'].includes(hoVerdict)) {
        fail('schema-invalid', '"payload.handover.verdict" must be one of: passed, failed, needs-review.', 'payload.handover.verdict');
      }

      let testSummary: Record<string, unknown> | undefined;
      if (rawHandover.testSummary !== undefined && rawHandover.testSummary !== null) {
        const rawTs = requireRecord(rawHandover.testSummary, 'payload.handover.testSummary');
        const total = readNumber(rawTs, 'total', 'payload.handover.testSummary', { required: true, min: 0 })!;
        const passed = readNumber(rawTs, 'passed', 'payload.handover.testSummary', { required: true, min: 0 })!;
        const failed = readNumber(rawTs, 'failed', 'payload.handover.testSummary', { required: true, min: 0 })!;
        const skipped = readNumber(rawTs, 'skipped', 'payload.handover.testSummary', { min: 0 });
        testSummary = {
          total,
          passed,
          failed,
          ...(skipped !== undefined ? { skipped } : {})
        };
      }

      const gitRef = readString(rawHandover, 'gitRef', 'payload.handover', { max: 120 });
      const nextSteps = readString(rawHandover, 'nextSteps', 'payload.handover', { max: 2_000 });
      const requiresSignoff = readBoolean(rawHandover, 'requiresSignoff', 'payload.handover');

      handover = {
        ...(hoVerdict ? { verdict: hoVerdict } : {}),
        ...(testSummary ? { testSummary } : {}),
        ...(gitRef ? { gitRef } : {}),
        ...(nextSteps ? { nextSteps } : {}),
        ...(requiresSignoff !== undefined ? { requiresSignoff } : {})
      };
    }

    return {
      title: readString(payload, 'title', 'payload', { required: true, max: 400 }),
      artifacts,
      ...(handover && Object.keys(handover).length > 0 ? { handover } : {})
    };
  },

  handoff(payload) {
    const mapItems = (key: 'includedItems' | 'excludedItems') =>
      readBoundedArray(payload, key, 'payload', GADGET_LIMITS.handoffItems).map((raw, index) => {
        const path = `payload.${key}[${index}]`;
        const item = requireRecord(raw, path);
        return {
          label: readString(item, 'label', path, { required: true, max: 400 })!,
          detail: readString(item, 'detail', path),
          reason: readString(item, 'reason', path)
        };
      });
    const includedItems = mapItems('includedItems');
    const excludedItems = mapItems('excludedItems');
    return {
      title: readString(payload, 'title', 'payload', { required: true, max: 400 }),
      fromProvider: readString(payload, 'fromProvider', 'payload', { required: true, max: 120 }),
      toProvider: readString(payload, 'toProvider', 'payload', { required: true, max: 120 }),
      contextSummary: readString(payload, 'contextSummary', 'payload', { required: true }),
      warning: readString(payload, 'warning', 'payload'),
      ...(includedItems.length ? { includedItems } : {}),
      ...(excludedItems.length ? { excludedItems } : {})
    };
  },

  conflict(payload) {
    const conflicts = readBoundedArray(payload, 'conflicts', 'payload', GADGET_LIMITS.conflicts, {
      required: true,
      minLength: 1
    }).map((raw, index) => {
      const path = `payload.conflicts[${index}]`;
      const conflict = requireRecord(raw, path);
      return {
        id: readString(conflict, 'id', path, { required: true, max: 200 })!,
        label: readString(conflict, 'label', path, { required: true, max: 400 })!,
        ours: readString(conflict, 'ours', path, { required: true, allowEmpty: true })!,
        theirs: readString(conflict, 'theirs', path, { required: true, allowEmpty: true })!,
        path: readString(conflict, 'path', path, { max: 1_000 })
      };
    });
    return {
      title: readString(payload, 'title', 'payload', { required: true, max: 400 }),
      description: readString(payload, 'description', 'payload'),
      conflicts
    };
  },

  approval(payload) {
    const evidence = readBoundedArray(payload, 'evidence', 'payload', GADGET_LIMITS.approvalEvidence).map((raw, index) => {
      const path = `payload.evidence[${index}]`;
      const entry = requireRecord(raw, path);
      return {
        label: readString(entry, 'label', path, { required: true, max: 200 })!,
        value: readString(entry, 'value', path, { required: true, allowEmpty: true, max: 2_000 })!
      };
    });
    return {
      title: readString(payload, 'title', 'payload', { required: true, max: 400 }),
      summary: readString(payload, 'summary', 'payload', { required: true }),
      gate: readString(payload, 'gate', 'payload', { required: true, max: 200 }),
      requestedBy: readString(payload, 'requestedBy', 'payload', { max: 200 }),
      effect: readString(payload, 'effect', 'payload'),
      nodeId: readString(payload, 'nodeId', 'payload', { max: 200 }),
      ...(evidence.length ? { evidence } : {})
    };
  }
};

// ── Envelope validation ──────────────────────────────────────────────────

function validateScope(raw: unknown): GadgetScope {
  const scope = requireRecord(raw, 'scope');
  return {
    hostId: readString(scope, 'hostId', 'scope', { required: true, max: 200 })!,
    projectId: readString(scope, 'projectId', 'scope', { max: 200 }),
    sessionId: readString(scope, 'sessionId', 'scope', { required: true, max: 200 })!,
    workId: readString(scope, 'workId', 'scope', { max: 200 }),
    revision: readNumber(scope, 'revision', 'scope', { min: 0 })
  };
}

function validateActions(raw: unknown, kind: GadgetKind): GadgetActionDescriptor[] {
  if (raw === undefined || raw === null) return [];
  const actions = readBoundedArray({ actions: raw }, 'actions', '', GADGET_LIMITS.actions);
  const seen = new Set<string>();
  const descriptors = actions.map((entry, index) => {
    const path = `actions[${index}]`;
    const action = requireRecord(entry, path);
    const effect = readString(action, 'effect', path, { required: true, max: 20 })!;
    if (!['informational', 'mutating', 'approval'].includes(effect)) {
      fail('schema-invalid', `"${path}.effect" is not a supported effect.`, `${path}.effect`);
    }
    const gate = readString(action, 'gate', path, { max: 200 });
    // The central safety rule: anything that changes state or grants approval
    // must name the gate it satisfies, so authorization has something concrete
    // to check. Without this a model could request `effect: "mutating"` with no
    // gate and the host would have nothing to refuse it against.
    if ((effect === 'mutating' || effect === 'approval') && !gate) {
      fail('gate-required', `"${path}" is ${effect} and must declare a workflow gate.`, `${path}.gate`);
    }
    const actionId = readString(action, 'actionId', path, { required: true, max: 200 })!;
    if (seen.has(actionId)) fail('schema-invalid', `Duplicate action ID "${actionId}".`, path);
    seen.add(actionId);
    return {
      actionId,
      label: readString(action, 'label', path, { required: true, max: 200 })!,
      description: readString(action, 'description', path, { max: 2_000 }),
      danger: readBoolean(action, 'danger', path),
      effect: effect as GadgetActionDescriptor['effect'],
      ...(gate ? { gate } : {})
    };
  });

  // An approval gadget exists to open a gate, so it has to offer a way to do
  // that. Declining is a perfectly ordinary `informational` action — an earlier
  // version of this rule banned those outright and made "Reject" unexpressible.
  if (kind === 'approval' && descriptors.length > 0 && !descriptors.some(action => action.effect === 'approval')) {
    fail('schema-invalid', 'An approval gadget must offer at least one approval action.', 'actions');
  }
  return descriptors;
}

export type GadgetValidation =
  | { ok: true; envelope: AnyGadgetEnvelope; redactions: readonly string[] }
  | { ok: false; error: GadgetError };

export interface ValidateGadgetOptions {
  /** What the receiving client can draw. A kind it cannot draw is refused here. */
  capability?: GadgetCapability;
  /** Override for tests. Defaults to `GADGET_LIMITS.envelopeBytes`. */
  maxBytes?: number;
}

/**
 * Validate, bound and redact one gadget envelope.
 *
 * On success the returned envelope is a fresh object — never the input — so a
 * caller cannot retain a reference to the unredacted original by accident.
 */
export function validateGadgetEnvelope(input: unknown, options: ValidateGadgetOptions = {}): GadgetValidation {
  try {
    if (!isRecord(input)) fail('schema-invalid', 'A gadget envelope must be an object.');

    // Size is checked before anything else: parsing a payload we are going to
    // refuse wastes work, and a hostile payload is cheapest to reject early.
    const maxBytes = options.maxBytes ?? GADGET_LIMITS.envelopeBytes;
    let serializedBytes: number;
    try {
      serializedBytes = Buffer.byteLength(JSON.stringify(input) ?? '', 'utf8');
    } catch {
      // A cycle or a BigInt — neither can survive IPC, so refuse rather than
      // let it throw somewhere less recoverable.
      fail('schema-invalid', 'The gadget payload could not be serialized.');
    }
    if (serializedBytes > maxBytes) {
      fail('payload-too-large', `The gadget payload is ${Math.round(serializedBytes / 1024)}KB; the limit is ${Math.round(maxBytes / 1024)}KB.`);
    }

    const version = readNumber(input, 'version', '', { required: true, min: 1 })!;
    if (version > GADGET_CONTRACT_VERSION) {
      fail('unsupported-version', `This gadget needs contract version ${version}; this client supports ${GADGET_CONTRACT_VERSION}.`);
    }

    const kind = readString(input, 'kind', '', { required: true, max: 50 })! as GadgetKind;
    if (!(GADGET_KINDS as readonly string[]).includes(kind)) {
      fail('unsupported-kind', `"${kind}" is not a gadget kind this version knows.`);
    }
    if (options.capability && !options.capability.kinds.includes(kind)) {
      fail('capability-denied', `This client cannot render a "${kind}" gadget.`);
    }

    const payload = PAYLOAD_VALIDATORS[kind](requireRecord(input.payload, 'payload'));

    // A capability may narrow a bound further than the global limit — a phone
    // asks for fewer table rows than a desktop. Trim again, and keep the
    // `truncated` flag honest.
    if (kind === 'table' && options.capability?.maxTableRows !== undefined) {
      const rows = payload.rows as unknown[];
      if (rows.length > options.capability.maxTableRows) {
        payload.rows = rows.slice(0, options.capability.maxTableRows);
        payload.truncated = true;
      }
    }

    const hits = new Set<string>();
    const envelope = {
      version,
      kind,
      gadgetId: readString(input, 'gadgetId', '', { required: true, max: 200 })!,
      scope: validateScope(input.scope),
      issuedAt: readIsoTimestamp(input, 'issuedAt', '', true)!,
      expiresAt: readIsoTimestamp(input, 'expiresAt', ''),
      supersedes: readString(input, 'supersedes', '', { max: 200 }),
      fallbackText: readString(input, 'fallbackText', '', { max: GADGET_LIMITS.stringLength }) ?? '',
      payload: redactDeep(payload, hits),
      actions: validateActions(input.actions, kind),
      state: (readString(input, 'state', '', { max: 30 }) ?? 'active') as AnyGadgetEnvelope['state']
      // The per-kind validators return a structurally-checked record. TypeScript
      // cannot see that `PAYLOAD_VALIDATORS[kind]` produces the payload for that
      // exact `kind`; the correlation is guaranteed by the validator table being
      // keyed by `GadgetKind`, so the assertion is asserted rather than inferred.
    } as unknown as AnyGadgetEnvelope;

    if (envelope.expiresAt && Date.parse(envelope.expiresAt) <= Date.parse(envelope.issuedAt)) {
      fail('schema-invalid', '"expiresAt" must be after "issuedAt".', 'expiresAt');
    }
    if (envelope.supersedes === envelope.gadgetId) {
      fail('schema-invalid', 'A gadget cannot supersede itself.', 'supersedes');
    }
    if (hits.size > 0) envelope.redacted = true;
    // A producer that omitted the fallback still gets one: the contract
    // promises every gadget is representable as text, so we derive it rather
    // than ship an envelope that a text-only client would render as nothing.
    if (!envelope.fallbackText.trim()) envelope.fallbackText = gadgetFallbackText(envelope);

    return { ok: true, envelope, redactions: [...hits] };
  } catch (error) {
    if (error instanceof SchemaFailure) return { ok: false, error: error.error };
    throw error;
  }
}

/**
 * Validate a gadget and always return a renderable block.
 *
 * This is the boundary the chat pipeline uses. A refused gadget becomes a
 * `fallback` block carrying the reason — the user sees *something*, and the
 * reason is inspectable, which is what "no silent failure" means here.
 */
export function coerceGadgetBlock(input: unknown, blockId: string, options: ValidateGadgetOptions = {}): ChatBlock {
  const outcome = validateGadgetEnvelope(input, options);
  if (outcome.ok) return { type: 'gadget', blockId, gadget: outcome.envelope };
  const declaredFallback = isRecord(input) && typeof input.fallbackText === 'string' ? input.fallbackText.trim() : '';
  return {
    type: 'fallback',
    blockId,
    // Prefer the producer's own words when it supplied them; they describe the
    // decision, whereas our error only describes why the surface failed.
    text: declaredFallback || outcome.error.message,
    reason: outcome.error
  };
}

// ── Action value validation ──────────────────────────────────────────────

/**
 * Check a submitted value against the gadget that offered it.
 *
 * Scope, expiry and duplicate handling live in the lifecycle module; this is
 * only "is this a well-formed answer to this question".
 */
export function validateGadgetActionValue(envelope: AnyGadgetEnvelope, action: GadgetAction): GadgetError | undefined {
  const descriptor = envelope.actions.find(candidate => candidate.actionId === action.actionId);
  if (!descriptor) {
    return { code: 'unknown-action', message: `This gadget does not offer an action called "${action.actionId}".`, retryable: false };
  }
  const value = action.value;

  if (envelope.kind === 'choice') {
    const payload = envelope.payload as { options: { value: string; disabledReason?: string }[]; multiple?: boolean };
    const selected = value.kind === 'choice' ? [value.selected] : value.kind === 'selection' ? [...value.selected] : undefined;
    if (!selected) return { code: 'value-invalid', message: 'A choice gadget needs a selected option.', retryable: true };
    if (!payload.multiple && selected.length !== 1) {
      return { code: 'value-invalid', message: 'This choice accepts exactly one option.', retryable: true };
    }
    if (selected.length === 0) return { code: 'value-invalid', message: 'Select at least one option.', retryable: true };
    for (const candidate of selected) {
      const option = payload.options.find(entry => entry.value === candidate);
      if (!option) return { code: 'value-invalid', message: `"${candidate}" is not one of the offered options.`, retryable: true };
      if (option.disabledReason) {
        return { code: 'value-invalid', message: `"${candidate}" is not available: ${option.disabledReason}`, retryable: false };
      }
    }
    return undefined;
  }

  if (envelope.kind === 'confirmation' || envelope.kind === 'approval') {
    if (value.kind !== 'confirmation') {
      return { code: 'value-invalid', message: 'This gadget needs an explicit confirm or decline.', retryable: true };
    }
    return undefined;
  }

  if (envelope.kind === 'form') {
    if (value.kind !== 'form') return { code: 'value-invalid', message: 'This gadget needs form values.', retryable: true };
    const payload = envelope.payload as { fields: { name: string; label: string; type: string; required?: boolean; maxLength?: number; min?: number; max?: number; options?: { value: string }[] }[] };
    const known = new Set(payload.fields.map(field => field.name));
    for (const name of Object.keys(value.fields)) {
      if (!known.has(name)) return { code: 'value-invalid', message: `"${name}" is not a field on this form.`, retryable: false };
    }
    for (const field of payload.fields) {
      const supplied = value.fields[field.name];
      if (supplied === undefined || supplied === '') {
        if (field.required) return { code: 'value-invalid', message: `"${field.label}" is required.`, path: field.name, retryable: true };
        continue;
      }
      if (field.type === 'number') {
        if (typeof supplied !== 'number' || !Number.isFinite(supplied)) {
          return { code: 'value-invalid', message: `"${field.label}" must be a number.`, path: field.name, retryable: true };
        }
        if (field.min !== undefined && supplied < field.min) return { code: 'value-invalid', message: `"${field.label}" must be at least ${field.min}.`, path: field.name, retryable: true };
        if (field.max !== undefined && supplied > field.max) return { code: 'value-invalid', message: `"${field.label}" must be at most ${field.max}.`, path: field.name, retryable: true };
      } else if (field.type === 'boolean') {
        if (typeof supplied !== 'boolean') return { code: 'value-invalid', message: `"${field.label}" must be true or false.`, path: field.name, retryable: true };
      } else if (field.type === 'select') {
        if (typeof supplied !== 'string' || !field.options?.some(option => option.value === supplied)) {
          return { code: 'value-invalid', message: `"${field.label}" must be one of the offered options.`, path: field.name, retryable: true };
        }
      } else {
        if (typeof supplied !== 'string') return { code: 'value-invalid', message: `"${field.label}" must be text.`, path: field.name, retryable: true };
        const max = field.maxLength ?? GADGET_LIMITS.stringLength;
        if (supplied.length > max) return { code: 'value-invalid', message: `"${field.label}" is longer than ${max} characters.`, path: field.name, retryable: true };
      }
    }
    return undefined;
  }

  if (envelope.kind === 'conflict') {
    if (value.kind !== 'form') return { code: 'value-invalid', message: 'A conflict resolution needs a choice per conflict.', retryable: true };
    const payload = envelope.payload as { conflicts: { id: string; label: string }[] };
    for (const conflict of payload.conflicts) {
      const resolution = value.fields[conflict.id];
      if (resolution === undefined) {
        return { code: 'value-invalid', message: `"${conflict.label}" has not been resolved.`, path: conflict.id, retryable: true };
      }
      if (resolution !== 'ours' && resolution !== 'theirs') {
        return { code: 'value-invalid', message: `"${conflict.label}" must resolve to "ours" or "theirs".`, path: conflict.id, retryable: true };
      }
    }
    return undefined;
  }

  // Informational kinds carry only acknowledgement-style actions.
  if (value.kind !== 'none' && value.kind !== 'confirmation') {
    return { code: 'value-invalid', message: 'This gadget does not take a value.', retryable: false };
  }
  return undefined;
}

/** Narrow a submitted value's shape before it is trusted, for IPC input. */
export function isGadgetActionValue(value: unknown): value is GadgetActionValue {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'none':
      return true;
    case 'choice':
      return typeof value.selected === 'string';
    case 'confirmation':
      return typeof value.confirmed === 'boolean';
    case 'selection':
      return Array.isArray(value.selected) && value.selected.every(entry => typeof entry === 'string');
    case 'form':
      return (
        isRecord(value.fields) &&
        Object.values(value.fields).every(entry => ['string', 'number', 'boolean'].includes(typeof entry))
      );
    default:
      return false;
  }
}
