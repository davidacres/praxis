import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { mobileScale, theme, themedStyles } from '../app/theme';
import { useStore } from '../app/store';
import { providerOption } from '../renderer/mobileSessionOptions';
import {
  currentStage,
  runStatus,
  stageStatus,
  stageWithoutSession,
  stepPosition,
  viewedStage,
} from '../renderer/mobileWorkflowRuns';
import { MotifBackdrop, SessionHeader } from './WorkScreen';
import { ChatMessage, Transcript } from '../app/Transcript';
import { ApprovalPanel } from '../app/ApprovalPanel';
import { recordDiagnostic } from '../app/diagnostics';
import { WorkflowStepsSheet } from './WorkflowStepsSheet';
import { StatusPill, toneBackground, toneColor } from './runVisuals';

/**
 * A workflow run on the phone, the way the desktop's run workspace shows it: the
 * conversation of the stage doing the work, the AI running it above, and — where a chat
 * has its composer — the stage bar, which opens the run's steps. The view follows the run
 * from stage to stage unless a step is picked in the sheet.
 */
export function RunDetail({ runId, onOpenSidebar }: { runId: string; onOpenSidebar: () => void }): React.JSX.Element | null {
  const { workflowRuns, transcriptFor, sessionFor, loadSession, providers, work, usageFor, shell, canCommand, answerGadget } = useStore();
  const run = workflowRuns.find(candidate => candidate.runId === runId);
  const [pinned, setPinned] = useState<string | undefined>(undefined);
  const [sheetOpen, setSheetOpen] = useState(false);

  // A different run starts back on "follow live".
  useEffect(() => setPinned(undefined), [runId]);

  const stage = run ? viewedStage(run, pinned) : undefined;
  const live = run ? currentStage(run) : undefined;
  const following = !pinned || pinned === live?.nodeId;
  const session = stage?.sessionId ? sessionFor(stage.sessionId) : undefined;
  const messages = stage?.sessionId ? transcriptFor(stage.sessionId) : [];

  // A stage session the phone has not seen yet (it started while the list was loading).
  useEffect(() => {
    if (stage?.sessionId && !session && shell.connection === 'ready') void loadSession(stage.sessionId).catch(error => recordDiagnostic('Loading a stage conversation', error));
  }, [stage?.sessionId, session, shell.connection, loadSession]);

  if (!run || !stage) return null;

  const status = stageStatus(stage);
  const providerId = stage.provider ?? session?.provider ?? run.aiProvider;
  const providerLabel = providerId ? providerOption(providers.value, providerId)?.label ?? providerId : undefined;
  const model = session?.model ?? (providerId && providerId === run.aiProvider ? run.aiModel : undefined);
  const workItem = stage.sessionId ? work.find(item => item.sessionId === stage.sessionId) : undefined;
  const usage = workItem ? usageFor(workItem) : undefined;
  const aiStage = stage.type === 'agent-task';

  return (
    <View style={styles.shell}>
      <MotifBackdrop />
      <SessionHeader title={run.workflowName} onOpenSidebar={onOpenSidebar} />

      {/* The chat's details: which AI is doing this stage, and how it stands. */}
      <View style={styles.details} accessibilityRole="summary" accessibilityLabel={`${stage.name}, ${status.label}${providerLabel ? `, on ${providerLabel}` : ''}${model ? `, ${model}` : ''}`}>
        <View style={styles.detailsRow}>
          <Text numberOfLines={1} style={styles.detailsAi}>
            {aiStage ? providerLabel ?? 'Run’s AI' : stage.type === 'check' ? 'Desktop check' : stage.type === 'approval' ? 'Approval' : stage.type === 'merge' ? 'Merge' : 'Desktop'}
          </Text>
          {aiStage ? <Text numberOfLines={1} style={styles.detailsModel}>{model ?? 'default model'}</Text> : null}
          <StatusPill label={status.label} tone={status.tone} />
        </View>
        {usage?.state === 'ready' || stage.attempts > 1 ? (
          <Text numberOfLines={1} style={styles.detailsMeta}>
            {[stage.attempts > 1 ? `Attempt ${stage.attempts}` : undefined, usage?.state === 'ready' ? usageWithoutModel(usage.summary, model) : undefined].filter(Boolean).join(' · ')}
          </Text>
        ) : null}
      </View>

      {stage.sessionId && messages.length > 0 ? (
        <Transcript
          data={messages}
          keyOf={message => message.id}
          resetKey={`${runId}:${stage.nodeId}`}
          renderItem={message => (
            <ChatMessage
              message={message}
              connected={shell.connection === 'ready'}
              onAnswer={(gadget, action, value) => answerGadget(stage.sessionId!, gadget, action, value)}
            />
          )}
        />
      ) : (
      <ScrollView contentContainerStyle={styles.summaryContainer}>
        {(
          <View style={styles.summaryStack}>
            {/* Step Card */}
            <View style={styles.summaryCard}>
              <View style={styles.summaryHeader}>
                <Text style={styles.summaryTitle}>{stage.name}</Text>
                <StatusPill label={status.label} tone={status.tone} />
              </View>
              <Text style={styles.summaryType}>{stage.type.toUpperCase()}{stage.gate ? ` · ${stage.gate} gate` : ''}</Text>
              {stage.attempts > 1 ? <Text style={styles.summaryMeta}>Attempt {stage.attempts}</Text> : null}
              {stage.sessionId && stage.lane === 'running' ? (
                <View style={styles.startingRow}>
                  <ActivityIndicator color={theme.textDim} size="small" />
                  <Text style={styles.placeholderText}>Starting conversation…</Text>
                </View>
              ) : null}
            </View>

            {/* Command & Exit Code */}
            {stage.command ? (
              <View style={styles.summaryCard}>
                <View style={styles.summaryRowBetween}>
                  <Text style={styles.summaryCardHeading}>Command</Text>
                  {stage.exitCode !== undefined ? (
                    <Text style={[styles.codeBadge, stage.exitCode === 0 ? styles.codeSuccess : styles.codeDanger]}>
                      exit {stage.exitCode}
                    </Text>
                  ) : null}
                </View>
                <Text style={styles.commandCode}>$ {stage.command}</Text>
              </View>
            ) : null}

            {/* Metrics */}
            {stage.metrics && Object.keys(stage.metrics).length > 0 ? (
              <View style={styles.summaryCard}>
                <Text style={styles.summaryCardHeading}>Test Results &amp; Findings Metrics</Text>
                <View style={styles.metricsGrid}>
                  {Object.entries(stage.metrics).map(([k, v]) => (
                    <View key={k} style={styles.metricItem}>
                      <Text style={styles.metricLabel}>{k}</Text>
                      <Text style={styles.metricValue}>{String(v)}</Text>
                    </View>
                  ))}
                </View>
              </View>
            ) : null}

            {/* Error Message */}
            {stage.lastError ? (
              <View style={[styles.summaryCard, styles.errorCard]}>
                <Text style={styles.errorTitle}>Error</Text>
                <Text style={styles.placeholderError}>{stage.lastError}</Text>
              </View>
            ) : null}

            {/* Approval / Merge Action Card */}
            {(stage.type === 'approval' || stage.type === 'merge') ? (
              <View style={styles.summaryCard}>
                {run.canApprove && stage.lane === 'awaiting' && canCommand('workflowGates.approve') ? (
                  // The panel shows the prompt with the steps and findings the decision rests on.
                  <ApprovalPanel runId={run.runId} run={run} />
                ) : (
                  <Text style={styles.summaryPrompt}>
                    {stage.prompt || (stage.type === 'merge' ? 'Merge the changes into the base branch?' : 'Sign off on delivery?')}
                  </Text>
                )}
              </View>
            ) : null}

            {/* Description placeholder if nothing else */}
            {!stage.command && !stage.metrics && !stage.lastError && stage.type !== 'approval' && stage.type !== 'merge' && (
              <Text style={styles.placeholderText}>{stageWithoutSession(stage)}</Text>
            )}
          </View>
        )}
      </ScrollView>
      )}

      {/* In place of a chat's composer: where the run is. Opens the steps. */}
      <View style={styles.barShell}>
        {!following ? (
          <Pressable accessibilityRole="button" onPress={() => setPinned(undefined)} style={({ pressed }) => [styles.follow, pressed && styles.pressed]}>
            <Text style={styles.followText}>Viewing an earlier step · Follow live{live ? ` (${live.name})` : ''}</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${stepPosition(run, stage.nodeId)}: ${stage.name}, ${status.label}. Show the workflow steps.`}
          onPress={() => setSheetOpen(true)}
          style={({ pressed }) => [styles.bar, pressed && styles.pressed]}
        >
          <View style={[styles.barIcon, toneBackground(status.tone)]}>
            {stage.lane === 'running' ? <ActivityIndicator size="small" color={theme.onAccent} /> : <Text style={styles.barIconText}>{status.icon}</Text>}
          </View>
          <View style={styles.barText}>
            <Text numberOfLines={1} style={styles.barTitle}>{stage.name}</Text>
            <Text numberOfLines={1} style={styles.barCaption}>{stepPosition(run, stage.nodeId)} · Run {runStatus(run).label.toLowerCase()}</Text>
          </View>
          <Progress run={run} />
          <Text style={styles.barChevron}>⌃</Text>
        </Pressable>
      </View>

      <WorkflowStepsSheet
        visible={sheetOpen}
        run={run}
        viewedNodeId={stage.nodeId}
        onSelectStage={nodeId => {
          setPinned(nodeId === live?.nodeId ? undefined : nodeId);
          setSheetOpen(false);
        }}
        onClose={() => setSheetOpen(false)}
      />
    </View>
  );
}

/** The usage line already names the model; the strip shows it once, beside the AI. */
function usageWithoutModel(summary: string, model: string | undefined): string {
  return model && summary.startsWith(`${model} · `) ? summary.slice(model.length + 3) : summary;
}

/** Done steps out of all of them, as a thin bar. */
function Progress({ run }: { run: { stages: ReadonlyArray<{ lane: string }> } }): React.JSX.Element {
  const done = run.stages.filter(stage => stage.lane === 'done' || stage.lane === 'skipped').length;
  const total = Math.max(run.stages.length, 1);
  return (
    <View style={styles.progress} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Text style={styles.progressText}>{done}/{run.stages.length}</Text>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${Math.round((done / total) * 100)}%` }]} />
      </View>
    </View>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  shell: { flex: 1, backgroundColor: theme.bg },
  details: {
    paddingHorizontal: mobileScale(12),
    paddingVertical: mobileScale(7),
    gap: mobileScale(3),
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
    backgroundColor: theme.chrome,
  },
  detailsRow: { flexDirection: 'row', alignItems: 'center', gap: mobileScale(8) },
  detailsAi: { flexShrink: 1, color: theme.text, fontSize: mobileScale(12), fontWeight: '700' },
  detailsModel: { flex: 1, minWidth: 0, color: theme.textDim, fontSize: mobileScale(11) },
  detailsMeta: { color: theme.textDim, fontSize: mobileScale(10), fontVariant: ['tabular-nums'] },
  transcript: { flexGrow: 1, justifyContent: 'flex-end', paddingHorizontal: mobileScale(12), paddingTop: mobileScale(14), paddingBottom: mobileScale(8) },
  summaryContainer: { flexGrow: 1, paddingHorizontal: mobileScale(12), paddingTop: mobileScale(14), paddingBottom: mobileScale(16) },
  summaryStack: { gap: mobileScale(10) },
  summaryCard: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: mobileScale(10),
    padding: mobileScale(14),
    gap: mobileScale(8),
  },
  summaryHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: mobileScale(8) },
  summaryTitle: { flex: 1, color: theme.text, fontSize: mobileScale(15), fontWeight: '700' },
  summaryType: { color: theme.textDim, fontSize: mobileScale(11), fontWeight: '600', letterSpacing: 0.5 },
  summaryMeta: { color: theme.textDim, fontSize: mobileScale(11) },
  startingRow: { flexDirection: 'row', alignItems: 'center', gap: mobileScale(8), marginTop: mobileScale(4) },
  summaryRowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  summaryCardHeading: { color: theme.text, fontSize: mobileScale(12), fontWeight: '700' },
  commandCode: { color: theme.text, fontFamily: 'monospace', fontSize: mobileScale(11), backgroundColor: theme.surfaceRaised, padding: mobileScale(8), borderRadius: mobileScale(6) },
  codeBadge: { fontSize: mobileScale(10), fontWeight: '700', paddingHorizontal: mobileScale(6), paddingVertical: mobileScale(2), borderRadius: mobileScale(4), overflow: 'hidden' },
  codeSuccess: { color: theme.ok, backgroundColor: theme.surfaceRaised },
  codeDanger: { color: theme.danger, backgroundColor: theme.surfaceRaised },
  metricsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: mobileScale(8) },
  metricItem: { backgroundColor: theme.surfaceRaised, paddingHorizontal: mobileScale(8), paddingVertical: mobileScale(6), borderRadius: mobileScale(6), gap: mobileScale(2) },
  metricLabel: { color: theme.textDim, fontSize: mobileScale(9), textTransform: 'uppercase' },
  metricValue: { color: theme.text, fontSize: mobileScale(13), fontWeight: '700' },
  errorCard: { borderColor: theme.danger },
  errorTitle: { color: theme.danger, fontSize: mobileScale(12), fontWeight: '700' },
  summaryPrompt: { color: theme.text, fontSize: mobileScale(13), lineHeight: mobileScale(18) },
  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: mobileScale(10), paddingHorizontal: mobileScale(24), paddingVertical: mobileScale(40) },
  placeholderText: { color: theme.textDim, fontSize: mobileScale(13), lineHeight: mobileScale(19), textAlign: 'center' },
  placeholderError: { color: theme.warn, fontSize: mobileScale(11), lineHeight: mobileScale(16), textAlign: 'center' },
  barShell: {
    gap: mobileScale(6),
    paddingHorizontal: mobileScale(10),
    paddingTop: mobileScale(7),
    paddingBottom: mobileScale(9),
    backgroundColor: theme.chrome,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
  },
  follow: { alignSelf: 'center', paddingHorizontal: mobileScale(12), paddingVertical: mobileScale(5), borderRadius: 999, borderWidth: 1, borderColor: theme.accentMuted, backgroundColor: theme.accentSoft },
  followText: { color: theme.accent, fontSize: mobileScale(11), fontWeight: '700' },
  bar: {
    minHeight: mobileScale(52),
    paddingHorizontal: mobileScale(10),
    flexDirection: 'row',
    alignItems: 'center',
    gap: mobileScale(10),
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: mobileScale(10),
    backgroundColor: theme.surface,
  },
  pressed: { backgroundColor: theme.surfaceRaised },
  barIcon: { width: mobileScale(30), height: mobileScale(30), alignItems: 'center', justifyContent: 'center', borderRadius: 999 },
  barIconText: { color: theme.onAccent, fontSize: mobileScale(13), fontWeight: '800' },
  barText: { flex: 1, minWidth: 0 },
  barTitle: { color: theme.text, fontSize: mobileScale(14), fontWeight: '700' },
  barCaption: { marginTop: mobileScale(2), color: theme.textDim, fontSize: mobileScale(11) },
  barChevron: { color: theme.textDim, fontSize: mobileScale(15), fontWeight: '700' },
  progress: { width: mobileScale(52), gap: mobileScale(3), alignItems: 'flex-end' },
  progressText: { color: theme.textDim, fontSize: mobileScale(10), fontVariant: ['tabular-nums'] },
  progressTrack: { width: '100%', height: mobileScale(4), overflow: 'hidden', borderRadius: 2, backgroundColor: theme.border },
  progressFill: { height: '100%', borderRadius: 2, backgroundColor: theme.accent },
}));
