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
import { NoAccessibleSurfaceError, RoleNotAllowedError, useAuth } from "../src/auth/AuthContext";
import { formStyles } from "../src/theme/formStyles";
import { theme } from "../src/theme/theme";

/** Turn a failure into something a rep on a roof can act on, rather than a status code. */
function messageFor(err: unknown): string {
  if (err instanceof RoleNotAllowedError) return err.message;
  // Valid credentials, valid CRM user, but no surface in THIS app — say so and name the app they want,
  // rather than a generic failure that reads as "your password is wrong".
  if (err instanceof NoAccessibleSurfaceError) return err.message;
  if (err instanceof ApiError) {
    // status 0 covers BOTH a transport failure and a build with no API host configured. They need
    // different words: retrying fixes the first and can never fix the second, so a misconfigured
    // TestFlight build must not read as an ordinary outage.
    if (err.status === 0) {
      if (err.message.startsWith("EXPO_PUBLIC_API_BASE_URL")) return err.message;
      return "Can't reach the server. Check your connection and try again.";
    }
    if (err.status === 401) return "Incorrect email or password.";
    if (err.status === 423) return "Too many attempts. Try again in a few minutes.";
    if (err.status === 403) return err.message;
    return err.message;
  }
  return "Something went wrong. Try again.";
}

export default function LoginScreen() {
  const router = useRouter();
  const { signIn, signOutIncomplete } = useAuth();
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
    <SafeAreaView style={formStyles.safe}>
      <KeyboardAvoidingView style={formStyles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={formStyles.body} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>T-Rock CRM</Text>
          <Text style={formStyles.subtitle}>Sign in with your CRM account.</Text>

          {error ? (
            <View style={formStyles.errorBox} accessibilityRole="alert">
              <Text style={formStyles.errorText}>{error}</Text>
            </View>
          ) : null}

          {/* The previous sign-out could not erase the stored credential, so it is still on this device
              and a relaunch would restore that account. Saying nothing would let someone hand the phone
              over believing it was cleared — the one situation where silence is the actual harm. */}
          {signOutIncomplete ? (
            <View testID="sign-out-incomplete" style={formStyles.errorBox} accessibilityRole="alert">
              <Text style={formStyles.errorText}>
                The previous account could not be fully removed from this device. Keep the app open — it
                is still retrying — and avoid handing this phone to someone else until this clears.
              </Text>
            </View>
          ) : null}

          <Text style={formStyles.label}>Email</Text>
          <TextInput
            testID="login-email"
            // The adjacent <Text> does not label a TextInput for a screen reader — RN has no implicit
            // label association — so without this the field is announced as an unlabelled text box.
            accessibilityLabel="Email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
            autoComplete="email"
            style={formStyles.input}
            placeholderTextColor={theme.color.textMuted}
            placeholder="you@trockgc.com"
          />

          <Text style={formStyles.label}>Password</Text>
          <TextInput
            testID="login-password"
            accessibilityLabel="Password"
            value={secret}
            onChangeText={setSecret}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="password"
            autoComplete="current-password"
            style={formStyles.input}
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
            style={[formStyles.button, !canSubmit && formStyles.buttonDisabled]}
          >
            {busy ? (
              <ActivityIndicator color={theme.color.textInverse} />
            ) : (
              <Text style={formStyles.buttonText}>Sign in</Text>
            )}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// Login's headline is larger than the shared form title — the only intentional divergence.
const styles = StyleSheet.create({
  title: { fontFamily: theme.font.bold, fontSize: 28, color: theme.color.inkNavy },
});
