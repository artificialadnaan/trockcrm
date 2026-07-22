import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { theme } from "../theme/theme";

/**
 * App-wide render safety net. The app previously had NO error boundary, so ANY uncaught throw during render
 * (e.g. a bad data shape reaching a screen) tore down the whole app — the tester's "the filter button kicks me
 * out of the app". This catches the throw, keeps the process alive, and offers a "Try again" that remounts the
 * subtree (clearing the transient state that triggered the throw, e.g. an applied filter). It does NOT hide
 * bugs — it degrades a hard crash into a recoverable in-app error.
 */
interface Props {
  children: React.ReactNode;
  /** Optional label so a boundary around a specific area can name it (e.g. "this project"). */
  area?: string;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // No crash-reporting transport is wired yet; at least surface it to the JS console / device logs.
    console.error("[ErrorBoundary] caught a render error:", error, info?.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      const where = this.props.area ? ` loading ${this.props.area}` : "";
      return (
        <SafeAreaView style={styles.safe}>
          <View style={styles.center}>
            <Text style={styles.title}>Something went wrong{where}.</Text>
            <Text style={styles.body}>
              The screen hit an unexpected error. Your work isn&apos;t lost — tap Try again to reload.
            </Text>
            <Pressable
              onPress={this.reset}
              accessibilityRole="button"
              style={({ pressed }) => [styles.button, pressed && { opacity: 0.85 }]}
            >
              <Text style={styles.buttonText}>Try again</Text>
            </Pressable>
          </View>
        </SafeAreaView>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceApp },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.space.xl, gap: theme.space.md },
  title: { fontFamily: theme.font.semibold, fontSize: 18, color: theme.color.textPrimary, textAlign: "center" },
  body: { fontFamily: theme.font.body, fontSize: 14, color: theme.color.textMuted, textAlign: "center" },
  button: {
    marginTop: theme.space.sm,
    backgroundColor: theme.color.brandRed,
    paddingVertical: theme.space.md,
    paddingHorizontal: theme.space.xl,
    borderRadius: theme.radius.md,
  },
  buttonText: { fontFamily: theme.font.semibold, fontSize: 15, color: theme.color.textInverse },
});
