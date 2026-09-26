import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { MobileFileDiff, MobileSessionChanges } from '@praxis/core';
import { useStore, type MobileRunSummary } from '../app/store';
import { MONOSPACE } from '../app/Markdown';
import { Body, Button, Card } from '../app/ui';
import { mobileScale, theme, themedStyles } from '../app/theme';

const STATUS_MARK: Record<MobileSessionChanges['files'][number]['status'], string> = {
  added: 'A', modified: 'M', deleted: 'D', renamed: 'R', conflicted: '!',
};

function DiffBody({ diff }: { diff: MobileFileDiff }): React.JSX.Element {
  if (diff.binary) return <Body dim>Binary file — no text diff.</Body>;
  if (diff.hunks.length === 0) return <Body dim>No line changes to show (a new, untracked or mode-only change).</Body>;
  return (
    <ScrollView horizontal nestedScrollEnabled style={styles.diff}>
      <View>
        {diff.hunks.map((hunk, hunkIndex) => (
          <View key={hunkIndex}>
            <Text style={[styles.line, styles.hunk]}>{hunk.header}</Text>
            {hunk.lines.map((line, index) => (
              <Text
                key={index}
                selectable
                style={[styles.line, line.kind === 'add' ? styles.add : line.kind === 'delete' ? styles.del : undefined]}
              >
                {`${String(line.kind === 'delete' ? line.oldLine ?? '' : line.newLine ?? '').padStart(4)} ${line.kind === 'add' ? '+' : line.kind === 'delete' ? '−' : ' '} ${line.text}`}
              </Text>
            ))}
          </View>
        ))}
        {diff.truncated ? <Text style={[styles.line, styles.hunk]}>… more lines on the desktop</Text> : null}
      </View>
    </ScrollView>
  );
}

/**
 * What a session changed on disk — the desktop's Changes tab, read-only:
 * the files that differ from HEAD, the session's own edits first, each
 * opening to its diff. Read before approving what the session did.
 */
