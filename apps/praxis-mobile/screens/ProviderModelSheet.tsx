import React from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MobileModelCatalog, MobileProviderCatalog } from '@praxis/core';
import { theme, themedStyles } from '../app/theme';
import type { Remote } from '../app/store';
import { availableProviderOptions } from '../renderer/mobileSessionOptions';

interface ProviderModelSheetProps {
  kind: 'provider' | 'model' | undefined;
  providers: Remote<MobileProviderCatalog>;
  models: Remote<MobileModelCatalog> | undefined;
  selectedProvider?: string;
  selectedModel?: string;
  providerLabel: string;
  onSelectProvider: (provider: string) => void;
  onSelectModel: (model: string | undefined) => void;
  onRefresh: () => void;
  onClose: () => void;
  /** Replaces the list with a confirmation (a provider handover starts a turn). */
  confirm?: { title: string; body: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void };
  busy?: boolean;
  error?: string;
  /** Offer "Provider default" (a new chat); an existing session names a model explicitly. */
  allowDefault?: boolean;
}

function OptionRow({
  title,
  caption,
  selected,
  disabled,
  onPress,
}: {
  title: string;
  caption?: string;
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled: Boolean(disabled) }}
      accessibilityLabel={`${title}${caption ? `, ${caption}` : ''}`}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.row, selected && styles.rowSelected, pressed && styles.rowPressed]}
    >
      <View style={styles.rowText}>
        <Text numberOfLines={1} style={[styles.rowTitle, disabled && styles.rowTitleDisabled]}>{title}</Text>
        {caption ? <Text style={[styles.rowCaption, disabled && styles.rowCaptionWarn]}>{caption}</Text> : null}
      </View>
      <Text style={[styles.check, !selected && styles.checkHidden]}>✓</Text>
    </Pressable>
  );
}

function StateNote({ busy, text, tone = 'dim' }: { busy?: boolean; text: string; tone?: 'dim' | 'warn' }): React.JSX.Element {
  return (
    <View style={styles.stateNote}>
      {busy ? <ActivityIndicator color={theme.textDim} size="small" /> : null}
      <Text style={[styles.stateText, tone === 'warn' && styles.stateWarn]}>{text}</Text>
    </View>
  );
}

