/**
 * Preview verification (FX-BE-056 / TASK-149).
 *
 * A repeatable check against a Run preview: a few scripted interactions
 * (click, type, wait), then a set of deterministic assertions against what
 * happened — page text, console output, and network requests captured by
 * TASK-147's `BrowserDiagnosticsRecorder`. This is the piece that turns
 * "I opened the preview and it looked fine" into something a CI-style gate
 * can actually pass or fail on.
 *
 * **Screenshots alone are never a passing test.** `PreviewVerificationOutcome.passed`
 * is computed exclusively from `AssertionResult[]` — a screenshot is carried
 * alongside as evidence for a person to look at, in a field `passed` never
 * reads. This is deliberate: a pixel snapshot can "look right" while an API
 * silently 500s, or "look wrong" from an unrelated font-rendering or
 * animation-timing difference that has nothing to do with correctness.
 * `screenshotsMatch` below is a byte-identity check only (no pixel diffing —
 * this sandbox has no image-processing dependency available to build or
 * verify one against), explicitly not a pass/fail signal for that same
 * reason twice over.
 */

/**
 * `selector` is a plain CSS selector against the live page — deliberately
 * unlike the AI-driven browser's snapshot-assigned `ref`s (`browserTools.ts`),
 * which only exist for the duration of one `browser_snapshot` call. A
 * repeatable, deterministic check needs a stable target it can write once
 * and re-run indefinitely, which a real selector is and an ephemeral ref
 * is not.
 */
export type PreviewInteraction =
  | { kind: 'click'; selector: string }
  | { kind: 'type'; selector: string; text: string; submit?: boolean }
  | { kind: 'wait'; ms: number };

export type PreviewAssertion =
  | { kind: 'text-present'; text: string }
  | { kind: 'text-absent'; text: string }
  | { kind: 'no-console-errors' }
  | { kind: 'no-failed-requests' }
  | { kind: 'http-status'; urlContains: string; expectedStatus: number };

export interface PreviewVerificationCheck {
  id: string;
  name: string;
  serviceId: string;
  /** Relative to the service's granted preview origin, e.g. "/checkout". */
  path: string;
  interactions: PreviewInteraction[];
  assertions: PreviewAssertion[];
}

/** What a verification run actually observed — page text plus the same console/network shape `BrowserDiagnosticsRecorder` captures. */
export interface PreviewVerificationSnapshot {
  pageText: string;
  console: Array<{ level: 'log' | 'info' | 'warning' | 'error'; message: string }>;
  network: Array<{ url: string; method: string; status?: number; error?: string }>;
}

export interface AssertionResult {
  assertion: PreviewAssertion;
  passed: boolean;
  detail: string;
}

export interface PreviewVerificationOutcome {
  checkId: string;
  serviceId: string;
  /** Computed exclusively from `results` — see the module comment. */
  passed: boolean;
  results: AssertionResult[];
  capturedAt: string;
  screenshot?: { path: string; baselineComparison?: 'match' | 'differs' | 'no-baseline' };
}

function describeAssertion(assertion: PreviewAssertion): string {
  switch (assertion.kind) {
    case 'text-present':
      return `text present: "${assertion.text}"`;
    case 'text-absent':
      return `text absent: "${assertion.text}"`;
    case 'no-console-errors':
      return 'no console errors';
    case 'no-failed-requests':
      return 'no failed requests';
    case 'http-status':
      return `${assertion.urlContains} → HTTP ${assertion.expectedStatus}`;
  }
}

