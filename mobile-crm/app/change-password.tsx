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
import { formStyles } from "../src/theme/formStyles";
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
/** Matches the server's floor. A client-side check only saves a round trip; the server still decides. */
const MIN_PASSWORD_LENGTH = 8;

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
  const tooShort = next.length > 0 && next.length < MIN_PASSWORD_LENGTH;
  const sameAsCurrent = next.length > 0 && next === current;
  const canSubmit =
    current.length > 0 &&
    next.length >= MIN_PASSWORD_LENGTH &&
    confirm.length > 0 &&
    !mismatch &&
    !sameAsCurrent &&
    !busy;

  async function onSubmit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await fetcher("/auth/local/change-password", {
        method: "POST",
        body: { currentPassword: current, newPassword: next },
        // A 401 here is ambiguous: the server returns it BOTH for a wrong current password and for a
        // dead bearer token (authMiddleware rejects before the handler runs). Signing out on the first
        // would eject a forced-change user for one typo; NOT signing out on the second would strand them
        // on this screen with a dead session and no sign-out control. Defer the decision to the catch
        // below, which can read the error code the server sends.
        onUnauthorized: () => {},
      });
      // The flag lives on the server; the simplest correct way to pick up the cleared state is to sign
      // out and back in, rather than mutating a cached user object and hoping it matches.
      await signOut();
      router.replace("/login");
    } catch (err) {
      if (err instanceof ApiError) {
        // errorHandler stamps SESSION_INVALIDATED on a dead/!active session; a wrong current password
        // carries no such code. That is the only signal separating "retry" from "you are logged out".
        if (err.status === 401 && err.code === "SESSION_INVALIDATED") {
          await signOut();
          router.replace("/login");
          return;
        }
        setError(err.status === 0 ? "Can't reach the server." : err.message);
      } else setError("Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  // `undefined` means SecureStore restoration is still running. Redirecting on it would bounce a
  // cold-open straight at this route to /login before the valid session had loaded — and /login does not
  // send an already-restored user back, so a forced-change user would be stranded there.
  if (session === undefined) {
    return (
      <SafeAreaView style={formStyles.safe}>
        <View style={formStyles.centre}>
          <ActivityIndicator color={theme.color.brandRed} />
        </View>
      </SafeAreaView>
    );
  }

  // No layout guard sits above this top-level route (unlike the (app) group), so returning null on a
  // signed-out session would leave a permanently blank screen.
  if (!session) return <Redirect href="/login" />;

  // The password may have been changed on the web or another device since this session was cached.
  // Revalidation clears the flag, and staying here would trap the user on a screen with nothing to do.
  if (!session.user.mustChangePassword) return <Redirect href="/(app)/dashboard" />;

  return (
    <SafeAreaView style={formStyles.safe}>
      <KeyboardAvoidingView style={formStyles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={formStyles.body} keyboardShouldPersistTaps="handled">
          <Text style={formStyles.title}>Set a new password</Text>
          <Text style={formStyles.subtitle}>Your account requires a password change before you continue.</Text>

          {error ? (
            <View style={formStyles.errorBox} accessibilityRole="alert">
              <Text style={formStyles.errorText}>{error}</Text>
            </View>
          ) : null}

          <Text style={formStyles.label}>Current password</Text>
          <TextInput
            testID="current-password"
            value={current}
            onChangeText={setCurrent}
            secureTextEntry
            autoCapitalize="none"
            style={formStyles.input}
          />

          <Text style={formStyles.label}>New password</Text>
          <TextInput
            testID="new-password"
            value={next}
            onChangeText={setNext}
            secureTextEntry
            autoCapitalize="none"
            style={formStyles.input}
          />

          <Text style={formStyles.label}>Confirm new password</Text>
          <TextInput
            testID="confirm-password"
            value={confirm}
            onChangeText={setConfirm}
            secureTextEntry
            autoCapitalize="none"
            style={formStyles.input}
          />
          {mismatch ? <Text style={formStyles.hint}>Passwords don&apos;t match.</Text> : null}
          {tooShort ? (
            <Text style={formStyles.hint}>Use at least {MIN_PASSWORD_LENGTH} characters.</Text>
          ) : null}
          {sameAsCurrent ? (
            <Text style={formStyles.hint}>Choose a password different from your current one.</Text>
          ) : null}

          <Pressable
            testID="change-password-submit"
            onPress={onSubmit}
            disabled={!canSubmit}
            accessibilityRole="button"
            accessibilityLabel="Update password"
            style={[formStyles.button, !canSubmit && formStyles.buttonDisabled]}
          >
            {busy ? (
              <ActivityIndicator color={theme.color.textInverse} />
            ) : (
              <Text style={formStyles.buttonText}>Update password</Text>
            )}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

