import React, { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import type {
  AnyGadgetEnvelope,
  GadgetActionDescriptor,
  GadgetActionValue,
  GadgetKind,
  GadgetPayloadMap,
  MobileGadgetView,
} from '@praxis/core';
import {
  canDrawGadget,
  chartBars,
  formActionValue,
  inertGadgetReason,
  initialFormValues,
  isGadgetAnswerable,
  validateFormValues,
  type FormValues,
} from '../renderer/mobileGadgets';
import { Markdown, MONOSPACE } from './Markdown';
import { mobileScale, theme, themedStyles } from './theme';

/** Sends an answer; resolves when the desktop has recorded it, rejects with a message a person can read. */
export type GadgetAnswer = (gadget: AnyGadgetEnvelope, action: GadgetActionDescriptor, value: GadgetActionValue) => Promise<void>;

function payloadOf<K extends GadgetKind>(gadget: AnyGadgetEnvelope): GadgetPayloadMap[K] {
  return gadget.payload as GadgetPayloadMap[K];
}

/** The desktop's convention: an informational button declines, anything else confirms. */
const confirmationValue = (action: GadgetActionDescriptor): GadgetActionValue => ({ kind: 'confirmation', confirmed: action.effect !== 'informational' });
const noValue = (): GadgetActionValue => ({ kind: 'none' });

function Heading({ title, detail }: { title: string; detail?: string }): React.JSX.Element {
  return (
    <View style={styles.heading}>
      <Text accessibilityRole="header" style={styles.title}>{title}</Text>
      {detail ? <Markdown text={detail} /> : null}
    </View>
  );
}

function ActionBar({
  gadget,
  answerable,
  valueFor,
  blockedReason,
  onAnswer,
}: {
  gadget: AnyGadgetEnvelope;
  answerable: boolean;
  valueFor: (action: GadgetActionDescriptor) => GadgetActionValue | undefined;
  blockedReason?: string;
  onAnswer: GadgetAnswer;
}): React.JSX.Element | null {
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  if (gadget.actions.length === 0) return null;

  const send = async (action: GadgetActionDescriptor): Promise<void> => {
    const value = valueFor(action);
    if (!value) return;
    const go = async (): Promise<void> => {
      setBusy(action.actionId);
      setError(undefined);
      try {
        await onAnswer(gadget, action, value);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(undefined);
      }
    };
    if (action.danger) {
      Alert.alert(action.label, action.description ?? 'This cannot be undone from the phone.', [
        { text: 'Cancel', style: 'cancel' },
        { text: action.label, style: 'destructive', onPress: () => void go() },
      ]);
      return;
    }
    await go();
  };

  return (
    <View style={styles.actions}>
      {blockedReason && answerable ? <Text style={styles.blocked}>{blockedReason}</Text> : null}
      <View style={styles.actionRow}>
        {gadget.actions.map(action => {
          const disabled = !answerable || Boolean(busy) || valueFor(action) === undefined;
          const primary = action.effect !== 'informational' && !action.danger;
          return (
            <Pressable
              key={action.actionId}
              accessibilityRole="button"
              accessibilityLabel={action.description ? `${action.label}. ${action.description}` : action.label}
              accessibilityState={{ disabled, busy: busy === action.actionId }}
              disabled={disabled}
              onPress={() => void send(action)}
              style={({ pressed }) => [
                styles.action,
                primary ? styles.actionPrimary : action.danger ? styles.actionDanger : styles.actionGhost,
                pressed && styles.pressed,
                disabled && styles.disabled,
              ]}
            >
              {busy === action.actionId
                ? <ActivityIndicator color={primary ? theme.onAccent : theme.text} />
                : <Text style={[styles.actionText, primary && styles.actionTextPrimary, action.danger && styles.actionTextDanger]}>{action.label}</Text>}
            </Pressable>
          );
        })}
      </View>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    </View>
  );
}

function Choice({ gadget, answerable, onAnswer }: GadgetBodyProps): React.JSX.Element {
  const payload = payloadOf<'choice'>(gadget);
  const multiple = payload.multiple === true;
  const [selected, setSelected] = useState<string[]>(payload.defaultValue ? [payload.defaultValue] : []);
  const toggle = (value: string): void => setSelected(current => (!multiple ? [value] : current.includes(value) ? current.filter(entry => entry !== value) : [...current, value]));
  return (
    <>
      <Heading title={payload.question} detail={payload.detail} />
      <View accessibilityRole={multiple ? undefined : 'radiogroup'} style={styles.options}>
        {payload.options.map(option => {
          const checked = selected.includes(option.value);
          const unavailable = Boolean(option.disabledReason);
          return (
            <Pressable
              key={option.value}
              accessibilityRole={multiple ? 'checkbox' : 'radio'}
              accessibilityState={{ checked, disabled: !answerable || unavailable }}
              disabled={!answerable || unavailable}
              onPress={() => toggle(option.value)}
              style={[styles.option, checked && styles.optionSelected, unavailable && styles.disabled]}
            >
              <Text style={styles.optionMark}>{multiple ? (checked ? '☑' : '☐') : checked ? '◉' : '○'}</Text>
              <View style={styles.optionBody}>
                <Text style={styles.optionLabel}>{option.label}</Text>
                {option.description ? <Text style={styles.dim}>{option.description}</Text> : null}
                {option.disabledReason ? <Text style={styles.blocked}>Unavailable: {option.disabledReason}</Text> : null}
              </View>
            </Pressable>
          );
        })}
      </View>
      <ActionBar
        gadget={gadget}
        answerable={answerable}
        onAnswer={onAnswer}
        blockedReason={selected.length === 0 ? 'Choose an option first.' : undefined}
        valueFor={() => (selected.length === 0 ? undefined : multiple ? { kind: 'selection', selected } : { kind: 'choice', selected: selected[0] })}
      />
    </>
  );
}

function Confirmation({ gadget, answerable, onAnswer }: GadgetBodyProps): React.JSX.Element {
  const payload = payloadOf<'confirmation'>(gadget);
  return (
    <>
      <Heading title={payload.question} detail={payload.detail} />
      {payload.consequences?.length ? (
        <View style={styles.list}>
          {payload.consequences.map((line, index) => <Text key={index} style={styles.body}>• {line}</Text>)}
        </View>
      ) : null}
      <ActionBar gadget={gadget} answerable={answerable} onAnswer={onAnswer} valueFor={confirmationValue} />
    </>
  );
}

function Approval({ gadget, answerable, onAnswer }: GadgetBodyProps): React.JSX.Element {
  const payload = payloadOf<'approval'>(gadget);
  return (
    <>
      <Heading title={payload.title} />
      <Markdown text={payload.summary} />
      {payload.effect ? <Text style={styles.effect}>Approving: {payload.effect}</Text> : null}
      {payload.evidence?.length ? (
        <View style={styles.evidence}>
          {payload.evidence.map((row, index) => (
            <View key={index} style={styles.evidenceRow}>
              <Text style={styles.evidenceLabel}>{row.label}</Text>
              <Text selectable style={styles.evidenceValue}>{row.value}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {payload.requestedBy ? <Text style={styles.dim}>Requested by {payload.requestedBy} · gate {payload.gate}</Text> : null}
      <ActionBar gadget={gadget} answerable={answerable} onAnswer={onAnswer} valueFor={confirmationValue} />
    </>
  );
}

function FormField({ field, value, error, editable, onChange }: {
  field: GadgetPayloadMap['form']['fields'][number];
  value: string | boolean | undefined;
  error?: string;
  editable: boolean;
  onChange: (next: string | boolean) => void;
}): React.JSX.Element {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{field.label}{field.required ? ' *' : ''}</Text>
      {field.type === 'boolean' ? (
        <Switch accessibilityLabel={field.label} value={value === true} disabled={!editable} onValueChange={onChange} />
      ) : field.type === 'select' ? (
        <View style={styles.chips}>
          {(field.options ?? []).map(option => (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityState={{ checked: value === option.value, disabled: !editable }}
              disabled={!editable || Boolean(option.disabledReason)}
              onPress={() => onChange(option.value)}
              style={[styles.chip, value === option.value && styles.optionSelected]}
            >
              <Text style={styles.body}>{option.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <TextInput
          accessibilityLabel={field.label}
          editable={editable}
          value={typeof value === 'string' ? value : ''}
          onChangeText={onChange}
          placeholder={field.placeholder}
          placeholderTextColor={theme.textDim}
          keyboardType={field.type === 'number' ? 'decimal-pad' : 'default'}
          multiline={field.type === 'textarea'}
          maxLength={field.maxLength}
          style={[styles.input, field.type === 'textarea' && styles.textarea]}
        />
      )}
      {field.help ? <Text style={styles.dim}>{field.help}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

function Form({ gadget, answerable, onAnswer }: GadgetBodyProps): React.JSX.Element {
  const payload = payloadOf<'form'>(gadget);
  const [values, setValues] = useState<FormValues>(() => initialFormValues(payload));
  const [touched, setTouched] = useState(false);
  const errors = validateFormValues(payload, values);
  const invalid = Object.keys(errors).length > 0;
  return (
    <>
      <Heading title={payload.title} detail={payload.description} />
      {payload.fields.map(field => (
        <FormField
          key={field.name}
          field={field}
          value={values[field.name]}
          editable={answerable}
          {...(touched && errors[field.name] ? { error: errors[field.name] } : {})}
          onChange={next => {
            setTouched(true);
            setValues(current => ({ ...current, [field.name]: next }));
          }}
        />
      ))}
      <ActionBar
        gadget={gadget}
        answerable={answerable}
        onAnswer={onAnswer}
        blockedReason={invalid ? `Still needed: ${payload.fields.filter(field => errors[field.name]).map(field => field.label).join(', ')}.` : undefined}
        valueFor={() => (invalid ? undefined : formActionValue(payload, values))}
      />
    </>
  );
}

function Table({ gadget, answerable, onAnswer }: GadgetBodyProps): React.JSX.Element {
  const payload = payloadOf<'table'>(gadget);
  const width = mobileScale(128);
  return (
    <>
      {payload.title ? <Heading title={payload.title} /> : null}
      {payload.rows.length === 0 ? <Text style={styles.dim}>{payload.emptyText ?? 'No rows.'}</Text> : (
        <ScrollView horizontal nestedScrollEnabled>
          <View style={styles.table}>
            <View style={[styles.tableRow, styles.tableHeader]}>
              {payload.columns.map(column => <Text key={column.key} style={[styles.cell, styles.cellHeader, { width }, column.align === 'end' && styles.cellEnd]}>{column.label}</Text>)}
            </View>
            {payload.rows.map((row, index) => (
              <View key={index} style={styles.tableRow}>
                {payload.columns.map(column => (
                  <Text key={column.key} selectable style={[styles.cell, { width }, column.mono && styles.mono, column.align === 'end' && styles.cellEnd]}>
                    {row[column.key] === null || row[column.key] === undefined ? '—' : String(row[column.key])}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      )}
      {payload.caption ? <Text style={styles.dim}>{payload.caption}</Text> : null}
      {payload.truncated ? <Text style={styles.dim}>Some rows were left off on the phone. The desktop shows them all.</Text> : null}
      <ActionBar gadget={gadget} answerable={answerable} onAnswer={onAnswer} valueFor={noValue} />
    </>
  );
}

function Chart({ gadget, answerable, onAnswer }: GadgetBodyProps): React.JSX.Element {
  const payload = payloadOf<'chart'>(gadget);
  const { series, bars, more } = chartBars(payload);
  return (
    <>
      {payload.title ? <Heading title={payload.title} /> : null}
      {series ? <Text style={styles.dim}>{series}{payload.series.length > 1 ? ` (1 of ${payload.series.length} series)` : ''}</Text> : null}
      <View style={styles.bars} accessibilityLabel={bars.map(bar => `${bar.label}: ${bar.value}`).join(', ')}>
        {bars.map((bar, index) => (
          <View key={index} style={styles.barRow}>
            <Text numberOfLines={1} style={styles.barLabel}>{bar.label}</Text>
            <View style={styles.barTrack}><View style={[styles.barFill, { width: `${Math.max(2, bar.fraction * 100)}%` }]} /></View>
            <Text style={styles.barValue}>{bar.value}</Text>
          </View>
        ))}
      </View>
      {more > 0 ? <Text style={styles.dim}>{more} more not shown.</Text> : null}
      {payload.summary ? <Text style={styles.body}>{payload.summary}</Text> : null}
      <ActionBar gadget={gadget} answerable={answerable} onAnswer={onAnswer} valueFor={noValue} />
    </>
  );
}

function Progress({ gadget, answerable, onAnswer }: GadgetBodyProps): React.JSX.Element {
  const payload = payloadOf<'progress'>(gadget);
  const tone = payload.status === 'succeeded' ? theme.ok : payload.status === 'failed' ? theme.danger : payload.status === 'blocked' ? theme.warn : theme.accent;
  return (
    <>
      <Heading title={payload.title} />
      <View style={styles.barTrack} accessibilityRole="progressbar" accessibilityValue={payload.percent === undefined ? undefined : { min: 0, max: 100, now: payload.percent }}>
        <View style={[styles.barFill, { backgroundColor: tone, width: payload.percent === undefined ? '35%' : `${Math.max(2, Math.min(100, payload.percent))}%` }]} />
      </View>
      <Text style={[styles.dim, { color: tone }]}>{payload.status}{payload.percent !== undefined ? ` · ${Math.round(payload.percent)}%` : ''}</Text>
      {payload.detail ? <Text style={styles.body}>{payload.detail}</Text> : null}
      {payload.steps?.map((step, index) => (
        <Text key={index} style={styles.body}>{step.state === 'done' ? '✓' : step.state === 'failed' ? '✕' : step.state === 'running' ? '▸' : '·'} {step.label}</Text>
      ))}
      <ActionBar gadget={gadget} answerable={answerable} onAnswer={onAnswer} valueFor={noValue} />
    </>
  );
}

function Diff({ gadget, answerable, onAnswer }: GadgetBodyProps): React.JSX.Element {
  const payload = payloadOf<'diff'>(gadget);
  const [open, setOpen] = useState<string | undefined>(undefined);
  return (
    <>
      {payload.title ? <Heading title={payload.title} /> : null}
      {payload.summary ? <Text style={styles.body}>{payload.summary}</Text> : null}
      {payload.files.map(file => (
        <View key={file.path} style={styles.fileRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: open === file.path }}
            disabled={!file.preview}
            onPress={() => setOpen(current => (current === file.path ? undefined : file.path))}
            style={styles.fileHeader}
          >
            <Text numberOfLines={1} style={[styles.mono, styles.fileName]}>{file.status === 'renamed' && file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}</Text>
            <Text style={[styles.mono, { color: theme.ok }]}>+{file.additions}</Text>
            <Text style={[styles.mono, { color: theme.danger }]}>−{file.deletions}</Text>
          </Pressable>
          {open === file.path && file.preview ? (
            <ScrollView horizontal nestedScrollEnabled style={styles.preview}>
              <Text selectable style={[styles.mono, styles.previewText]}>{file.preview}</Text>
            </ScrollView>
          ) : null}
        </View>
      ))}
      {payload.truncated ? <Text style={styles.dim}>More files changed than the phone shows.</Text> : null}
      <ActionBar gadget={gadget} answerable={answerable} onAnswer={onAnswer} valueFor={confirmationValue} />
    </>
  );
}

function Artifact({ gadget, answerable, onAnswer }: GadgetBodyProps): React.JSX.Element {
  const payload = payloadOf<'artifact'>(gadget);
  return (
    <>
      <Heading title={payload.title} />
      {payload.artifacts.map(artifact => (
        <View key={artifact.path} style={styles.fileRow}>
          <Text style={styles.optionLabel}>{artifact.name}</Text>
          <Text numberOfLines={1} style={[styles.mono, styles.dim]}>{artifact.path}{artifact.sizeBytes !== undefined ? ` · ${formatBytes(artifact.sizeBytes)}` : ''}</Text>
          {artifact.description ? <Text style={styles.dim}>{artifact.description}</Text> : null}
        </View>
      ))}
      <ActionBar gadget={gadget} answerable={answerable} onAnswer={onAnswer} valueFor={noValue} />
    </>
  );
}

function Handoff({ gadget, answerable, onAnswer }: GadgetBodyProps): React.JSX.Element {
  const payload = payloadOf<'handoff'>(gadget);
  return (
    <>
      <Heading title={payload.title} />
      <Text style={styles.dim}>{payload.fromProvider} → {payload.toProvider}</Text>
      <Markdown text={payload.contextSummary} />
      {payload.includedItems?.length ? <Text style={styles.body}>Included: {payload.includedItems.map(item => item.label).join(', ')}</Text> : null}
      {payload.excludedItems?.length ? <Text style={styles.body}>Left out: {payload.excludedItems.map(item => item.reason ? `${item.label} (${item.reason})` : item.label).join(', ')}</Text> : null}
      {payload.warning ? <Text style={styles.effect}>{payload.warning}</Text> : null}
      <ActionBar gadget={gadget} answerable={answerable} onAnswer={onAnswer} valueFor={confirmationValue} />
    </>
  );
}

function Conflict({ gadget, answerable, onAnswer }: GadgetBodyProps): React.JSX.Element {
  const payload = payloadOf<'conflict'>(gadget);
  const [choices, setChoices] = useState<Record<string, 'ours' | 'theirs'>>({});
  const unresolved = payload.conflicts.filter(conflict => !choices[conflict.id]);
  return (
    <>
      <Heading title={payload.title} detail={payload.description} />
      {payload.conflicts.map(conflict => (
        <View key={conflict.id} style={styles.fileRow}>
          <Text style={styles.optionLabel}>{conflict.label}{conflict.path ? `  ·  ${conflict.path}` : ''}</Text>
          {(['ours', 'theirs'] as const).map(side => (
            <Pressable
              key={side}
              accessibilityRole="radio"
              accessibilityState={{ checked: choices[conflict.id] === side, disabled: !answerable }}
              disabled={!answerable}
              onPress={() => setChoices(current => ({ ...current, [conflict.id]: side }))}
              style={[styles.option, choices[conflict.id] === side && styles.optionSelected]}
            >
              <Text style={styles.optionMark}>{choices[conflict.id] === side ? '◉' : '○'}</Text>
              <View style={styles.optionBody}>
                <Text style={styles.dim}>{side === 'ours' ? 'Ours' : 'Theirs'}</Text>
                <Text selectable style={[styles.mono, styles.previewText]}>{conflict[side]}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      ))}
      <ActionBar
        gadget={gadget}
        answerable={answerable}
        onAnswer={onAnswer}
        blockedReason={unresolved.length ? `${unresolved.length} still to choose — Praxis never picks a side for you.` : undefined}
        valueFor={() => (unresolved.length ? undefined : { kind: 'form', fields: { ...choices } })}
      />
    </>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface GadgetBodyProps { gadget: AnyGadgetEnvelope; answerable: boolean; onAnswer: GadgetAnswer }

const BODIES: Record<GadgetKind, (props: GadgetBodyProps) => React.JSX.Element> = {
  choice: Choice,
  confirmation: Confirmation,
  approval: Approval,
  form: Form,
  table: Table,
  chart: Chart,
  progress: Progress,
  diff: Diff,
  artifact: Artifact,
  handoff: Handoff,
  conflict: Conflict,
};

/**
 * One gadget in a conversation. An unknown kind or version, or a body that
 * throws on an unexpected payload, falls back to the gadget's own text — the
 * contract requires every gadget to carry one for exactly this reason.
 */
export function GadgetView({ view, connected, onAnswer }: { view: MobileGadgetView; connected: boolean; onAnswer: GadgetAnswer }): React.JSX.Element {
  const { gadget } = view;
  const reason = inertGadgetReason(view) ?? (connected ? undefined : 'Reconnect to the desktop to answer.');
  const answerable = isGadgetAnswerable(view) && connected;
  const Body = canDrawGadget(gadget) ? BODIES[gadget.kind] : undefined;
  return (
    <View style={[styles.card, !answerable && gadget.actions.length > 0 && styles.cardInert]} accessibilityLabel={`${gadget.kind} from the agent`}>
      {Body ? (
        <GadgetBoundary fallback={gadget.fallbackText}>
          <Body gadget={gadget} answerable={answerable} onAnswer={onAnswer} />
        </GadgetBoundary>
      ) : (
        <Markdown text={gadget.fallbackText} />
      )}
      {reason && gadget.actions.length > 0 ? <Text style={styles.inert}>{reason}</Text> : null}
    </View>
  );
}

class GadgetBoundary extends React.Component<{ fallback: string; children: React.ReactNode }, { failed: boolean }> {
  public state = { failed: false };
  public static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  public render(): React.ReactNode {
    return this.state.failed ? <Markdown text={this.props.fallback} /> : this.props.children;
  }
}

const styles = themedStyles(() => StyleSheet.create({
  card: { borderWidth: 1, borderColor: theme.borderStrong, borderRadius: mobileScale(10), backgroundColor: theme.surfaceRaised, padding: mobileScale(12), gap: mobileScale(10) },
  cardInert: { opacity: 0.85 },
  heading: { gap: mobileScale(4) },
  title: { color: theme.text, fontSize: mobileScale(15), fontWeight: '700' },
  body: { color: theme.text, fontSize: mobileScale(14), lineHeight: mobileScale(20) },
  dim: { color: theme.textDim, fontSize: mobileScale(12.5), lineHeight: mobileScale(18) },
  mono: { fontFamily: MONOSPACE, fontSize: mobileScale(12), color: theme.text },
  effect: { color: theme.warn, fontSize: mobileScale(13.5), fontWeight: '600' },
  blocked: { color: theme.warn, fontSize: mobileScale(12.5) },
  error: { color: theme.danger, fontSize: mobileScale(13) },
  inert: { color: theme.textDim, fontSize: mobileScale(12.5), fontStyle: 'italic' },
  list: { gap: mobileScale(4) },
  options: { gap: mobileScale(6) },
  option: { flexDirection: 'row', gap: mobileScale(10), borderWidth: 1, borderColor: theme.border, borderRadius: mobileScale(8), padding: mobileScale(10), backgroundColor: theme.surface },
  optionSelected: { borderColor: theme.accent, backgroundColor: theme.accentSoft },
  optionMark: { color: theme.accent, fontSize: mobileScale(16), lineHeight: mobileScale(20) },
  optionBody: { flex: 1, gap: 2 },
  optionLabel: { color: theme.text, fontSize: mobileScale(14), fontWeight: '600' },
  actions: { gap: mobileScale(6) },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: mobileScale(8) },
  action: { minHeight: mobileScale(42), minWidth: mobileScale(96), paddingHorizontal: mobileScale(14), borderRadius: mobileScale(9), alignItems: 'center', justifyContent: 'center' },
  actionPrimary: { backgroundColor: theme.accent },
  actionGhost: { borderWidth: 1, borderColor: theme.border },
  actionDanger: { borderWidth: 1, borderColor: theme.danger },
  actionText: { color: theme.text, fontSize: mobileScale(14), fontWeight: '700' },
  actionTextPrimary: { color: theme.onAccent },
  actionTextDanger: { color: theme.danger },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.45 },
  evidence: { borderWidth: 1, borderColor: theme.border, borderRadius: mobileScale(8) },
  evidenceRow: { flexDirection: 'row', gap: mobileScale(10), paddingHorizontal: mobileScale(10), paddingVertical: mobileScale(7), borderBottomWidth: 1, borderBottomColor: theme.border },
  evidenceLabel: { color: theme.textDim, fontSize: mobileScale(12.5), width: '38%' },
  evidenceValue: { color: theme.text, fontSize: mobileScale(12.5), flex: 1 },
  field: { gap: mobileScale(4) },
  fieldLabel: { color: theme.textSecondary, fontSize: mobileScale(12.5), fontWeight: '600' },
  input: { borderWidth: 1, borderColor: theme.border, borderRadius: mobileScale(8), backgroundColor: theme.input, color: theme.text, paddingHorizontal: mobileScale(10), paddingVertical: mobileScale(8), fontSize: mobileScale(14) },
  textarea: { minHeight: mobileScale(88), textAlignVertical: 'top' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: mobileScale(6) },
  chip: { borderWidth: 1, borderColor: theme.border, borderRadius: 999, paddingHorizontal: mobileScale(12), paddingVertical: mobileScale(6) },
  table: { borderWidth: 1, borderColor: theme.border, borderRadius: mobileScale(6) },
  tableRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: theme.border },
  tableHeader: { backgroundColor: theme.bgSunken },
  cell: { color: theme.text, fontSize: mobileScale(12.5), paddingHorizontal: mobileScale(8), paddingVertical: mobileScale(6) },
  cellHeader: { fontWeight: '700' },
  cellEnd: { textAlign: 'right' },
  bars: { gap: mobileScale(6) },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: mobileScale(8) },
  barLabel: { color: theme.textSecondary, fontSize: mobileScale(12), width: '26%' },
  barTrack: { flex: 1, height: mobileScale(8), borderRadius: 4, backgroundColor: theme.bgSunken, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 4, backgroundColor: theme.accent },
  barValue: { color: theme.text, fontSize: mobileScale(12), minWidth: mobileScale(36), textAlign: 'right' },
  fileRow: { gap: mobileScale(4), borderTopWidth: 1, borderTopColor: theme.border, paddingTop: mobileScale(8) },
  fileHeader: { flexDirection: 'row', alignItems: 'center', gap: mobileScale(8) },
  fileName: { flex: 1 },
  preview: { backgroundColor: theme.bgSunken, borderRadius: mobileScale(6), maxHeight: mobileScale(240) },
  previewText: { padding: mobileScale(8), lineHeight: mobileScale(17) },
}));
