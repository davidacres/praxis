import React, { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MobileSessionMode } from '@praxis/core';
import { theme } from '../app/theme';
import type { MobileWorkflowChoice } from '../app/store';
import type { MobileUsageView } from '../renderer/mobileUsage';
import { MODE_DESCRIPTIONS, MODE_LABELS } from '../renderer/mobileSessionOptions';

export interface ComposerModeOption {
  mode: MobileSessionMode;
  available: boolean;
  toolAccess?: string;
  unavailableMessage?: string;
}

interface SessionComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop?: () => void;
  sending?: boolean;
  /** Why sending is impossible right now (e.g. reconnecting); shown instead of sending. */
  blockedReason?: string;
  error?: string;
  /** Provider/model/mode can be changed right now. */
  editable: boolean;
  /** A new chat (choices apply at launch) rather than an existing session (choices apply between turns). */
  draft: boolean;
  /** Why an existing session's provider/model/mode cannot change right now. */
  lockedReason?: string;
  providerLabel: string;
  modelLabel: string;
  mode: MobileSessionMode;
  onOpenProviderPicker?: () => void;
  onOpenModelPicker?: () => void;
  modeOptions: readonly ComposerModeOption[];
  onChangeMode?: (mode: MobileSessionMode) => void;
  usage: MobileUsageView;
  onRefreshUsage?: () => void;
  workflows?: readonly MobileWorkflowChoice[];
  onStartWorkflow?: (workflowId: string) => void;
}

function Glyph({ children, accent = false }: { children: string; accent?: boolean }): React.JSX.Element {
  return <Text style={[styles.glyph, accent && styles.glyphAccent]}>{children}</Text>;
}

function ComposerChip({ icon, label, onPress, editable, hint }: { icon: string; label: string; onPress: () => void; editable: boolean; hint: string }): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: !editable }}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, editable && styles.chipEditable, pressed && styles.buttonPressed]}
    >
      <Glyph>{icon}</Glyph>
      <Text numberOfLines={1} style={[styles.chipLabel, !editable && styles.chipLabelLocked]}>{label}</Text>
      {editable ? <Text style={styles.chipCaret}>▾</Text> : null}
    </Pressable>
  );
}

function SheetRow({ icon, label, value, onPress }: { icon: string; label: string; value?: string; onPress?: () => void }): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [styles.sheetRow, pressed && onPress && styles.sheetRowPressed]}
    >
      <View style={styles.sheetRowIcon}><Text style={styles.sheetRowIconText}>{icon}</Text></View>
      <Text style={styles.sheetRowLabel}>{label}</Text>
      {value ? <Text numberOfLines={2} style={styles.sheetRowValue}>{value}</Text> : null}
      {onPress ? <Text style={styles.sheetChevron}>›</Text> : null}
    </Pressable>
  );
}

