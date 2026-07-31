import React, { useEffect } from "react";
import { Stack } from "expo-router";
import * as Linking from "expo-linking";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { AuthProvider } from "../src/auth/AuthContext";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import { isAvailable as wearablesAvailable, Wearables } from "../src/wearables/native";
// Side-effect import: registers the background upload-drain task at startup so the OS can invoke it even
// when the app is cold-launched in the background (before the capture screen mounts).
import "../src/capture/upload-background-task";

// retry once, treat data as fresh for 30s — same defaults as the reference app.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  // Meta Wearables registration hands off to Meta AI, which returns via a `trockcam://`
  // callback URL. If iOS terminated the app during that handoff, the callback URL becomes the
  // app's *initial* route rather than a live `Linking` event — and that route is not
  // /dev-wearables, so an effect scoped to that screen would never mount to receive it. This
  // runs once at the root, unconditionally (above the fontsLoaded early return, so it fires on
  // the very first render and keeps hook order stable), so a cold return from Meta AI reaches
  // the SDK regardless of which route the app opens on.
  //
  // Note: as of 2026-07-30 this is dead code in practice — registration was verified to
  // complete without it, because the SDK persists its own state across the handoff. Kept for
  // correctness on this one cold-start path, not because anything is currently blocked on it.
  useEffect(() => {
    if (!wearablesAvailable) return;
    void Linking.getInitialURL().then((url) => {
      if (url) void Wearables.handleUrl(url).catch(() => {});
    });
  }, []);

  if (!fontsLoaded) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <StatusBar style="dark" />
            {/* App-wide render safety net: a screen throw becomes a recoverable in-app error, not a hard
                crash that kicks the user out of the app. */}
            <ErrorBoundary queryClient={queryClient}>
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="index" />
                <Stack.Screen name="login" />
                <Stack.Screen name="accept-invite" />
                <Stack.Screen name="(app)" />
              </Stack>
            </ErrorBoundary>
          </AuthProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
