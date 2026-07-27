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
import { ApiError, type ApiFetchOptions } from "../src/api/client";
import * as authApi from "../src/api/endpoints/auth";
import { useAuth } from "../src/auth/AuthContext";
import { isTokenExpired } from "../src/auth/session";
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
/**
 * Matches the server's floor exactly — `PASSWORD_MIN_LENGTH = 12` in
 * server/src/modules/auth/local-auth-service.ts, enforced by validatePasswordPolicy.
 *
 * A LOWER client floor is worse than none: it enables the button, tells the user eight characters are
 * enough, and then hands back a server rejection for a rule the screen itself said they had met.
 */
const MIN_PASSWORD_LENGTH = 12;

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

  /**
   * Is a 401 from this form about the SESSION, or about the password the user just typed?
   *
   * The server gives no code to tell them apart: a wrong current password throws
   * `AppError(401, "Current password is incorrect")` (local-auth-service.ts:564) and an expired bearer
   * token throws `AppError(401, "Invalid or expired token")` (middleware/auth.ts) — BOTH uncoded. Only a
   * deactivated or version-bumped session carries SESSION_INVALIDATED, so keying solely on that code
   * strands an expired-token user here: no sign-out, no navigation, and a "wrong password" message for a
   * password that was right.
   *
   * Matching on the message text would break the moment someone rewords it. Ask the server instead.
   */
  async function sessionIsDead(): Promise<boolean> {
    if (!session) return true;
    // Free fast path for the ordinary case — no request needed to know a 30-day token has run out.
    if (isTokenExpired(session.token)) return true;
    try {
      await authApi.me(
        <T,>(path: string, opts: ApiFetchOptions = {}) =>
          // A no-op unauthorized handler: this probe decides what happens, and letting the fetcher's
          // handler sign out first would race the navigation below. `me()` already sends officeId: null.
          fetcher<T>(path, { ...opts, onUnauthorized: () => {} }),
        session.token,
      );
      return false;
    } catch (err) {
      // Only a 401 proves the session is dead. Offline or 5xx tells us nothing, and signing out on a
      // flaky connection would discard a perfectly good session.
      return err instanceof ApiError && err.status === 401;
    }
  }

  async function onSubmit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await fetcher("/auth/local/change-password", {
        method: "POST",
        body: { currentPassword: current, newPassword: next },
        // NO x-office-id. Changing a password is a global auth action, but authMiddleware resolves the
        // office header BEFORE it applies this route's change-password exemption (middleware/auth.ts
        // 73-81 vs 97-105). So a session still carrying a revoked secondary office gets
        // 403 "No access to requested office" before the password handler is ever reached — and cannot
        // clear that office either, because accessible-offices is itself blocked by the same gate. The
        // account would be permanently unable to complete a change the app insists on.
        officeId: null,
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
        // SESSION_INVALIDATED is definitive; an uncoded 401 is ambiguous and gets probed. See
        // sessionIsDead above for why the code alone is not enough.
        if (err.status === 401 && (err.code === "SESSION_INVALIDATED" || (await sessionIsDead()))) {
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
            // Explicit names + content types: the adjacent <Text> does not label a TextInput for a
            // screen reader, and without the hints iOS offers to save the OLD password as the new one.
            accessibilityLabel="Current password"
            textContentType="password"
            autoComplete="current-password"
            autoCapitalize="none"
            style={formStyles.input}
          />

          <Text style={formStyles.label}>New password</Text>
          <TextInput
            testID="new-password"
            value={next}
            onChangeText={setNext}
            secureTextEntry
            accessibilityLabel="New password"
            textContentType="newPassword"
            autoComplete="new-password"
            autoCapitalize="none"
            style={formStyles.input}
          />

          <Text style={formStyles.label}>Confirm new password</Text>
          <TextInput
            testID="confirm-password"
            value={confirm}
            onChangeText={setConfirm}
            secureTextEntry
            accessibilityLabel="Confirm new password"
            textContentType="newPassword"
            autoComplete="new-password"
            autoCapitalize="none"
            style={formStyles.input}
          />
          {/* A live region: these hints appear and disappear as the user types, and without this a
              screen reader never announces them — the button just stays disabled for no stated reason. */}
          <View accessible accessibilityLiveRegion="polite">
            {mismatch ? <Text style={formStyles.hint}>Passwords don&apos;t match.</Text> : null}
            {tooShort ? (
              <Text style={formStyles.hint}>Use at least {MIN_PASSWORD_LENGTH} characters.</Text>
            ) : null}
            {sameAsCurrent ? (
              <Text style={formStyles.hint}>Choose a password different from your current one.</Text>
            ) : null}
          </View>

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

          {/* Without this the screen is a trap. A forced-change session routes here exclusively, a wrong
              current password deliberately does NOT sign the user out, and relaunching restores the
              session and lands here again — so on a shared device one account stuck on this form locks
              every other person out of the app entirely. */}
          <Pressable
            testID="change-password-sign-out"
            onPress={async () => {
              await signOut();
              router.replace("/login");
            }}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Sign out"
            style={styles.signOut}
          >
            <Text style={styles.signOutText}>Sign out</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}


const styles = StyleSheet.create({
  signOut: { marginTop: theme.space.lg, alignItems: "center", paddingVertical: theme.space.md },
  signOutText: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.textSecondary },
});
