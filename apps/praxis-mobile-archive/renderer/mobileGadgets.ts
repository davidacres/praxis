/**
 * What the phone decides about a gadget before drawing it: can it still be
 * answered, what does an answer look like, and does answering need the
 * person to prove it is them. Pure, so it tests without React Native.
 */
import type {
  AnyGadgetEnvelope,
  ChartGadgetPayload,
  FormGadgetPayload,
  GadgetActionDescriptor,
  GadgetActionValue,
  GadgetFormField,
  GadgetKind,
  MobileGadgetView,
} from '@praxis/core';

/** Every kind the phone draws natively; anything else shows its `fallbackText`. */
export const MOBILE_GADGET_KINDS: readonly GadgetKind[] = [
  'choice', 'confirmation', 'form', 'table', 'chart', 'progress', 'diff', 'artifact', 'handoff', 'conflict', 'approval',
];

export function canDrawGadget(gadget: Pick<AnyGadgetEnvelope, 'kind' | 'version'>): boolean {
  return gadget.version === 1 && MOBILE_GADGET_KINDS.includes(gadget.kind);
}

/** Answerable now: the host says it is active and no answer has settled it. */
export function isGadgetAnswerable(view: MobileGadgetView): boolean {
  if (view.state !== 'active') return false;
  return !(view.result && (view.result.status === 'completed' || view.result.status === 'accepted'));
}

/** Why a gadget no longer takes an answer, in words — or undefined while it does. */
export function inertGadgetReason(view: MobileGadgetView): string | undefined {
  if (isGadgetAnswerable(view)) return undefined;
  if (view.result?.message) return view.result.message;
  switch (view.state) {
    case 'submitted':
    case 'completed':
      return 'Answered.';
    case 'submitting':
      return 'Sending your answer…';
    case 'expired':
      return 'This question expired.';
    case 'superseded':
      return 'A newer question replaced this one.';
    case 'revoked':
      return 'The desktop withdrew this question.';
    case 'disconnected':
      return 'Reconnect to the desktop to answer.';
    default:
      return 'Answered.';
  }
}

/**
 * An answer that approves something, changes something, or is marked
 * dangerous is confirmed with Face ID / the device passcode first. Picking an
 * option in a conversation is not.
 */
export function answerNeedsIdentity(descriptor: Pick<GadgetActionDescriptor, 'effect' | 'danger'> | undefined): boolean {
  if (!descriptor) return false;
  return descriptor.effect !== 'informational' || descriptor.danger === true;
}

export type FormValues = Record<string, string | boolean>;

/** Field values as the form opens: the gadget's defaults, as editable strings or switches. */
export function initialFormValues(payload: FormGadgetPayload): FormValues {
  const values: FormValues = {};
  for (const field of payload.fields) {
    if (field.type === 'boolean') values[field.name] = field.defaultValue === true;
    else values[field.name] = field.defaultValue === undefined ? '' : String(field.defaultValue);
  }
  return values;
}

function fieldError(field: GadgetFormField, raw: string | boolean | undefined): string | undefined {
  if (field.type === 'boolean') return undefined;
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return field.required ? `${field.label} is required.` : undefined;
  if (field.maxLength !== undefined && text.length > field.maxLength) return `${field.label} must be at most ${field.maxLength} characters.`;
  if (field.type === 'number') {
    const value = Number(text);
    if (!Number.isFinite(value)) return `${field.label} must be a number.`;
    if (field.min !== undefined && value < field.min) return `${field.label} must be at least ${field.min}.`;
    if (field.max !== undefined && value > field.max) return `${field.label} must be at most ${field.max}.`;
  }
  if (field.type === 'select' && field.options && !field.options.some(option => option.value === text)) return `Choose a ${field.label.toLowerCase()}.`;
  return undefined;
}

/** Per-field problems, keyed by field name; empty when the form can be sent. */
export function validateFormValues(payload: FormGadgetPayload, values: FormValues): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of payload.fields) {
    const error = fieldError(field, values[field.name]);
    if (error) errors[field.name] = error;
  }
  return errors;
}

/** The form's answer with each field in its declared type; empty optional fields are left out. */
export function formActionValue(payload: FormGadgetPayload, values: FormValues): GadgetActionValue {
  const fields: Record<string, string | number | boolean> = {};
  for (const field of payload.fields) {
    const raw = values[field.name];
    if (field.type === 'boolean') {
      fields[field.name] = raw === true;
      continue;
    }
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) continue;
    fields[field.name] = field.type === 'number' ? Number(text) : text;
  }
  return { kind: 'form', fields };
}

/** The action a single-tap gadget (choice, confirmation, approval) answers with. */
export function primaryAction(gadget: AnyGadgetEnvelope): GadgetActionDescriptor | undefined {
  return gadget.actions.find(action => !action.danger) ?? gadget.actions[0];
}

export interface ChartBar { label: string; value: number; fraction: number }

/** Bars for the first series, scaled to the largest value; a phone draws one series. */
export function chartBars(payload: ChartGadgetPayload, limit = 12): { series: string; bars: ChartBar[]; more: number } {
  const series = payload.series[0];
  if (!series) return { series: '', bars: [], more: 0 };
  const points = series.points.slice(0, limit);
  const max = Math.max(0, ...points.map(point => Math.abs(point.y)));
  return {
    series: series.label,
    bars: points.map(point => ({ label: String(point.x), value: point.y, fraction: max > 0 ? Math.abs(point.y) / max : 0 })),
    more: Math.max(0, series.points.length - limit),
  };
}

/** Distinct per logical answer, reused if the same answer is retried. */
export function gadgetIdempotencyKey(gadgetId: string, actionId: string, value: GadgetActionValue): string {
  return `gadget:${gadgetId}:${actionId}:${stableHash(JSON.stringify(value))}`;
}

function stableHash(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
  return hash.toString(36);
}
