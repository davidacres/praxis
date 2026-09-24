import React, { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MobileRunSnapshot } from '@praxis/core';
import { mobileScale, theme, themedStyles } from '../app/theme';
import { useStore } from '../app/store';
import { providerOption } from '../renderer/mobileSessionOptions';
import { runStatus, stageStatus } from '../renderer/mobileWorkflowRuns';
import { StatusPill, toneColor } from './runVisuals';
import { ApprovalPanel } from '../app/ApprovalPanel';

interface WorkflowStepsSheetProps {
  visible: boolean;
  run: MobileRunSnapshot;
  /** The step the run view is showing. */
  viewedNodeId: string | undefined;
  onSelectStage: (nodeId: string) => void;
  onClose: () => void;
}

/** A run's steps and how each stands, from the stage bar; picking one shows its conversation. */
export function WorkflowStepsSheet({ visible, run, viewedNodeId, onSelectStage, onClose }: WorkflowStepsSheetProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const { providers, hostInfo, shell, retryStage } = useStore();
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const status = runStatus(run);
  const canCommand = (operation: 'workflowGates.approve' | 'workflowRuns.retryStage'): boolean =>
    shell.connection === 'ready' && Boolean(hostInfo?.commandOperations.includes(operation));

  const act = (key: string, action: () => Promise<void>): void => {
    setBusy(key);
    setError(undefined);
    void action()
      .catch(failure => setError(failure instanceof Error ? failure.message : String(failure)))
      .finally(() => setBusy(undefined));
  };

  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <View style={styles.overlay}>
        <Pressable accessibilityLabel="Close workflow steps" accessibilityRole="button" onPress={onClose} style={styles.scrim} />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]} accessibilityViewIsModal>
          <View style={styles.handle} />
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text numberOfLines={2} style={styles.title}>{run.workflowName}</Text>
              <View style={styles.headerMeta}>
                <StatusPill label={status.label} tone={status.tone} trailing={false} />
                {run.issueKey ? <Text style={styles.metaText}>{run.issueKey}</Text> : null}
              </View>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close workflow steps" onPress={onClose} style={styles.headerButton}>
              <Text style={styles.headerButtonText}>×</Text>
            </Pressable>
          </View>
          <Text style={styles.explanation}>{run.explanation}</Text>
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          {run.canApprove && canCommand('workflowGates.approve') ? (
            <View style={styles.approval}>
              <ApprovalPanel runId={run.runId} run={run} />
            </View>
          ) : null}

          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {run.stages.map((stage, index) => {
              const stageState = stageStatus(stage);
              const viewed = stage.nodeId === viewedNodeId;
              // A finished run has no "now"; a failed or waiting one points at where it stopped.
              const current = stage.nodeId === run.currentNodeId && run.status !== 'succeeded' && run.status !== 'cancelled';
              const provider = stage.type === 'agent-task' && stage.provider ? providerOption(providers.value, stage.provider)?.label ?? stage.provider : undefined;
              const caption = [stageState.label, provider, stage.attempts > 1 ? `${stage.attempts} attempts` : undefined].filter(Boolean).join(' · ');
              const retryable = (stage.lane === 'failed' || stage.lane === 'paused') && canCommand('workflowRuns.retryStage');
              return (
                <View key={stage.nodeId} style={[styles.row, viewed && styles.rowViewed]}>
                  <View style={styles.rail} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                    <View style={[styles.dot, { borderColor: toneColor(stageState.tone) }, stage.lane === 'done' && { backgroundColor: theme.ok }]}>
                      <Text style={[styles.dotText, { color: stage.lane === 'done' ? theme.onAccent : toneColor(stageState.tone) }]}>{stageState.icon}</Text>
                    </View>
                    {index < run.stages.length - 1 ? <View style={styles.line} /> : null}
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: viewed }}
                    accessibilityLabel={`Step ${index + 1}: ${stage.name}, ${caption}${current ? ', current step' : ''}`}
                    accessibilityHint="Shows this step's conversation"
                    onPress={() => onSelectStage(stage.nodeId)}
                    style={({ pressed }) => [styles.rowMain, pressed && styles.pressed]}
                  >
                    <View style={styles.rowTitleLine}>
                      <Text numberOfLines={1} style={[styles.rowTitle, stage.lane === 'idle' && styles.rowTitleIdle]}>{stage.name}</Text>
                      {current ? <Text style={styles.nowTag}>NOW</Text> : null}
                    </View>
                    <Text numberOfLines={1} style={[styles.rowCaption, { color: stageState.tone === 'neutral' ? theme.textDim : toneColor(stageState.tone) }]}>{caption}</Text>
                    {stage.metrics && Object.keys(stage.metrics).length > 0 ? (
                      <View style={styles.metricsRow}>
                        {Object.entries(stage.metrics).slice(0, 3).map(([k, v]) => (
                          <Text key={k} style={styles.metricChip}>{k}: {String(v)}</Text>
                        ))}
                      </View>
                    ) : null}
                    {stage.lastError && (stage.lane === 'failed' || stage.lane === 'paused') ? <Text numberOfLines={3} style={styles.rowError}>{stage.lastError}</Text> : null}
                  </Pressable>
                  {retryable ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Retry ${stage.name}`}
                      disabled={busy !== undefined}
                      onPress={() => act(`retry:${stage.nodeId}`, () => retryStage(run.runId, stage.nodeId))}
                      style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
                    >
                      {busy === `retry:${stage.nodeId}` ? <ActivityIndicator size="small" color={theme.accent} /> : <Text style={styles.retryText}>Retry</Text>}
                    </Pressable>
                  ) : null}
                </View>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  scrim: { position: 'absolute', inset: 0, backgroundColor: theme.scrim },
  sheet: { maxHeight: '82%', paddingHorizontal: 14, paddingTop: 8, borderTopLeftRadius: 18, borderTopRightRadius: 18, borderWidth: 1, borderBottomWidth: 0, borderColor: theme.borderStrong, backgroundColor: theme.bgSunken },
  handle: { width: 42, height: 4, alignSelf: 'center', marginBottom: 12, borderRadius: 2, backgroundColor: theme.borderStrong },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  headerText: { flex: 1, minWidth: 0, gap: mobileScale(6) },
  headerMeta: { flexDirection: 'row', alignItems: 'center', gap: mobileScale(8) },
  metaText: { color: theme.textDim, fontSize: mobileScale(11) },
  title: { color: theme.text, fontSize: mobileScale(16), fontWeight: '700' },
  headerButton: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 7, backgroundColor: theme.surface },
  headerButtonText: { color: theme.textDim, fontSize: 19, fontWeight: '300' },
  explanation: { marginTop: mobileScale(10), marginBottom: mobileScale(8), color: theme.textSecondary, fontSize: mobileScale(12), lineHeight: mobileScale(17) },
  error: { marginBottom: mobileScale(8), color: theme.danger, fontSize: mobileScale(12), lineHeight: mobileScale(17) },
  approval: { marginBottom: mobileScale(8) },
  list: { flexGrow: 0 },
  listContent: { paddingBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'stretch', gap: mobileScale(8), borderRadius: mobileScale(9) },
  rowViewed: { backgroundColor: theme.accentSoft },
  rail: { width: mobileScale(30), alignItems: 'center', paddingTop: mobileScale(10) },
  dot: { width: mobileScale(22), height: mobileScale(22), alignItems: 'center', justifyContent: 'center', borderRadius: 999, borderWidth: 1.5, backgroundColor: theme.bgSunken },
  dotText: { fontSize: mobileScale(10), fontWeight: '800' },
  line: { flex: 1, width: 1.5, marginTop: 2, backgroundColor: theme.border },
  rowMain: { flex: 1, minWidth: 0, minHeight: mobileScale(52), paddingVertical: mobileScale(9), paddingRight: mobileScale(6), justifyContent: 'center', borderRadius: mobileScale(8) },
  pressed: { backgroundColor: theme.surfaceRaised },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: mobileScale(6) },
  rowTitle: { flexShrink: 1, color: theme.text, fontSize: mobileScale(13), fontWeight: '600' },
  rowTitleIdle: { color: theme.textSecondary },
  nowTag: { paddingHorizontal: 5, paddingVertical: 1, overflow: 'hidden', borderRadius: 4, backgroundColor: theme.accent, color: theme.onAccent, fontSize: mobileScale(9), fontWeight: '800', letterSpacing: 0.6 },
  rowCaption: { marginTop: mobileScale(3), fontSize: mobileScale(11) },
  rowError: { marginTop: mobileScale(4), color: theme.textDim, fontSize: mobileScale(10), lineHeight: mobileScale(14) },
  metricsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: mobileScale(4), marginTop: mobileScale(3) },
  metricChip: {
    color: theme.textDim,
    fontSize: mobileScale(9),
    backgroundColor: theme.surfaceRaised,
    paddingHorizontal: mobileScale(4),
    paddingVertical: mobileScale(1),
    borderRadius: mobileScale(3),
    fontVariant: ['tabular-nums'],
  },
  retry: { alignSelf: 'center', minHeight: mobileScale(32), paddingHorizontal: mobileScale(12), justifyContent: 'center', borderWidth: 1, borderColor: theme.accentMuted, borderRadius: mobileScale(8), backgroundColor: theme.surface },
  retryText: { color: theme.accent, fontSize: mobileScale(12), fontWeight: '700' },
}));
