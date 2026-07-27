/**
 * T-Rock CRM design tokens.
 *
 * These are the CRM palette from the repo-root DESIGN.md — NOT T-Rock Cam's field palette
 * (mobile/src/theme/theme.ts, whose red is #DC2828 on a dark field surface). This app is the CRM on a
 * phone and should read as the CRM.
 *
 * Type is Inter via @expo-google-fonts/inter. DESIGN.md specifies Geist Variable, which is not
 * distributed through that channel; T-Rock Cam made the same substitution, so both apps stay on one
 * font pipeline rather than one app bundling a second font loader.
 */
export const theme = {
  color: {
    brandRed: "#CC0000",
    brandRedDeep: "#990000",
    inkNavy: "#0F172A",
    navyHover: "#1E293B",
    textPrimary: "#111827",
    textSecondary: "#4B5563",
    textMuted: "#8A95A3",
    textInverse: "#FFFFFF",
    border: "#DDE2E8",
    borderSubtle: "#EEF1F4",
    surface: "#FFFFFF",
    surfaceMuted: "#F5F6F8",
    /**
     * Status badge tones. Defined here rather than inline so the "On hold" and "At risk" badges cannot
     * drift between the card and the detail screen — they were the same three hex literals copy-pasted
     * into two files, which is how two surfaces end up disagreeing about what amber means.
     */
    amberSurface: "#FEF3C7",
    amberText: "#92400E",
    redSurface: "#FEE2E2",
    // The green badge pair, added when the "Converted" tone arrived. It lived as two hex literals in
    // Badge.tsx under a comment claiming they came from the palette — which is the duplication this
    // block exists to prevent, one file away from where it is described.
    greenSurface: "#DCFCE7",
    greenText: "#166534",
    amber: "#F59E0B",
    blue: "#3B82F6",
    green: "#22C55E",
  },
  font: {
    regular: "Inter_400Regular",
    semibold: "Inter_600SemiBold",
    bold: "Inter_700Bold",
  },
  space: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
    xxl: 32,
  },
  radius: {
    sm: 6,
    md: 10,
    lg: 16,
    pill: 999,
  },
} as const;
