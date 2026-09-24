import React from 'react';
import { Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { recordDiagnostic } from './diagnostics';
import { mobileScale, theme, themedStyles } from './theme';

interface Props {
  /** What this boundary guards, for the message and the diagnostics entry ("the Attention screen"). */
  area: string;
  children: React.ReactNode;
  /** Changing it clears a caught error — moving to another screen gets a fresh try. */
  resetKey?: string;
}

interface State { error: Error | undefined; stack: string | undefined }

/**
 * Catches a render error so one bad payload — a desktop newer than the phone,
 * a field the phone did not expect — costs one screen, not the whole app.
 * The person can try again, share the details, and still reach the rest of
 * Praxis from the sidebar.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  public state: State = { error: undefined, stack: undefined };

  public static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  public componentDidCatch(error: Error, info: React.ErrorInfo): void {
    recordDiagnostic(`Showing ${this.props.area}`, error);
    this.setState({ stack: info.componentStack ?? undefined });
  }

  public componentDidUpdate(previous: Props): void {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: undefined, stack: undefined });
  }

  private readonly share = (): void => {
    const { error, stack } = this.state;
    void Share.share({ message: `Praxis mobile — error showing ${this.props.area}\n\n${error?.name}: ${error?.message}\n${stack ?? ''}` });
  };

  public render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <ScrollView contentContainerStyle={styles.shell}>
        <View accessibilityRole="alert" style={styles.card}>
          <Text style={styles.title}>Something went wrong showing {this.props.area}</Text>
          <Text style={styles.body}>The rest of Praxis still works — open the menu to go elsewhere. If this keeps happening, the desktop may be newer than this app.</Text>
          <Text selectable style={styles.detail}>{error.message}</Text>
          <View style={styles.row}>
            <Pressable accessibilityRole="button" onPress={this.share} style={[styles.button, styles.ghost]}>
              <Text style={styles.ghostText}>Share details</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => this.setState({ error: undefined, stack: undefined })} style={[styles.button, styles.primary]}>
              <Text style={styles.primaryText}>Try again</Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    );
  }
}

const styles = themedStyles(() => StyleSheet.create({
  shell: { flexGrow: 1, justifyContent: 'center', padding: theme.space, backgroundColor: theme.bg },
  card: { gap: mobileScale(10), padding: theme.space, borderRadius: theme.radius, borderWidth: 1, borderColor: theme.danger, backgroundColor: theme.surface },
  title: { color: theme.text, fontSize: mobileScale(16), fontWeight: '700' },
  body: { color: theme.textSecondary, fontSize: mobileScale(13.5), lineHeight: mobileScale(20) },
  detail: { color: theme.danger, fontSize: mobileScale(12.5) },
  row: { flexDirection: 'row', gap: mobileScale(8), justifyContent: 'flex-end' },
  button: { minHeight: mobileScale(42), paddingHorizontal: mobileScale(14), borderRadius: mobileScale(9), alignItems: 'center', justifyContent: 'center' },
  primary: { backgroundColor: theme.accent },
  primaryText: { color: theme.onAccent, fontWeight: '700', fontSize: mobileScale(14) },
  ghost: { borderWidth: 1, borderColor: theme.border },
  ghostText: { color: theme.text, fontWeight: '600', fontSize: mobileScale(14) },
}));
