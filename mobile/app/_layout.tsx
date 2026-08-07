import React from "react";
import { Stack } from "expo-router";
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
// Side-effect import: registers the background upload-drain task at startup so the OS can invoke it even
// when the app is cold-launched in the background (before the capture screen mounts).
import "../src/capture/upload-background-task";
// Side-effect import, same reason: a COLD return from Meta AI is launched BY the callback URL, and
// expo-router routes it somewhere that is not the diagnostic screen — so a handler owned by that
// screen never installs and registration silently never completes. Dev-only internally.
import "../src/wearables/registration-callback";

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
