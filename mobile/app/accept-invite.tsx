import React, { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../src/auth/AuthContext";
import { ApiError } from "../src/api/client";
import { theme } from "../src/theme/theme";
import { Button, LoadingState, TextInput } from "../src/components/ui";
import { Banner } from "../src/components/Banner";
import { BrandLogo } from "../src/components/BrandLogo";

const MIN_PASSWORD = 8;

/** Invite-accept deep-link target: trockcam://accept-invite?token=… */
export default function AcceptInvite() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  const { previewInvite, acceptInvite } = useAuth();
  const router = useRouter();

  const [preview, setPreview] = useState<{ firstName: string; lastName: string; email: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(true);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    if (!token) {
      setPreviewError("This invitation link is missing its token.");
      setLoadingPreview(false);
      return;
    }
    void previewInvite(token)
      .then((data) => {
        if (active) setPreview(data);
      })
      .catch((e) => {
        if (active) setPreviewError(e instanceof ApiError ? e.message : "This invitation is invalid or has expired.");
      })
      .finally(() => {
        if (active) setLoadingPreview(false);
      });
    return () => {
      active = false;
    };
  }, [token, previewInvite]);

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit = !!token && password.length >= MIN_PASSWORD && confirm === password;

  async function onSubmit() {
    if (!canSubmit || !token || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await acceptInvite(token, password);
      router.replace("/(app)/projects");
    } catch (e) {
      if (e instanceof ApiError && e.status === 423) {
        setError("Too many attempts — your account is temporarily locked. Try again in a few minutes.");
      } else {
        setError(e instanceof ApiError ? e.message : "Could not accept the invitation.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.logo}>
            <BrandLogo size={64} />
          </View>

          {loadingPreview ? (
            <LoadingState label="Loading invitation…" />
          ) : previewError ? (
            <View style={styles.card}>
              <Banner message={previewError} />
              <View style={{ height: theme.space.sm }} />
              <Button title="Back to sign in" variant="ghost" onPress={() => router.replace("/login")} />
            </View>
          ) : (
            <View style={styles.card}>
              <Text style={styles.welcome}>
                Welcome{preview?.firstName ? `, ${preview.firstName}` : ""}!
              </Text>
              {preview?.email ? <Text style={styles.email}>{preview.email}</Text> : null}
              {error ? <Banner message={error} /> : null}

              <Text style={styles.label}>Create a password</Text>
              <TextInput
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                placeholder="At least 8 characters"
                autoComplete="password-new"
              />
              <Text style={[styles.hint, tooShort && { color: theme.color.danger }]}>
                {tooShort ? `Use at least ${MIN_PASSWORD} characters.` : `Minimum ${MIN_PASSWORD} characters.`}
              </Text>

              <Text style={styles.label}>Confirm password</Text>
              <TextInput
                value={confirm}
                onChangeText={setConfirm}
                secureTextEntry
                placeholder="Re-enter password"
                onSubmitEditing={onSubmit}
                returnKeyType="go"
              />
              {mismatch ? <Text style={[styles.hint, { color: theme.color.danger }]}>Passwords don't match.</Text> : null}

              <View style={{ height: theme.space.md }} />
              <Button title="Accept invitation" onPress={onSubmit} loading={submitting} disabled={!canSubmit} />
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceApp },
  scroll: { flexGrow: 1, justifyContent: "center", padding: theme.space.xl, gap: theme.space.lg },
  logo: { alignItems: "center" },
  card: {
    backgroundColor: theme.color.surfaceCard,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space.xl,
    gap: theme.space.sm,
  },
  welcome: { fontFamily: theme.font.bold, fontSize: 20, color: theme.color.textPrimary },
  email: { fontFamily: theme.font.body, fontSize: 14, color: theme.color.textMuted, marginBottom: theme.space.sm },
  label: { fontFamily: theme.font.medium, fontSize: 13, color: theme.color.textMuted, marginTop: theme.space.sm },
  hint: { fontFamily: theme.font.body, fontSize: 12, color: theme.color.textMuted },
});
