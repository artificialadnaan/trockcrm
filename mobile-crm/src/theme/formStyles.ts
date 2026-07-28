import { StyleSheet } from "react-native";
import { theme } from "./theme";

/**
 * Shared styles for the two credential screens (login, change-password).
 *
 * They were duplicated and had already drifted — one had a background colour on its inputs and the other
 * did not — which is exactly how two screens that should look identical stop looking identical. Screen-
 * specific bits stay in the screens; only what must MATCH lives here.
 */
export const formStyles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surface },
  flex: { flex: 1 },
  centre: { flex: 1, alignItems: "center", justifyContent: "center" },
  body: { padding: theme.space.xl, flexGrow: 1, justifyContent: "center" },
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
    // borderControl, not border: this hairline IS the credential field. See the token's note.
    borderColor: theme.color.borderControl,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.md,
    fontFamily: theme.font.regular,
    fontSize: 16,
    color: theme.color.textPrimary,
    backgroundColor: theme.color.surface,
  },
  hint: {
    fontFamily: theme.font.regular,
    fontSize: 13,
    color: theme.color.redText,
    marginTop: theme.space.xs,
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
    backgroundColor: theme.color.redSurface,
    borderColor: theme.color.brandRed,
    borderWidth: 1,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
    marginBottom: theme.space.sm,
  },
  errorText: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.redText },
});