export function ChangesView({ sessionId, runId, run }: { sessionId: string; runId?: string; run?: MobileRunSummary }): React.JSX.Element {
  const { sessionChanges, fileDiff, changesSupported, shell } = useStore();
  const [changes, setChanges] = useState<MobileSessionChanges | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | undefined>(undefined);
  const [diffs, setDiffs] = useState<Record<string, MobileFileDiff | { error: string } | undefined>>({});

  const refresh = useCallback(() => {
    if (!changesSupported || shell.connection !== 'ready') return;
    setLoading(true);
    setError(undefined);
    void sessionChanges(sessionId)
      .then(next => {
        setChanges(next);
        setDiffs({});
      })
      .catch(failure => setError(failure instanceof Error ? failure.message : String(failure)))
      .finally(() => setLoading(false));
  }, [changesSupported, sessionChanges, sessionId, shell.connection]);

  useEffect(refresh, [refresh]);

  const toggle = (path: string): void => {
    if (open === path) {
      setOpen(undefined);
      return;
    }
    setOpen(path);
    if (diffs[path]) return;
    void fileDiff(sessionId, path)
      .then(diff => setDiffs(current => ({ ...current, [path]: diff })))
      .catch(failure => setDiffs(current => ({ ...current, [path]: { error: failure instanceof Error ? failure.message : String(failure) } })));
  };

  const artifacts = run?.stages.flatMap(stage => stage.artifacts.map(artifact => ({ key: `${stage.nodeId}:${artifact.contractId}:${artifact.path ?? artifact.kind}`, label: artifact.path ?? artifact.contractId, kind: artifact.kind }))) ?? [];

  return (
    <>
      <Card>
        <View style={styles.headerRow}>
          <Text style={styles.heading}>Working tree</Text>
          {changesSupported ? <Button label={loading ? 'Refreshing…' : 'Refresh'} kind="ghost" disabled={loading || shell.connection !== 'ready'} onPress={refresh} /> : null}
        </View>
        {!changesSupported ? <Body dim>Update Praxis on the desktop to see a session’s changed files here.</Body> : null}
        {loading && !changes ? <ActivityIndicator color={theme.textDim} /> : null}
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {changes && !changes.repository ? <Body dim>This session’s folder isn’t a git repository, so there is nothing to compare.</Body> : null}
        {changes?.repository && changes.files.length === 0 ? <Body dim>No uncommitted changes in this session’s working tree.</Body> : null}
        {changes?.branch ? <Body dim>On {changes.branch}</Body> : null}
        {changes?.files.map(file => {
          const diff = diffs[file.path];
          return (
            <View key={file.path} style={styles.file}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: open === file.path }}
                accessibilityLabel={`${file.path}, ${file.status}${file.reportedBySession ? ', edited by this session' : ''}. Show diff.`}
                onPress={() => toggle(file.path)}
                style={({ pressed }) => [styles.fileRow, pressed && styles.pressed]}
              >
                <Text style={[styles.mark, file.status === 'deleted' && { color: theme.danger }, file.status === 'added' && { color: theme.ok }]}>{STATUS_MARK[file.status]}</Text>
                <Text numberOfLines={2} style={[styles.path, !file.reportedBySession && styles.pathOther]}>{file.path}</Text>
                {file.additions !== undefined ? <Text style={[styles.count, { color: theme.ok }]}>+{file.additions}</Text> : null}
                {file.deletions !== undefined ? <Text style={[styles.count, { color: theme.danger }]}>−{file.deletions}</Text> : null}
              </Pressable>
              {open === file.path ? (
                diff === undefined ? <ActivityIndicator color={theme.textDim} />
                  : 'error' in diff ? <Text style={styles.error}>{diff.error}</Text>
                    : <DiffBody diff={diff} />
              ) : null}
            </View>
          );
        })}
        {changes?.files.some(file => !file.reportedBySession) ? (
          <Body dim>Dimmed files were not reported by this session’s tools — they may have been changed already, or by a command it ran.</Body>
        ) : null}
      </Card>
      {runId ? (
        <Card>
          <Text style={styles.heading}>Workflow outputs</Text>
          {!run ? <Body dim>Loading workflow artifacts…</Body> : null}
          {run && artifacts.length === 0 ? <Body dim>No workflow artifacts have been produced yet.</Body> : null}
          {artifacts.map(artifact => (
            <View key={artifact.key} style={styles.artifact}>
              <Text numberOfLines={1} style={styles.path}>{artifact.label}</Text>
              <Text style={styles.pathOther}>{artifact.kind}</Text>
            </View>
          ))}
        </Card>
      ) : null}
    </>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: mobileScale(8) },
  heading: { color: theme.text, fontSize: mobileScale(14), fontWeight: '700' },
  error: { color: theme.danger, fontSize: mobileScale(13) },
  file: { gap: mobileScale(6), borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border, paddingTop: mobileScale(8) },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: mobileScale(8), minHeight: mobileScale(36) },
  pressed: { opacity: 0.7 },
  mark: { width: mobileScale(16), color: theme.warn, fontFamily: MONOSPACE, fontWeight: '700', fontSize: mobileScale(12) },
  path: { flex: 1, color: theme.text, fontFamily: MONOSPACE, fontSize: mobileScale(12) },
  pathOther: { color: theme.textDim, fontSize: mobileScale(12) },
  count: { fontFamily: MONOSPACE, fontSize: mobileScale(11.5) },
  diff: { maxHeight: mobileScale(420), backgroundColor: theme.bgSunken, borderRadius: mobileScale(6) },
  line: { fontFamily: MONOSPACE, fontSize: mobileScale(11.5), lineHeight: mobileScale(16), color: theme.text, paddingHorizontal: mobileScale(8) },
  hunk: { color: theme.textDim, paddingVertical: mobileScale(4) },
  add: { backgroundColor: theme.accentSoft, color: theme.ok },
  del: { backgroundColor: theme.dangerSoft, color: theme.danger },
  artifact: { flexDirection: 'row', gap: mobileScale(8), alignItems: 'center' },
}));
