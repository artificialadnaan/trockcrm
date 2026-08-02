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
// Same, for the glasses-walkthrough upload queue. A second, independently-named task — see that
// module's header for why this coexists with (rather than conflicts with) the import above.
import "../src/walkthrough/upload-background-task";

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
  // A WARM return — the app stayed alive while Meta AI was in front — does NOT go through
  // getInitialURL(); iOS delivers it as a live `url` event instead. The only listener that used
  // to exist for that lived inside the __DEV__-only /dev-wearables screen, which is not mounted
  // during the release pairing flow, so a warm return from Profile's "Pair glasses" button was
  // silently dropped and registration never completed. Registering the listener here, alongside
  // the cold-launch handler, covers both without duplicating a screen-scoped effect.
  useEffect(() => {
    if (!wearablesAvailable) return;
    void Linking.getInitialURL().then((url) => {
      if (url) void Wearables.handleUrl(url).catch(() => {});
    });
    const sub = Linking.addEventListener("url", ({ url }) => {
      void Wearables.handleUrl(url).catch(() => {});
    });
    return () => sub.remove();
  }, []);

  // The SDK must be `configure()`d before anything can select a device. The only production call
  // site used to be the Profile tab's PairingRow — but a user can go straight from a project to
  // Capture and start an AI walk without ever visiting Profile, in which case `AutoDeviceSelector`
  // runs against an unconfigured SDK, no device is ever selected, and the walk fails after 8s with
  // `walk_no_device`, blaming the glasses for a step the app itself skipped. Configuring here, once
  // at startup, closes that gap regardless of which screen the user visits first.
  //
  // `Wearables.configure()` is idempotent-safe on the native side (guarded on a static `configured`
  // flag, resolving `alreadyConfigured: true`), so this does not conflict with Profile configuring
  // again later. Failures are swallowed — a configure error must never block app launch; the
  // walk's own error path surfaces it if it still matters by the time a walk is attempted.
  useEffect(() => {
    if (!wearablesAvailable) return;
    void Wearables.configure().catch(() => {});
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
