import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useFonts, Inter_400Regular, Inter_600SemiBold, Inter_700Bold } from "@expo-google-fonts/inter";
import { AuthProvider } from "../src/auth/AuthContext";

// Generous staleTime because this app is used on job sites: a screen opened on arrival should still
// render from cache in a basement with no signal, rather than spinning. Writes invalidate explicitly.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 30 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({ Inter_400Regular, Inter_600SemiBold, Inter_700Bold });

  // Hold the first paint until fonts resolve, so text doesn't reflow from the system font to Inter.
  // But `useFonts` also reports FAILURE, and gating on `loaded` alone would leave the app on a blank
  // screen forever if a font asset failed to load. Proceeding with system fonts is far better than
  // showing nothing: the app is legible, just not on-brand.
  if (!fontsLoaded && !fontError) return null;

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <StatusBar style="dark" />
        <Stack screenOptions={{ headerShown: false }} />
      </AuthProvider>
    </QueryClientProvider>
  );
}
