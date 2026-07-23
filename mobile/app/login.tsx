import React, { useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../src/auth/AuthContext";
import { ApiError } from "../src/api/client";
import { resolvePostLoginHref } from "../src/navigation/return-to";
import { theme } from "../src/theme/theme";
import { Button, TextInput } from "../src/components/ui";
import { Banner } from "../src/components/Banner";
import { BrandLogo } from "../src/components/BrandLogo";

export default function Login() {
  const { signIn } = useAuth();
  const router = useRouter();
  // The (app) layout stashes the blocked destination here when a deep link (e.g. corrective-action) forces a
  // login; on success we return there, falling back to projects when there's no pending destination.
  const { returnTo } = useLocalSearchParams<{ returnTo?: string }>();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const passwordRef = useRef<React.ElementRef<typeof TextInput>>(null);
  const [showPassword, setShowPassword] = useState(false);

  const canSubmit = email.trim().length > 0 && password.length > 0;

  async function onSubmit() {
    if (!canSubmit || loading) return;
    setError(null);
    setLoading(true);
    try {
      await signIn(email.trim(), password);
      router.replace(resolvePostLoginHref(returnTo));
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
      {/* automaticallyAdjustKeyboardInsets (not a padding KAV) keeps the centered card
          from jumping/clipping when the keyboard opens (#55); on-drag dismisses it. */}
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
      >
        <View style={styles.logo}>
          <BrandLogo size={72} />
        </View>
        <Text style={styles.title}>Sign in</Text>
        <Text style={styles.subtitle}>Field crew access</Text>

        <View style={styles.card}>
          {error ? <Banner message={error} /> : null}

          <Text style={styles.label}>Email</Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            textContentType="username"
            accessibilityLabel="Email"
            placeholder="you@trockgc.com"
            returnKeyType="next"
            onSubmitEditing={() => passwordRef.current?.focus()}
            submitBehavior="submit"
          />

          <Text style={styles.label}>Password</Text>
          <View style={styles.passwordWrap}>
            <TextInput
              ref={passwordRef}
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPassword}
              autoComplete="password"
              textContentType="password"
              accessibilityLabel="Password"
              onSubmitEditing={onSubmit}
              returnKeyType="go"
              style={styles.passwordInput}
            />
            <Pressable
              onPress={() => setShowPassword((s) => !s)}
              hitSlop={8}
              style={styles.eye}
              accessibilityRole="button"
              accessibilityLabel={`${showPassword ? "Hide" : "Show"} password`}
            >
              <Ionicons name={showPassword ? "eye-off-outline" : "eye-outline"} size={22} color={theme.color.textMuted} />
            </Pressable>
          </View>

          <Button title="Sign in" onPress={onSubmit} loading={loading} disabled={!canSubmit} style={styles.submit} />
        </View>

        <Text style={styles.hint}>
          Invited to T-Rock Cam? Open the invitation link from your email on this device.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceApp },
  scroll: { flexGrow: 1, justifyContent: "center", padding: theme.space.xl, gap: theme.space.md },
  logo: { alignItems: "center" },
  submit: { marginTop: theme.space.sm },
  title: { textAlign: "center", fontFamily: theme.font.bold, fontSize: 24, color: theme.color.textPrimary },
  subtitle: { textAlign: "center", fontFamily: theme.font.body, fontSize: 14, color: theme.color.textMuted },
  passwordWrap: { position: "relative", justifyContent: "center" },
  passwordInput: { paddingRight: 44 },
  eye: { position: "absolute", right: theme.space.md, padding: 4 },
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
