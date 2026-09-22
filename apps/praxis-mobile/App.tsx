import React, { useState } from 'react';
import { StatusBar, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StoreProvider, useStore } from './app/store';
import { theme } from './app/theme';
import { AppSidebar } from './app/AppSidebar';
import { ConnectScreen } from './screens/ConnectScreen';
import { WorkScreen } from './screens/WorkScreen';
import { AttentionScreen } from './screens/AttentionScreen';
import { ActivityScreen } from './screens/ActivityScreen';

function Shell(): React.JSX.Element {
  const { shell } = useStore();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  if (shell.connection !== 'ready') {
    return <ConnectScreen />;
  }

  const route = shell.navigation.primary;
  return (
    <View style={styles.shell}>
      <View style={styles.content}>
        {route === 'work' && <WorkScreen onOpenSidebar={() => setSidebarOpen(true)} />}
        {route === 'attention' && <AttentionScreen onOpenSidebar={() => setSidebarOpen(true)} />}
        {route === 'activity' && <ActivityScreen onOpenSidebar={() => setSidebarOpen(true)} />}
      </View>
      <AppSidebar visible={sidebarOpen} onClose={() => setSidebarOpen(false)} />
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
});
