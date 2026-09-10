import React from 'react';
import { Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StoreProvider, useStore, MOBILE_PRIMARY_ROUTES, type MobilePrimaryRoute } from './app/store';
import { theme } from './app/theme';
import { ConnectScreen } from './screens/ConnectScreen';
import { WorkScreen } from './screens/WorkScreen';
import { AttentionScreen } from './screens/AttentionScreen';
import { ActivityScreen } from './screens/ActivityScreen';

const TAB_LABEL: Record<MobilePrimaryRoute, string> = { work: 'Work', attention: 'Attention', activity: 'Activity' };

function Shell(): React.JSX.Element {
  const { shell, setRoute, attention } = useStore();

  if (shell.connection !== 'ready') {
    return <ConnectScreen />;
  }

  const route = shell.navigation.primary;
  const unresolved = attention.filter(item => !item.resolved).length;

  return (
    <View style={styles.shell}>
      <View style={styles.content}>
        {route === 'work' && <WorkScreen />}
        {route === 'attention' && <AttentionScreen />}
        {route === 'activity' && <ActivityScreen />}
      </View>
      <View style={styles.tabBar}>
        {MOBILE_PRIMARY_ROUTES.map(tab => (
          <Pressable key={tab} onPress={() => setRoute(tab)} style={styles.tabItem}>
            <Text style={[styles.tabLabel, route === tab && styles.tabLabelActive]}>
              {TAB_LABEL[tab]}
              {tab === 'attention' && unresolved > 0 ? `  ${unresolved}` : ''}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export default function App(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <StoreProvider>
        <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
          <StatusBar barStyle="light-content" backgroundColor={theme.bg} />
          <Shell />
        </SafeAreaView>
      </StoreProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  shell: { flex: 1, backgroundColor: theme.bg },
  content: { flex: 1 },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: theme.border,
    backgroundColor: theme.surface,
  },
  tabItem: { flex: 1, alignItems: 'center', paddingVertical: 14 },
  tabLabel: { color: theme.textDim, fontSize: 13, fontWeight: '600' },
  tabLabelActive: { color: theme.accent },
});
