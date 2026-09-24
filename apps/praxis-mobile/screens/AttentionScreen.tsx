import React from 'react';
import { View, StyleSheet } from 'react-native';
import { AppHeader, Body, Button, Card, Pill, Screen } from '../app/ui';
import { useStore, useOpenAttention } from '../app/store';
import { attentionSubject } from '../renderer/mobileAttention';
import { ApprovalPanel } from '../app/ApprovalPanel';
import { mobileScale, themedStyles } from '../app/theme';

export function AttentionScreen({ onOpenSidebar }: { onOpenSidebar: () => void }): React.JSX.Element {
  const items = useOpenAttention();
  const { respondToPermission, openRun, retryStage, canCommand, work, runs, workflowRuns, runsSupported } = useStore();
  const [failure, setFailure] = React.useState<string | undefined>(undefined);
  const act = (action: Promise<unknown>): void => {
    setFailure(undefined);
    void action.catch(error => setFailure(error instanceof Error ? error.message : String(error)));
  };
  const runNames = React.useMemo(() => ({
    ...runs,
    ...Object.fromEntries(workflowRuns.map(run => [run.runId, { workflowName: run.workflowName }])),
  }), [runs, workflowRuns]);

  return (
    <>
      <AppHeader title="Attention" onOpenSidebar={onOpenSidebar} />
      <Screen>
      {failure ? <Card><Body>{failure}</Body></Card> : null}
      {items.length === 0 && (
        <Card>
          <Body dim>Nothing needs you right now.</Body>
        </Card>
      )}
      {items.map(item => {
        const run = item.runId ? workflowRuns.find(candidate => candidate.runId === item.runId) : undefined;
        const stage = run && item.kind === 'failure' ? run.stages.find(candidate => item.id.endsWith(`:${candidate.nodeId}`)) : undefined;
        return (
          <Card key={item.id}>
            <View style={styles.row}>
              <Pill label={item.kind} tone={item.kind === 'failure' ? 'danger' : 'warn'} />
              <Body dim>{attentionSubject(item, work, runNames)}</Body>
            </View>
            <Body>
              {item.kind === 'approval'
                ? run?.explanation ?? 'A run is waiting for your approval.'
                : item.kind === 'permission'
                  ? (item.summary ?? 'The agent is asking permission to act.')
                  : stage?.lastError ?? 'A stage failed and can be retried.'}
            </Body>
            {item.kind === 'permission' && item.detail ? <Body dim>{item.detail}</Body> : null}
            {item.kind === 'approval' && item.runId ? (
              <>
                <ApprovalPanel runId={item.runId} run={run} />
                {runsSupported && run ? <Button label="Open run" kind="ghost" onPress={() => openRun(item.runId)} /> : null}
              </>
            ) : null}
            {item.kind === 'failure' && item.runId ? (
              <View style={styles.actions}>
                {runsSupported && run ? <Button label="Open run" kind="ghost" onPress={() => openRun(item.runId)} /> : null}
                {stage && canCommand('workflowRuns.retryStage') ? (
                  <Button label="Retry step" onPress={() => act(retryStage(item.runId!, stage.nodeId))} />
                ) : null}
              </View>
            ) : null}
            {item.kind === 'permission' && item.requestId && (
              <View style={styles.actions}>
                <Button label="Deny" kind="ghost" onPress={() => act(respondToPermission(item.requestId!, 'deny'))} />
                <Button label="Allow once" onPress={() => act(respondToPermission(item.requestId!, 'allow'))} />
              </View>
            )}
          </Card>
        );
      })}
      </Screen>
    </>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: mobileScale(8) },
  actions: { flexDirection: 'row', gap: mobileScale(8) },
}));
