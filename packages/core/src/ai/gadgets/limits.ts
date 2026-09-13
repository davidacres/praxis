/**
 * Hard bounds on a gadget payload (FX-BE-078 → TASK-278).
 *
 * These exist because a gadget request can originate from a model. Unbounded
 * model output rendered as UI is how you get a 40 000-row table that freezes
 * the renderer, so the host trims to these numbers and sets `truncated` rather
 * than trusting the producer to be reasonable.
 */
export const GADGET_LIMITS = {
  /** Serialized envelope ceiling. Generous for prose, far below a payload that could stall IPC. */
  envelopeBytes: 128 * 1024,
  /** Any single string field. Long tool output belongs in an artifact, not a label. */
  stringLength: 20_000,
  choiceOptions: 24,
  formFields: 24,
  tableRows: 200,
  tableColumns: 20,
  chartSeries: 8,
  chartPoints: 500,
  diffFiles: 100,
  diffPreviewLength: 8_000,
  artifacts: 50,
  progressSteps: 40,
  conflicts: 50,
  handoffItems: 60,
  approvalEvidence: 40,
  /** More than a handful of buttons on one gadget is a menu, not a decision. */
  actions: 8
} as const;

export type GadgetLimits = typeof GADGET_LIMITS;