function SessionOptionsSheet({
  visible,
  editable,
  draft,
  lockedReason,
  mode,
  modeOptions,
  onChangeMode,
  onClose,
  usageHidden,
  onShowUsage,
  workflows,
  onStartWorkflow,
}: {
  visible: boolean;
  editable: boolean;
  draft: boolean;
  lockedReason?: string;
  mode: MobileSessionMode;
  modeOptions: readonly ComposerModeOption[];
  onChangeMode?: (mode: MobileSessionMode) => void;
  onClose: () => void;
  usageHidden: boolean;
  onShowUsage: () => void;
  workflows: readonly MobileWorkflowChoice[];
  onStartWorkflow?: (workflowId: string) => void;
}): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const current = modeOptions.find(option => option.mode === mode);
  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <View style={styles.sheetOverlay}>
        <Pressable accessibilityLabel="Close session options" accessibilityRole="button" onPress={onClose} style={styles.sheetScrim} />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <View style={styles.sheetHandle} />
          <View style={styles.sheetHeader}>
            <View style={styles.sheetHeaderText}>
              <Text style={styles.sheetTitle}>Session options</Text>
              <Text style={styles.sheetSubtitle}>{draft ? 'Applies to this new chat when you send its first message' : editable ? 'Applies from the next turn of this session' : lockedReason ?? 'Cannot change right now'}</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close session options" onPress={onClose} style={styles.sheetClose}>
              <Text style={styles.sheetCloseText}>×</Text>
            </Pressable>
          </View>

          <Text style={styles.sheetSectionLabel}>SESSION MODE</Text>
          <View accessibilityRole="tablist" style={styles.modeToggle}>
            {modeOptions.map(option => {
              const selected = mode === option.mode;
              const enabled = editable && option.available;
              return (
                <Pressable
                  key={option.mode}
                  accessibilityRole="tab"
                  accessibilityState={{ selected, disabled: !enabled }}
                  accessibilityHint={option.available ? MODE_DESCRIPTIONS[option.mode] : option.unavailableMessage}
                  disabled={!enabled}
                  onPress={() => { if (option.mode !== mode) onChangeMode?.(option.mode); }}
                  style={[styles.modeButton, selected && styles.modeButtonActive]}
                >
                  <Text style={[styles.modeText, selected && styles.modeTextActive, !option.available && styles.modeTextUnavailable]}>{MODE_LABELS[option.mode]}</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.sheetNote}>
            {current && !current.available && current.unavailableMessage ? current.unavailableMessage : MODE_DESCRIPTIONS[mode]}
            {editable || !lockedReason ? '' : ` ${lockedReason}`}
          </Text>
          {modeOptions.filter(option => !option.available && option.mode !== mode).map(option => (
            <Text key={option.mode} style={styles.sheetNote}>{MODE_LABELS[option.mode]}: {option.unavailableMessage ?? 'not available on this desktop.'}</Text>
          ))}

          <Text style={styles.sheetSectionLabel}>CONTEXT</Text>
          <Text style={styles.sheetNote}>
            Tool access and the working folder are set by the desktop project{current?.toolAccess ? ` — ${MODE_LABELS[mode]} runs with ${current.toolAccess === 'read-only' ? 'read-only tools' : current.toolAccess === 'project-only' ? 'project tools only' : 'full tools'}` : ''}. They are not changed from the phone.
          </Text>

          {usageHidden ? (
            <View style={styles.sheetGroup}>
              <SheetRow icon="⌁" label="Show usage" onPress={() => { onShowUsage(); onClose(); }} />
            </View>
          ) : null}

          <Text style={styles.sheetSectionLabel}>WORKFLOWS</Text>
          <View style={styles.sheetGroup}>
            {workflows.map(workflow => (
              <SheetRow
                key={workflow.workflowId}
                icon="▶"
                label={workflow.name}
                value="Start on desktop"
                onPress={onStartWorkflow ? () => {
                  onStartWorkflow(workflow.workflowId);
                  onClose();
                } : undefined}
              />
            ))}
            {workflows.length === 0 ? <SheetRow icon="▶" label="No workflows available for this project" /> : null}
          </View>
        </View>
      </View>
    </Modal>
  );
}

function UsagePanel({ usage, onHide, onRefresh }: { usage: MobileUsageView; onHide: () => void; onRefresh?: () => void }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={styles.usage}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Usage: ${usage.summary}`}
        accessibilityState={{ expanded }}
        accessibilityHint="Shows token and cost details from the desktop"
        onPress={() => {
          setExpanded(value => !value);
          if (!expanded) onRefresh?.();
        }}
        style={styles.usageRow}
      >
        <View style={styles.usageLead}>
          <Glyph accent>⌁</Glyph>
          <Text style={styles.usageLabel}>Usage</Text>
        </View>
        {usage.state === 'loading' ? <ActivityIndicator color={theme.textDim} size="small" /> : null}
        <Text numberOfLines={1} style={styles.usageMeta}>{usage.summary}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Hide usage" hitSlop={10} onPress={onHide} style={styles.closeButton}>
        <Text style={styles.closeText}>×</Text>
      </Pressable>
      {expanded && usage.details.length > 0 ? (
        <View style={styles.usageDetails}>
          {usage.details.map(row => (
            <View key={row.label} style={styles.usageDetailRow}>
              <Text style={styles.usageDetailLabel}>{row.label}</Text>
              <Text numberOfLines={1} style={styles.usageDetailValue}>{row.value}</Text>
            </View>
          ))}
          {!usage.costReported ? <Text style={styles.usageNote}>Cost appears only when the provider reports it; Praxis does not estimate it.</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

export function SessionComposer(props: SessionComposerProps): React.JSX.Element {
  const { value, onChange, onSend, onStop, sending = false, blockedReason, error, editable, draft, lockedReason, mode, workflows = [] } = props;
  const lockedHint = lockedReason ?? 'Provider and model are fixed right now.';
  const [usageVisible, setUsageVisible] = useState(true);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const canSend = value.trim().length > 0 && !sending && !blockedReason;

  return (
    <View style={styles.shell}>
      {usageVisible ? <UsagePanel usage={props.usage} onHide={() => setUsageVisible(false)} onRefresh={props.onRefreshUsage} /> : null}
      {blockedReason ? <Text accessibilityRole="alert" style={styles.blocked}>{blockedReason}</Text> : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {notice && !editable ? (
        <Pressable accessibilityRole="alert" onPress={() => setNotice(undefined)}>
          <Text style={styles.blocked}>{notice}</Text>
        </Pressable>
      ) : null}

      <View style={styles.composer}>
        <TextInput
          accessibilityLabel="Session message"
          multiline
          onChangeText={onChange}
          onSubmitEditing={() => {
            if (canSend) onSend();
          }}
          placeholder={draft ? 'Describe what the agent should do…' : 'Ask the agent to clarify, change, or continue…'}
          placeholderTextColor={theme.textDim}
          returnKeyType="send"
          blurOnSubmit={false}
          style={styles.input}
          value={value}
        />

        <View style={styles.controls}>
          <ComposerChip
            icon="‹›"
            label={props.providerLabel}
            editable={editable}
            onPress={() => { if (editable) props.onOpenProviderPicker?.(); else setNotice(lockedHint); }}
            hint={editable ? (draft ? 'Choose the AI provider for this new chat' : 'Hand this session over to another AI provider') : lockedHint}
          />
          <ComposerChip
            icon="✦"
            label={props.modelLabel}
            editable={editable}
            onPress={() => { if (editable) props.onOpenModelPicker?.(); else setNotice(lockedHint); }}
            hint={editable ? (draft ? 'Choose the model for this new chat' : 'Change the model for the next turn') : lockedHint}
          />
          <View style={styles.spacer} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Session options, ${MODE_LABELS[mode]} mode`}
            accessibilityState={{ expanded: optionsOpen }}
            onPress={() => setOptionsOpen(true)}
            style={({ pressed }) => [styles.moreButton, pressed && styles.buttonPressed]}
          >
            <Text style={styles.modeBadge}>{MODE_LABELS[mode]}</Text>
            <Text style={styles.moreGlyph}>•••</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={sending ? 'Stop response' : 'Send message'}
            accessibilityState={{ disabled: sending ? !onStop : !canSend }}
            disabled={sending ? !onStop : !canSend}
            onPress={sending ? onStop : onSend}
            style={({ pressed }) => [styles.sendButton, (!sending && !canSend) && styles.sendButtonDisabled, pressed && styles.buttonPressed]}
          >
            <Text style={[styles.sendGlyph, (canSend || sending) && styles.sendGlyphActive]}>{sending ? '■' : '↑'}</Text>
          </Pressable>
        </View>
      </View>

      <SessionOptionsSheet
        visible={optionsOpen}
        editable={editable}
        draft={draft}
        lockedReason={lockedReason}
        mode={mode}
        modeOptions={props.modeOptions}
        onChangeMode={props.onChangeMode}
        onClose={() => setOptionsOpen(false)}
        usageHidden={!usageVisible}
        onShowUsage={() => setUsageVisible(true)}
        workflows={workflows}
        onStartWorkflow={props.onStartWorkflow}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    gap: 7,
    paddingHorizontal: 10,
    paddingTop: 7,
    paddingBottom: 9,
    backgroundColor: theme.chrome,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
  },
  usage: {
    minHeight: 42,
    paddingLeft: 11,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 8,
    backgroundColor: theme.surface,
  },
  usageRow: { flex: 1, minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 8 },
  usageLead: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  usageLabel: { color: theme.textSecondary, fontSize: 13 },
  usageMeta: { flex: 1, minWidth: 0, color: theme.textDim, fontSize: 11 },
  usageDetails: { width: '100%', paddingRight: 11, paddingBottom: 9, gap: 4 },
  usageDetailRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  usageDetailLabel: { color: theme.textDim, fontSize: 11 },
  usageDetailValue: { flexShrink: 1, color: theme.textSecondary, fontSize: 11, fontVariant: ['tabular-nums'] },
  usageNote: { marginTop: 3, color: theme.textDim, fontSize: 10, lineHeight: 14 },
  closeButton: { width: 32, height: 40, alignItems: 'center', justifyContent: 'center' },
  closeText: { color: theme.textDim, fontSize: 17, fontWeight: '300' },
  blocked: { paddingHorizontal: 4, color: theme.warn, fontSize: 11, lineHeight: 15 },
  error: { paddingHorizontal: 4, color: theme.danger, fontSize: 11, lineHeight: 15 },
  composer: { overflow: 'hidden', borderWidth: 1, borderColor: theme.borderStrong, borderRadius: 11, backgroundColor: theme.input },
  input: {
    minHeight: 58,
    maxHeight: 124,
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 7,
    color: theme.text,
    fontSize: 13,
    lineHeight: 18,
    textAlignVertical: 'top',
  },
  controls: { minHeight: 42, paddingHorizontal: 5, paddingBottom: 5, flexDirection: 'row', alignItems: 'center', gap: 1 },
  spacer: { flex: 1 },
  chip: { height: 29, maxWidth: 124, paddingHorizontal: 6, flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 6 },
  chipEditable: { borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border },
  chipLabel: { flexShrink: 1, color: theme.textSecondary, fontSize: 11 },
  chipLabelLocked: { color: theme.textDim },
  chipCaret: { color: theme.textDim, fontSize: 9 },
  glyph: { color: theme.textSecondary, fontSize: 13, fontWeight: '500' },
  glyphAccent: { color: theme.accent },
  moreButton: { height: 31, paddingHorizontal: 6, flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 6 },
  modeBadge: { color: theme.textDim, fontSize: 10, fontWeight: '700' },
  moreGlyph: { marginTop: -5, color: theme.textSecondary, fontSize: 15, fontWeight: '700', letterSpacing: 1 },
  sendButton: { width: 31, height: 31, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 6 },
  sendButtonDisabled: { opacity: 0.48 },
  sendGlyph: { color: theme.textDim, fontSize: 20, fontWeight: '500', lineHeight: 22 },
  sendGlyphActive: { color: theme.text },
  buttonPressed: { backgroundColor: theme.surfaceRaised },
  sheetOverlay: { flex: 1, justifyContent: 'flex-end' },
  sheetScrim: { position: 'absolute', inset: 0, backgroundColor: theme.scrim },
  sheet: { paddingHorizontal: 14, paddingTop: 8, borderTopLeftRadius: 18, borderTopRightRadius: 18, borderWidth: 1, borderBottomWidth: 0, borderColor: theme.borderStrong, backgroundColor: theme.bgSunken },
  sheetHandle: { width: 42, height: 4, alignSelf: 'center', marginBottom: 12, borderRadius: 2, backgroundColor: theme.borderStrong },
  sheetHeader: { marginBottom: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  sheetHeaderText: { flex: 1 },
  sheetTitle: { color: theme.text, fontSize: 17, fontWeight: '700' },
  sheetSubtitle: { marginTop: 3, color: theme.textDim, fontSize: 10 },
  sheetClose: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 7, backgroundColor: theme.surface },
  sheetCloseText: { color: theme.textDim, fontSize: 21, fontWeight: '300' },
  sheetSectionLabel: { marginTop: 12, marginBottom: 6, color: theme.textDim, fontSize: 10, fontWeight: '700', letterSpacing: 0.8 },
  sheetNote: { marginTop: 6, color: theme.textDim, fontSize: 11, lineHeight: 16 },
  modeToggle: { flexDirection: 'row', padding: 3, gap: 2, borderWidth: 1, borderColor: theme.border, borderRadius: 8, backgroundColor: theme.surface },
  modeButton: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 6 },
  modeButtonActive: { backgroundColor: theme.surfaceRaised },
  modeText: { color: theme.textDim, fontSize: 12, fontWeight: '600' },
  modeTextActive: { color: theme.text },
  modeTextUnavailable: { opacity: 0.45 },
  sheetGroup: { marginTop: 6, overflow: 'hidden', borderWidth: 1, borderColor: theme.border, borderRadius: 9, backgroundColor: theme.surface },
  sheetRow: { minHeight: 48, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  sheetRowPressed: { backgroundColor: theme.surfaceRaised },
  sheetRowIcon: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 7, backgroundColor: theme.bgSunken },
  sheetRowIconText: { color: theme.textSecondary, fontSize: 12, fontWeight: '700' },
  sheetRowLabel: { flex: 1, color: theme.textSecondary, fontSize: 13, fontWeight: '600' },
  sheetRowValue: { maxWidth: '44%', color: theme.textDim, fontSize: 12, textAlign: 'right' },
  sheetChevron: { color: theme.textDim, fontSize: 18 },
});
