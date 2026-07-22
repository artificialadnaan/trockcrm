import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { QueryClient } from "@tanstack/react-query";
import { theme } from "../theme/theme";

/**
 * App-wide render safety net. The app previously had NO error boundary, so ANY uncaught throw during render
 * (e.g. a bad data shape reaching a screen) tore down the whole app — the tester's "the filter button kicks me
 * out of the app". This catches the throw, keeps the process alive, and offers recovery. It does NOT hide
 * bugs — it degrades a hard crash into a recoverable in-app error.
 */
interface Props {
  children: React.ReactNode;
  /** Optional label so a boundary around a specific area can name it (e.g. "this project"). */
  area?: string;
  /** When provided, a retry drops cached query data first, so a deterministic failure from a malformed cached
   *  value gets a fresh refetch instead of immediately re-throwing against the same cache. */
  queryClient?: QueryClient;
}
interface State {
  // Track failure with an explicit flag, NOT the thrown value: JS permits throwing falsy values
  // (null/undefined/0/""), and a truthy-check on the value would treat those as "healthy" and let the
  // exception escape the safety net. `error` is `unknown` for the same reason (any value can be thrown).
  hasError: boolean;
  error: unknown;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    // No crash-reporting transport is wired yet; at least surface it to the JS console / device logs.
    console.error("[ErrorBoundary] caught a render error:", error, info?.componentStack);
  }

  /** Retry in place: clear cached query data first so a deterministic failure from a malformed CACHED value
   *  gets a fresh refetch rather than re-throwing immediately, then remount the subtree. */
  retry = () => {
    try {
      this.props.queryClient?.clear();
    } catch {
      /* clearing the cache must never itself block recovery */
    }
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      const where = this.props.area ? ` loading ${this.props.area}` : "";
      return (
        <SafeAreaView style={styles.safe}>
          <View style={styles.center}>
            <Text style={styles.title}>Something went wrong{where}.</Text>
            <Text style={styles.body}>
              The screen hit an unexpected error. Tap Try again to reload the screen.
            </Text>
            <Pressable
              onPress={this.retry}
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
