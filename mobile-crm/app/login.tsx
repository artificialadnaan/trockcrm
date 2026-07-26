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
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { ApiError } from "../src/api/client";
import { RoleNotAllowedError, useAuth } from "../src/auth/AuthContext";
import { theme } from "../src/theme/theme";

/** Turn a failure into something a rep on a roof can act on, rather than a status code. */
function messageFor(err: unknown): string {
  if (err instanceof RoleNotAllowedError) return err.message;
  if (err instanceof ApiError) {
    // 0 is the client's transport-failure code (offline, DNS, refused) — the common job-site case, and
    // worth distinguishing from "wrong password" so nobody retypes a correct one five times.
    if (err.status === 0) return "Can't reach the server. Check your connection and try again.";
    if (err.status === 401) return "Incorrect email or password.";
    if (err.status === 423) return "Too many attempts. Try again in a few minutes.";
    if (err.status === 403) return err.message;
    return err.message;
  }
  return "Something went wrong. Try again.";
}

export default function LoginScreen() {
  const router = useRouter();
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = email.trim().length > 0 && secret.length > 0 && !busy;

  async function onSubmit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await signIn({ email: email.trim(), password: secret });
      router.replace("/");
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>T-Rock CRM</Text>
          <Text style={styles.subtitle}>Sign in with your CRM account.</Text>

          {error ? (
            <View style={styles.errorBox} accessibilityRole="alert">
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <Text style={styles.label}>Email</Text>
          <TextInput
            testID="login-email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
            style={styles.input}
            placeholderTextColor={theme.color.textMuted}
            placeholder="you@trockgc.com"
          />

          <Text style={styles.label}>Password</Text>
          <TextInput
            testID="login-password"
            value={secret}
            onChangeText={setSecret}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="password"
            style={styles.input}
            placeholderTextColor={theme.color.textMuted}
            onSubmitEditing={onSubmit}
            returnKeyType="go"
          />

          <Pressable
            testID="login-submit"
            onPress={onSubmit}
            disabled={!canSubmit}
            accessibilityRole="button"
            accessibilityLabel="Sign in"
            style={[styles.button, !canSubmit && styles.buttonDisabled]}
          >
            {busy ? (
              <ActivityIndicator color={theme.color.textInverse} />
            ) : (
              <Text style={styles.buttonText}>Sign in</Text>
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
  body: { padding: theme.space.xl, gap: theme.space.sm, flexGrow: 1, justifyContent: "center" },
  title: { fontFamily: theme.font.bold, fontSize: 28, color: theme.color.inkNavy },
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
    backgroundColor: theme.color.surface,
  },
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
