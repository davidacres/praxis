import React, { useEffect, useState } from 'react';
import { StatusBar, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StoreProvider, useStore } from './app/store';
import { applyDisplayMode, statusBarStyle, theme, themedStyles, useThemeVersion } from './app/theme';
import { loadMobileDisplayMode } from './app/mobileConnection';
import { mobileShellShowsWork } from './renderer/mobileShellState';
import { AppSidebar } from './app/AppSidebar';
import { ConnectScreen } from './screens/ConnectScreen';
import { WorkScreen } from './screens/WorkScreen';
import { AttentionScreen } from './screens/AttentionScreen';
import { ActivityScreen } from './screens/ActivityScreen';

function Shell(): React.JSX.Element {
  const { shell } = useStore();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  if (!mobileShellShowsWork(shell)) {
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
  // Re-render from the root when the desktop's theme arrives or changes, so every screen repaints.
  useThemeVersion();
  useEffect(() => {
    void loadMobileDisplayMode().then(mode => { if (mode) applyDisplayMode(mode); });
  }, []);
  return (
    <SafeAreaProvider>
      <StoreProvider>
        <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
          <StatusBar barStyle={statusBarStyle()} backgroundColor={theme.bg} />
          <Shell />
        </SafeAreaView>
      </StoreProvider>
    </SafeAreaProvider>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  shell: { flex: 1, backgroundColor: theme.bg },
  content: { flex: 1 },
}));