/** Picks a provider or model from what the desktop reports as available. */
export function ProviderModelSheet(props: ProviderModelSheetProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const catalog = props.providers.value;
  const availableProviders = availableProviderOptions(catalog);
  const modelCatalog = props.models?.value;
  const title = props.kind === 'model' ? `Model · ${props.providerLabel}` : 'AI provider';
  return (
    <Modal animationType="fade" onRequestClose={props.onClose} transparent visible={props.kind !== undefined}>
      <View style={styles.overlay}>
        <Pressable accessibilityLabel="Close picker" accessibilityRole="button" onPress={props.onClose} style={styles.scrim} />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.title}>{title}</Text>
              <Text style={styles.subtitle}>Runs on the desktop. Keys and settings stay there.</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Refresh from the desktop" onPress={props.onRefresh} style={styles.headerButton}>
              <Text style={styles.headerButtonText}>↻</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Close picker" onPress={props.onClose} style={styles.headerButton}>
              <Text style={styles.headerButtonText}>×</Text>
            </Pressable>
          </View>
          {props.error ? <StateNote tone="warn" text={props.error} /> : null}
          {props.busy ? <StateNote busy text="Applying on the desktop…" /> : null}
          {props.confirm ? (
            <View style={styles.confirm}>
              <Text style={styles.confirmTitle}>{props.confirm.title}</Text>
              <Text style={styles.stateText}>{props.confirm.body}</Text>
              <View style={styles.confirmActions}>
                <Pressable accessibilityRole="button" onPress={props.confirm.onCancel} style={({ pressed }) => [styles.confirmButton, pressed && styles.rowPressed]}>
                  <Text style={styles.confirmCancel}>Cancel</Text>
                </Pressable>
                <Pressable accessibilityRole="button" disabled={props.busy} onPress={props.confirm.onConfirm} style={({ pressed }) => [styles.confirmButton, styles.confirmPrimary, pressed && styles.rowPressed]}>
                  <Text style={styles.confirmPrimaryText}>{props.confirm.confirmLabel}</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
          <ScrollView style={[styles.list, props.confirm && styles.hidden]} contentContainerStyle={styles.listContent}>
            {props.kind === 'provider' ? (
              <>
                {props.providers.status === 'loading' && !catalog ? <StateNote busy text="Loading providers from the desktop…" /> : null}
                {props.providers.status === 'unsupported' || props.providers.status === 'error' ? (
                  <StateNote tone="warn" text={props.providers.message ?? 'The desktop did not return its providers.'} />
                ) : null}
                {catalog && availableProviders.length === 0 ? (
                  <StateNote tone="warn" text="No AI provider is ready on the desktop. Add a key or enable a provider in Settings → AI Provider." />
                ) : null}
                {availableProviders.map(option => (
                  <OptionRow
                    key={option.provider}
                    title={option.label}
                    caption={option.available
                      ? `${option.kind === 'cli-agent' ? 'Local agent' : 'API'}${option.provider === catalog?.defaultProvider ? ' · desktop default' : ''}`
                      : option.unavailableMessage ?? 'Not available on the desktop'}
                    selected={props.selectedProvider === option.provider}
                    disabled={!option.available}
                    onPress={() => props.onSelectProvider(option.provider)}
                  />
                ))}
              </>
            ) : (
              <>
                {props.models === undefined || (props.models.status === 'loading' && !modelCatalog) ? <StateNote busy text="Loading models from the desktop…" /> : null}
                {props.models?.status === 'error' ? <StateNote tone="warn" text={props.models.message ?? 'The desktop did not return a model list.'} /> : null}
                {props.models?.status === 'unsupported' ? <StateNote tone="warn" text={props.models.message ?? 'Model choice needs a newer desktop.'} /> : null}
                {modelCatalog && modelCatalog.status !== 'ok' ? <StateNote tone="warn" text={modelCatalog.message ?? 'The model list is unavailable; the provider default will be used.'} /> : null}
                {modelCatalog?.status === 'ok' && modelCatalog.message ? <StateNote text={modelCatalog.message} /> : null}
                {props.models && props.models.status !== 'loading' && props.allowDefault !== false ? (
                  <OptionRow
                    title="Provider default"
                    caption={modelCatalog?.defaultModel ? `Currently ${modelCatalog.models.find(model => model.modelId === modelCatalog.defaultModel)?.name ?? modelCatalog.defaultModel}` : 'Whatever the desktop is configured to use'}
                    selected={!props.selectedModel}
                    onPress={() => props.onSelectModel(undefined)}
                  />
                ) : null}
                {modelCatalog?.status === 'ok' ? modelCatalog.models.map(model => (
                  <OptionRow
                    key={model.modelId}
                    title={model.name}
                    caption={[model.modelId !== model.name ? model.modelId : undefined, model.contextLength ? `${Math.round(model.contextLength / 1000)}k context` : undefined].filter(Boolean).join(' · ') || undefined}
                    selected={props.selectedModel === model.modelId}
                    onPress={() => props.onSelectModel(model.modelId)}
                  />
                )) : null}
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  scrim: { position: 'absolute', inset: 0, backgroundColor: theme.scrim },
  sheet: { maxHeight: '78%', paddingHorizontal: 14, paddingTop: 8, borderTopLeftRadius: 18, borderTopRightRadius: 18, borderWidth: 1, borderBottomWidth: 0, borderColor: theme.borderStrong, backgroundColor: theme.bgSunken },
  handle: { width: 42, height: 4, alignSelf: 'center', marginBottom: 12, borderRadius: 2, backgroundColor: theme.borderStrong },
  header: { marginBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerText: { flex: 1 },
  title: { color: theme.text, fontSize: 17, fontWeight: '700' },
  subtitle: { marginTop: 3, color: theme.textDim, fontSize: 10 },
  headerButton: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 7, backgroundColor: theme.surface },
  headerButtonText: { color: theme.textDim, fontSize: 19, fontWeight: '300' },
  list: { flexGrow: 0 },
  listContent: { gap: 6, paddingBottom: 8 },
  row: { minHeight: 52, paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: theme.border, borderRadius: 9, backgroundColor: theme.surface },
  rowSelected: { borderColor: theme.accentMuted, backgroundColor: theme.accentSoft },
  rowPressed: { backgroundColor: theme.surfaceRaised },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { color: theme.text, fontSize: 13, fontWeight: '600' },
  rowTitleDisabled: { color: theme.textDim },
  rowCaption: { marginTop: 3, color: theme.textDim, fontSize: 11, lineHeight: 15 },
  rowCaptionWarn: { color: theme.warn },
  check: { color: theme.accent, fontSize: 15, fontWeight: '700' },
  checkHidden: { opacity: 0 },
  stateNote: { paddingVertical: 8, paddingHorizontal: 2, flexDirection: 'row', alignItems: 'center', gap: 8 },
  stateText: { flex: 1, color: theme.textDim, fontSize: 12, lineHeight: 17 },
  stateWarn: { color: theme.warn },
  hidden: { display: 'none' },
  confirm: { gap: 10, paddingVertical: 8 },
  confirmTitle: { color: theme.text, fontSize: 15, fontWeight: '700' },
  confirmActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  confirmButton: { minHeight: 40, paddingHorizontal: 16, justifyContent: 'center', borderWidth: 1, borderColor: theme.border, borderRadius: 8, backgroundColor: theme.surface },
  confirmPrimary: { borderColor: theme.accent, backgroundColor: theme.accent },
  confirmCancel: { color: theme.textSecondary, fontSize: 13, fontWeight: '700' },
  confirmPrimaryText: { color: theme.onAccent, fontSize: 13, fontWeight: '700' },
}));
