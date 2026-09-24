import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { MobileRunSnapshot } from '@praxis/core';
import { approvalContext, type RunTone } from '../renderer/mobileWorkflowRuns';
import { useStore } from './store';
import { mobileScale, theme, themedStyles } from './theme';

function toneColor(tone: RunTone): string {
  return tone === 'ok' ? theme.ok : tone === 'danger' ? theme.danger : tone === 'warn' ? theme.warn : tone === 'live' ? theme.accent : theme.textDim;
}

/**
 * A run's approval as a decision rather than a tap: the steps it rests on and
 * how each ended, what they found, what the gate asks — then Approve, or
 * Reject with a reason that is recorded on the run. Both ask for Face ID or
 * the passcode first.
 */
export function ApprovalPanel({ runId, run, onDone }: { runId: string; run: MobileRunSnapshot | undefined; onDone?: () => void }): React.JSX.Element {
  const { approve, reject, canCommand } = useStore();
  const [busy, setBusy] = useState<'approve' | 'reject' | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const context = run ? approvalContext(run) : undefined;
  const canApprove = canCommand('workflowGates.approve') && (run ? run.canApprove : true);
  const canReject = canCommand('workflowGates.reject');

  const act = (key: 'approve' | 'reject', action: () => Promise<boolean>): void => {
    setBusy(key);
    setError(undefined);
    void action()
      .then(done => { if (done) onDone?.(); })
      .catch(failure => setError(failure instanceof Error ? failure.message : String(failure)))
      .finally(() => setBusy(undefined));
  };

  return (
    <View style={styles.panel}>
      {context ? (
        <>
          <Text style={styles.stage}>{context.stageName}{context.gate ? ` · ${context.gate} gate` : ''}</Text>
          {context.prompt ? <Text style={styles.prompt}>{context.prompt}</Text> : null}
          {context.steps.length > 0 ? (
            <View style={styles.steps} accessibilityLabel={`Steps before this approval: ${context.steps.map(step => `${step.name} ${step.label}`).join(', ')}`}>
              {context.steps.map((step, index) => (
                <View key={index} style={styles.step}>
                  <Text numberOfLines={1} style={styles.stepName}>{step.name}</Text>
                  <Text style={[styles.stepLabel, { color: toneColor(step.tone) }]}>{step.label}</Text>
                  {step.detail ? <Text numberOfLines={2} style={styles.stepDetail}>{step.detail}</Text> : null}
                </View>
              ))}
            </View>
          ) : null}
          {context.findings.length > 0 ? (
            <Text style={styles.findings}>Findings: {context.findings.map(entry => `${entry.count} ${entry.severity}`).join(' · ')}</Text>
          ) : null}
        </>
      ) : (
        <Text style={styles.prompt}>Open the run to see what this approval rests on before you decide.</Text>
      )}

      {rejecting ? (
        <View style={styles.reject}>
          <TextInput
            accessibilityLabel="Why are you rejecting this run?"
            autoFocus
            multiline
            value={reason}
            onChangeText={setReason}
            placeholder="Why? This is recorded on the run."
            placeholderTextColor={theme.textDim}
            maxLength={2000}
            style={styles.input}
          />
          <View style={styles.row}>
            <Pressable accessibilityRole="button" onPress={() => { setRejecting(false); setReason(''); }} style={[styles.button, styles.ghost]}>
              <Text style={styles.ghostText}>Back</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !reason.trim() || busy !== undefined }}
              disabled={!reason.trim() || busy !== undefined}
              onPress={() => act('reject', () => reject(runId, reason))}
              style={[styles.button, styles.danger, (!reason.trim() || busy) && styles.disabled]}
            >
              {busy === 'reject' ? <ActivityIndicator color={theme.danger} /> : <Text style={styles.dangerText}>Reject run</Text>}
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.row}>
          {canReject ? (
            <Pressable accessibilityRole="button" disabled={busy !== undefined} onPress={() => setRejecting(true)} style={[styles.button, styles.danger]}>
              <Text style={styles.dangerText}>Reject…</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityHint="Asks for Face ID or your passcode"
            accessibilityState={{ disabled: !canApprove || busy !== undefined }}
            disabled={!canApprove || busy !== undefined}
            onPress={() => act('approve', () => approve(runId))}
            style={[styles.button, styles.primary, (!canApprove || busy) && styles.disabled]}
          >
            {busy === 'approve' ? <ActivityIndicator color={theme.onAccent} /> : <Text style={styles.primaryText}>Approve</Text>}
          </Pressable>
        </View>
      )}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  panel: { gap: mobileScale(8) },
  stage: { color: theme.text, fontSize: mobileScale(13.5), fontWeight: '700' },
  prompt: { color: theme.textSecondary, fontSize: mobileScale(13), lineHeight: mobileScale(19) },
  steps: { borderWidth: 1, borderColor: theme.border, borderRadius: mobileScale(8) },
  step: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: mobileScale(8), paddingHorizontal: mobileScale(10), paddingVertical: mobileScale(6), borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  stepName: { flex: 1, color: theme.text, fontSize: mobileScale(12.5) },
  stepLabel: { fontSize: mobileScale(12), fontWeight: '700' },
  stepDetail: { width: '100%', color: theme.textDim, fontSize: mobileScale(11.5) },
  findings: { color: theme.warn, fontSize: mobileScale(12.5), fontWeight: '600' },
  row: { flexDirection: 'row', gap: mobileScale(8), justifyContent: 'flex-end' },
  button: { minHeight: mobileScale(44), minWidth: mobileScale(104), paddingHorizontal: mobileScale(14), borderRadius: mobileScale(10), alignItems: 'center', justifyContent: 'center' },
  primary: { backgroundColor: theme.accent },
  primaryText: { color: theme.onAccent, fontSize: mobileScale(14.5), fontWeight: '700' },
  ghost: { borderWidth: 1, borderColor: theme.border },
  ghostText: { color: theme.text, fontSize: mobileScale(14.5), fontWeight: '600' },
  danger: { borderWidth: 1, borderColor: theme.danger },
  dangerText: { color: theme.danger, fontSize: mobileScale(14.5), fontWeight: '700' },
  disabled: { opacity: 0.45 },
  reject: { gap: mobileScale(8) },
  input: { minHeight: mobileScale(72), borderWidth: 1, borderColor: theme.border, borderRadius: mobileScale(8), backgroundColor: theme.input, color: theme.text, padding: mobileScale(10), fontSize: mobileScale(14), textAlignVertical: 'top' },
  error: { color: theme.danger, fontSize: mobileScale(13) },
}));
