import React, { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Redirect, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { ApiError } from "../src/api/client";
import { useAuth } from "../src/auth/AuthContext";
import { theme } from "../src/theme/theme";

/**
 * Forced password change.
 *
 * This screen is why mobile-login lets a must_change_password user in at all. The FIELD app bounces
 * them at login, which produces a loop with no way out (server TODO #721): the user can never reach the
 * screen that would clear the flag. Here the flag rides on the session and routes here instead —
 * /api/auth/local/change-password is one of only three routes authMiddleware still permits while a
 * change is pending, and it accepts the Bearer token.
 */
export default function ChangePasswordScreen() {
  const router = useRouter();
  const { session, fetcher, signOut } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mismatch = confirm.length > 0 && next !== confirm;
  // confirm must be NON-EMPTY, not merely non-mismatching: with an empty confirm, `mismatch` is false,
  // so the typo safeguard would be skipped entirely and a mistyped password could lock the user out.
  const canSubmit = current.length > 0 && next.length > 0 && confirm.length > 0 && !mismatch && !busy;

  async function onSubmit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await fetcher("/auth/local/change-password", {
        method: "POST",
        body: { currentPassword: current, newPassword: next },
        // A 401 here means the CURRENT PASSWORD was wrong, not that the session died — the server returns
        // 401 for a bad current password. The default handler would sign the user out on one typo,
        // stranding a forced-change user who then cannot retry. Suppress it and show the error instead.
        onUnauthorized: () => {},
      });
      // The flag lives on the server; the simplest correct way to pick up the cleared state is to sign
      // out and back in, rather than mutating a cached user object and hoping it matches.
      await signOut();
      router.replace("/login");
    } catch (err) {
      if (err instanceof ApiError) setError(err.status === 0 ? "Can't reach the server." : err.message);
      else setError("Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  // No layout guard sits above this top-level route (unlike the (app) group), so returning null on a
  // signed-out session would leave a permanently blank screen — reachable by opening the route directly,
  // or by any path that clears the session while it is mounted.
  if (!session) return <Redirect href="/login" />;

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>Set a new password</Text>
          <Text style={styles.subtitle}>Your account requires a password change before you continue.</Text>

          {error ? (
            <View style={styles.errorBox} accessibilityRole="alert">
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <Text style={styles.label}>Current password</Text>
          <TextInput
            testID="current-password"
            value={current}
            onChangeText={setCurrent}
            secureTextEntry
            autoCapitalize="none"
            style={styles.input}
          />

          <Text style={styles.label}>New password</Text>
          <TextInput
            testID="new-password"
            value={next}
            onChangeText={setNext}
            secureTextEntry
            autoCapitalize="none"
            style={styles.input}
          />

          <Text style={styles.label}>Confirm new password</Text>
          <TextInput
            testID="confirm-password"
            value={confirm}
            onChangeText={setConfirm}
            secureTextEntry
            autoCapitalize="none"
            style={styles.input}
          />
          {mismatch ? <Text style={styles.hint}>Passwords don&apos;t match.</Text> : null}

          <Pressable
            testID="change-password-submit"
            onPress={onSubmit}
            disabled={!canSubmit}
            accessibilityRole="button"
            accessibilityLabel="Update password"
            style={[styles.button, !canSubmit && styles.buttonDisabled]}
          >
            {busy ? (
              <ActivityIndicator color={theme.color.textInverse} />
            ) : (
              <Text style={styles.buttonText}>Update password</Text>
            )}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surface },
  flex: { flex: 1 },
  body: { padding: theme.space.xl, gap: theme.space.xs, flexGrow: 1, justifyContent: "center" },
  title: { fontFamily: theme.font.bold, fontSize: 24, color: theme.color.inkNavy },
  subtitle: {
    fontFamily: theme.font.regular,
    fontSize: 15,
    color: theme.color.textSecondary,
    marginBottom: theme.space.lg,
  },
  label: {
    fontFamily: theme.font.semibold,
    fontSize: 13,
    color: theme.color.textSecondary,
    marginTop: theme.space.md,
  },
  input: {
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.md,
    fontFamily: theme.font.regular,
    fontSize: 16,
    color: theme.color.textPrimary,
  },
  hint: { fontFamily: theme.font.regular, fontSize: 13, color: theme.color.brandRed, marginTop: theme.space.xs },
  button: {
    marginTop: theme.space.xl,
    backgroundColor: theme.color.brandRed,
    borderRadius: theme.radius.md,
    paddingVertical: theme.space.lg,
    alignItems: "center",
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { fontFamily: theme.font.bold, fontSize: 16, color: theme.color.textInverse },
  errorBox: {
    backgroundColor: "#FEF2F2",
    borderColor: theme.color.brandRed,
    borderWidth: 1,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
    marginBottom: theme.space.sm,
  },
  errorText: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.brandRedDeep },
});