function evaluateOne(assertion: PreviewAssertion, snapshot: PreviewVerificationSnapshot): AssertionResult {
  switch (assertion.kind) {
    case 'text-present': {
      const found = snapshot.pageText.includes(assertion.text);
      return { assertion, passed: found, detail: found ? `Found "${assertion.text}".` : `Expected to find "${assertion.text}" on the page.` };
    }
    case 'text-absent': {
      const found = snapshot.pageText.includes(assertion.text);
      return { assertion, passed: !found, detail: found ? `Found "${assertion.text}", which should not appear.` : `"${assertion.text}" correctly absent.` };
    }
    case 'no-console-errors': {
      const errors = snapshot.console.filter(entry => entry.level === 'error');
      return {
        assertion,
        passed: errors.length === 0,
        detail: errors.length === 0 ? 'No console errors.' : `${errors.length} console error(s): ${errors.map(e => e.message).join('; ')}`
      };
    }
    case 'no-failed-requests': {
      return {
        assertion,
        passed: snapshot.network.length === 0,
        detail:
          snapshot.network.length === 0
            ? 'No failed requests.'
            : `${snapshot.network.length} failed request(s): ${snapshot.network.map(n => `${n.method} ${n.url} (${n.status ?? n.error ?? 'failed'})`).join('; ')}`
      };
    }
    case 'http-status': {
      const matching = snapshot.network.find(entry => entry.url.includes(assertion.urlContains));
      // A request that never failed at all is not visible in `network` (only
      // failures are captured) — so "no matching failure" is itself the pass
      // case for the common "this request should succeed" assertion shape,
      // and only a captured failure with the wrong status is a fail.
      if (!matching) {
        return { assertion, passed: true, detail: `No failed request matching "${assertion.urlContains}" — assumed to have succeeded.` };
      }
      const passed = matching.status === assertion.expectedStatus;
      return {
        assertion,
        passed,
        detail: passed
          ? `${assertion.urlContains} returned ${matching.status} as expected.`
          : `${assertion.urlContains} returned ${matching.status ?? matching.error ?? 'no response'}, expected ${assertion.expectedStatus}.`
      };
    }
  }
}

export function evaluateAssertions(assertions: PreviewAssertion[], snapshot: PreviewVerificationSnapshot): AssertionResult[] {
  return assertions.map(assertion => evaluateOne(assertion, snapshot));
}

export function summarizeOutcome(input: {
  checkId: string;
  serviceId: string;
  results: AssertionResult[];
  capturedAt: string;
  screenshot?: { path: string; baselineComparison?: 'match' | 'differs' | 'no-baseline' };
}): PreviewVerificationOutcome {
  return {
    checkId: input.checkId,
    serviceId: input.serviceId,
    passed: input.results.every(result => result.passed),
    results: input.results,
    capturedAt: input.capturedAt,
    ...(input.screenshot ? { screenshot: input.screenshot } : {})
  };
}

/**
 * Byte-identity only — same bytes in, same bytes out. Not a visual
 * similarity check and never used to decide `passed` (see module comment).
 * A `true` here means "pixel-for-pixel unchanged since the baseline was
 * captured"; `false` means "something changed" with no indication of how
 * much or where — a person opens both files to judge that.
 */
export function screenshotsMatch(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.equals(b);
}

/**
 * Renders a failed outcome as evidence text — fenced as DATA, matching
 * `ai/diagnosisBrief.ts`'s `renderDiagnosisPrompt` discipline: this is
 * something a diagnosis agent reads, never something it executes. Kept
 * standalone rather than folded into `diagnosisBrief.ts` itself, since a
 * preview verification failure has no `WorkflowCheckNode`/`WorkflowRun` to
 * attach to — a caller wanting a full diagnosis session still goes through
 * that module's existing `preflightDiagnosis`/`createDiagnosisSession`,
 * handing this text in as the evidence content.
 */
export function renderVerificationFailureContext(check: PreviewVerificationCheck, outcome: PreviewVerificationOutcome): string {
  if (outcome.passed) return `Preview verification "${check.name}" passed — no failure context to report.`;
  const failed = outcome.results.filter(result => !result.passed);
  const lines = [
    `Preview verification "${check.name}" failed (service: ${check.serviceId}, path: ${check.path}).`,
    '',
    `${failed.length} of ${outcome.results.length} assertion(s) failed:`,
    ...failed.map(result => `- ${describeAssertion(result.assertion)}: ${result.detail}`),
    ''
  ];
  if (outcome.screenshot) {
    lines.push(
      outcome.screenshot.baselineComparison === 'differs'
        ? `A screenshot was captured and differs from the stored baseline (byte comparison only — open both images to see how).`
        : `A screenshot was captured at ${outcome.screenshot.path}.`
    );
  }
  return lines.join('\n');
}
