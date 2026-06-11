import React, { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../src/auth/AuthContext";
import { ApiError } from "../src/api/client";
import { theme } from "../src/theme/theme";
import { Button, TextInput } from "../src/components/ui";
import { Banner } from "../src/components/Banner";
import { BrandLogo } from "../src/components/BrandLogo";

export default function Login() {
  const { signIn } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const canSubmit = email.trim().length > 0 && password.length > 0;

  async function onSubmit() {
    if (!canSubmit || loading) return;
    setError(null);
    setLoading(true);
    try {
      await signIn(email.trim(), password);
      router.replace("/(app)/projects");
    } catch (e) {
      if (e instanceof ApiError && e.status === 423) {
        setError("Too many attempts — your account is temporarily locked. Try again in a few minutes.");
      } else if (e instanceof ApiError && e.status === 401) {
        setError("Incorrect email or password.");
      } else {
        setError(e instanceof ApiError ? e.message : "Could not sign in. Check your connection.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.logo}>
            <BrandLogo size={72} />
          </View>
          <Text style={styles.subtitle}>Field sign in</Text>

          <View style={styles.card}>
            {error ? <Banner message={error} /> : null}

            <Text style={styles.label}>Email</Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              placeholder="you@trockgc.com"
            />

            <Text style={styles.label}>Password</Text>
            <TextInput
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="password"
              placeholder="••••••••"
              onSubmitEditing={onSubmit}
              returnKeyType="go"
            />

            <View style={{ height: theme.space.md }} />
            <Button title="Sign in" onPress={onSubmit} loading={loading} disabled={!canSubmit} />
          </View>

          <Text style={styles.hint}>
            Invited to T-Rock Cam? Open the invitation link from your email on this device.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceApp },
  scroll: { flexGrow: 1, justifyContent: "center", padding: theme.space.xl, gap: theme.space.md },
  logo: { alignItems: "center" },
  subtitle: { textAlign: "center", fontFamily: theme.font.body, fontSize: 14, color: theme.color.textMuted },
  card: {
    backgroundColor: theme.color.surfaceCard,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space.xl,
    gap: theme.space.sm,
  },
  label: { fontFamily: theme.font.medium, fontSize: 13, color: theme.color.textMuted, marginTop: theme.space.sm },
  hint: { textAlign: "center", fontFamily: theme.font.body, fontSize: 13, color: theme.color.textMuted, paddingHorizontal: theme.space.lg },
});
