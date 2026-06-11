// T Rock brand tokens, transcribed from client-field/src/styles/globals.css
// (HSL CSS vars converted to hex):
//   --primary 0 72% 51%  → #DC2828 (T Rock red)
//   --foreground 220 18% 12% → #191D24
//   --muted-foreground 215 12% 37% → ~#566373
//   --border 214 20% 83% → ~#D4DBE3
export const theme = {
  color: {
    brandRed: "#DC2828",
    brandRedDark: "#BA1C1C",
    brandBlack: "#15181D",
    surfaceApp: "#F4F6F9",
    surfaceCard: "#FFFFFF",
    surfaceMuted: "#EEF2F6",
    textPrimary: "#191D24",
    textMuted: "#566373",
    textInverse: "#FFFFFF",
    border: "#D4DBE3",
    success: "#16A34A",
    warning: "#D97706",
    danger: "#BA1C1C",
    overlay: "rgba(15,17,21,0.94)",
  },
  font: {
    body: "Inter_400Regular",
    medium: "Inter_500Medium",
    semibold: "Inter_600SemiBold",
    bold: "Inter_700Bold",
  },
  space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  radius: { sm: 6, md: 10, lg: 16, pill: 999 },
} as const;

export type Theme = typeof theme;
