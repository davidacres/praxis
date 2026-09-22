import React, { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { theme } from '../app/theme';
import type { MobileWorkflowChoice } from '../app/store';

type SessionMode = 'chat' | 'analysis' | 'review';

interface SessionComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop?: () => void;
  sending?: boolean;
  provider?: string;
  model?: string;
  workflows?: readonly MobileWorkflowChoice[];
  onStartWorkflow?: (workflowId: string) => void;
}

const MODES: SessionMode[] = ['chat', 'analysis', 'review'];

function Glyph({ children, accent = false }: { children: string; accent?: boolean }): React.JSX.Element {
  return <Text style={[styles.glyph, accent && styles.glyphAccent]}>{children}</Text>;
}

function ComposerChip({ icon, label, meta }: { icon: string; label: string; meta?: string }): React.JSX.Element {
  return (
    <View accessible accessibilityLabel={`${label}${meta ? `, ${meta}` : ''}`} style={styles.chip}>
      <Glyph>{icon}</Glyph>
      <Text numberOfLines={1} style={styles.chipLabel}>{label}</Text>
      {meta ? <Text style={styles.chipMeta}>{meta}</Text> : null}
    </View>
  );
}

function SheetRow({ icon, label, value, onPress }: { icon: string; label: string; value?: string; onPress?: () => void }): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      onPress={onPress}
      style={({ pressed }) => [styles.sheetRow, pressed && onPress && styles.sheetRowPressed]}
    >
      <View style={styles.sheetRowIcon}><Text style={styles.sheetRowIconText}>{icon}</Text></View>
      <Text style={styles.sheetRowLabel}>{label}</Text>
      {value ? <Text numberOfLines={1} style={styles.sheetRowValue}>{value}</Text> : null}
      {onPress ? <Text style={styles.sheetChevron}>›</Text> : null}
    </Pressable>
  );
}

function SessionOptionsSheet({
  visible,
  mode,
  onChangeMode,
  onClose,
  workflows,
  onStartWorkflow,
}: {
  visible: boolean;
  mode: SessionMode;
  onChangeMode: (mode: SessionMode) => void;
  onClose: () => void;
  workflows: readonly MobileWorkflowChoice[];
  onStartWorkflow?: (workflowId: string) => void;
}): React.JSX.Element {
  const insets = useSafeAreaInsets();
  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <View style={styles.sheetOverlay}>
        <Pressable accessibilityLabel="Close session options" accessibilityRole="button" onPress={onClose} style={styles.sheetScrim} />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <View style={styles.sheetHandle} />
          <View style={styles.sheetHeader}>
            <View>
              <Text style={styles.sheetTitle}>Session options</Text>
              <Text style={styles.sheetSubtitle}>Controls used less often while chatting</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close session options" onPress={onClose} style={styles.sheetClose}>
              <Text style={styles.sheetCloseText}>×</Text>
            </Pressable>
          </View>

          <Text style={styles.sheetSectionLabel}>SESSION MODE</Text>
          <View accessibilityRole="tablist" style={styles.modeToggle}>
            {MODES.map(option => {
              const selected = mode === option;
              return (
                <Pressable
                  key={option}
                  accessibilityRole="tab"
                  accessibilityState={{ selected }}
                  onPress={() => onChangeMode(option)}
                  style={[styles.modeButton, selected && styles.modeButtonActive]}
                >
                  <Text style={[styles.modeText, selected && styles.modeTextActive]}>{option[0]!.toUpperCase() + option.slice(1)}</Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.sheetSectionLabel}>CONTEXT</Text>
          <View style={styles.sheetGroup}>
            <SheetRow icon="⌁" label="Tool access" value="Full tools" />
            <SheetRow icon="▱" label="Working folder" value="praxis-desktop" />
          </View>

          <Text style={styles.sheetSectionLabel}>ACTIONS</Text>
          <View style={styles.sheetGroup}>
            {workflows.map(workflow => (
              <SheetRow
                key={workflow.workflowId}
                icon="▶"
                label={workflow.name}
                onPress={() => {
                  onStartWorkflow?.(workflow.workflowId);
                  onClose();
                }}
              />
            ))}
            {workflows.length === 0 ? <SheetRow icon="▶" label="No workflows available" /> : null}
          </View>
        </View>
      </View>
    </Modal>
  );
}

export function SessionComposer({ value, onChange, onSend, onStop, sending = false, provider = 'Provider', model = 'Default model', workflows = [], onStartWorkflow }: SessionComposerProps): React.JSX.Element {
  const [mode, setMode] = useState<SessionMode>('chat');
  const [usageVisible, setUsageVisible] = useState(true);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const canSend = value.trim().length > 0 && !sending;

  return (
    <View style={styles.shell}>
      {usageVisible ? (
        <View style={styles.usage}>
          <View style={styles.usageLead}>
            <Glyph accent>⌁</Glyph>
            <Text style={styles.usageLabel}>Usage</Text>
          </View>
          <Text numberOfLines={1} style={styles.usageMeta}>gpt-5.6-luna · 4.6m tokens · US$2.81</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Hide usage" hitSlop={10} onPress={() => setUsageVisible(false)} style={styles.closeButton}>
            <Text style={styles.closeText}>×</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.composer}>
        <TextInput
          accessibilityLabel="Session message"
          multiline
          onChangeText={onChange}
          onSubmitEditing={() => {
            if (canSend) onSend();
          }}
          placeholder="Ask the agent to clarify, change, or continue…"
          placeholderTextColor={theme.textDim}
          returnKeyType="send"
          blurOnSubmit={false}
          style={styles.input}
          value={value}
        />

        <View style={styles.controls}>
          <ComposerChip icon="‹›" label={provider} />
          <ComposerChip icon="✦" label={model} />
          <View style={styles.spacer} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open session options"
            accessibilityState={{ expanded: optionsOpen }}
            onPress={() => setOptionsOpen(true)}
            style={({ pressed }) => [styles.moreButton, pressed && styles.buttonPressed]}
          >
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

      <SessionOptionsSheet visible={optionsOpen} mode={mode} onChangeMode={setMode} onClose={() => setOptionsOpen(false)} workflows={workflows} onStartWorkflow={onStartWorkflow} />
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    gap: 7,
    paddingHorizontal: 10,
    paddingTop: 7,
    paddingBottom: 9,
    backgroundColor: 'rgba(9, 16, 24, 0.94)',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
  },
  usage: {
    minHeight: 42,
    paddingHorizontal: 11,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 8,
    backgroundColor: theme.surface,
  },
  usageLead: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  usageLabel: { color: theme.textSecondary, fontSize: 13 },
  usageMeta: { flex: 1, minWidth: 0, color: theme.textDim, fontSize: 11 },
  closeButton: { width: 24, height: 28, alignItems: 'center', justifyContent: 'center' },
  closeText: { color: theme.textDim, fontSize: 17, fontWeight: '300' },
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
  chip: { height: 29, maxWidth: 118, paddingHorizontal: 6, flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 6 },
  chipLabel: { flexShrink: 1, color: theme.textSecondary, fontSize: 11 },
  chipMeta: { paddingHorizontal: 4, paddingVertical: 1, overflow: 'hidden', borderRadius: 4, backgroundColor: theme.bgSunken, color: theme.textDim, fontSize: 10, fontVariant: ['tabular-nums'] },
  glyph: { color: theme.textSecondary, fontSize: 13, fontWeight: '500' },
  glyphAccent: { color: theme.accent },
  moreButton: { width: 34, height: 31, alignItems: 'center', justifyContent: 'center', borderRadius: 6 },
  moreGlyph: { marginTop: -5, color: theme.textSecondary, fontSize: 15, fontWeight: '700', letterSpacing: 1 },
  sendButton: { width: 31, height: 31, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 6 },
  sendButtonDisabled: { opacity: 0.48 },
  sendGlyph: { color: theme.textDim, fontSize: 20, fontWeight: '500', lineHeight: 22 },
  sendGlyphActive: { color: theme.text },
  buttonPressed: { backgroundColor: theme.surfaceRaised },
  sheetOverlay: { flex: 1, justifyContent: 'flex-end' },
  sheetScrim: { position: 'absolute', inset: 0, backgroundColor: 'rgba(0, 0, 0, 0.62)' },
  sheet: { paddingHorizontal: 14, paddingTop: 8, borderTopLeftRadius: 18, borderTopRightRadius: 18, borderWidth: 1, borderBottomWidth: 0, borderColor: theme.borderStrong, backgroundColor: theme.bgSunken },
  sheetHandle: { width: 42, height: 4, alignSelf: 'center', marginBottom: 12, borderRadius: 2, backgroundColor: theme.borderStrong },
  sheetHeader: { marginBottom: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { color: theme.text, fontSize: 17, fontWeight: '700' },
  sheetSubtitle: { marginTop: 3, color: theme.textDim, fontSize: 10 },
  sheetClose: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 7, backgroundColor: theme.surface },
  sheetCloseText: { color: theme.textDim, fontSize: 21, fontWeight: '300' },
  sheetSectionLabel: { marginTop: 12, marginBottom: 6, color: theme.textDim, fontSize: 10, fontWeight: '700', letterSpacing: 0.8 },
  modeToggle: { flexDirection: 'row', padding: 3, gap: 2, borderWidth: 1, borderColor: theme.border, borderRadius: 8, backgroundColor: theme.surface },
  modeButton: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 6 },
  modeButtonActive: { backgroundColor: theme.surfaceRaised },
  modeText: { color: theme.textDim, fontSize: 12, fontWeight: '600' },
  modeTextActive: { color: theme.text },
  sheetGroup: { overflow: 'hidden', borderWidth: 1, borderColor: theme.border, borderRadius: 9, backgroundColor: theme.surface },
  sheetRow: { minHeight: 48, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  sheetRowPressed: { backgroundColor: theme.surfaceRaised },
  sheetRowIcon: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 7, backgroundColor: theme.bgSunken },
  sheetRowIconText: { color: theme.textSecondary, fontSize: 12, fontWeight: '700' },
  sheetRowLabel: { flex: 1, color: theme.textSecondary, fontSize: 13, fontWeight: '600' },
  sheetRowValue: { maxWidth: '44%', color: theme.textDim, fontSize: 12 },
  sheetChevron: { color: theme.textDim, fontSize: 18 },
});
