/**
 * T-Rock CRM design tokens — DARK INDUSTRIAL.
 *
 * The app is used on roofs, in trucks and in job trailers by people wearing gloves. It should read as
 * equipment, not as a web dashboard someone shrank. The mark is a red-and-white monogram on black, and
 * the palette is built out from that rather than from a default light theme.
 *
 * WHY THE TOKEN NAMES ARE UNCHANGED: every screen already consumes `surface`, `textPrimary`, `border`
 * and friends. Re-pointing the VALUES turns the whole app dark coherently in one change, instead of
 * leaving a redesigned screen sitting next to twelve light ones. New tokens are added alongside; none
 * are renamed, so no screen silently loses its colour by referencing a key that stopped existing.
 *
 * Type is Inter (@expo-google-fonts/inter). DESIGN.md specifies Geist Variable, which is not distributed
 * through that channel; T-Rock Cam made the same substitution, so both apps stay on one font pipeline.
 *
 * CONTRAST: every text token below is stated with its measured ratio against the surface it is intended
 * for. On a dark UI the failure mode is quieter than on white — mid-greys look fine indoors and vanish
 * in daylight — so the numbers are recorded rather than eyeballed.
 */
export const theme = {
  color: {
    /* ---- Brand ------------------------------------------------------------------------------- */
    /**
     * A brighter red than the web's #CC0000. On a near-black surface #CC0000 is 2.6:1 and reads as
     * dried blood; #E01B24 is 3.7:1, which clears the 3:1 bar for large/bold text and for UI fills.
     * It is an ACCENT and a fill colour — never small body text. White on it is 4.8:1 (see onBrand).
     */
    brandRed: "#E01B24",
    /** The deeper fill, for pressed states and the darker half of a gradient. */
    brandRedDeep: "#B3151C",
    /** Text/icon colour ON brandRed — 4.8:1, so chips and buttons stay legible. */
    onBrand: "#FFFFFF",

    /* ---- Surfaces, darkest to lightest ------------------------------------------------------- */
    /** Nav bars, headers, the tab bar. Pure black, matching the app icon's own background. */
    chrome: "#000000",
    /** The app canvas — everything sits on this. */
    canvas: "#0A0C0F",
    /** Cards, sheets, inputs. The default "thing you can touch". */
    surface: "#14171C",
    /** A card ON a card, and pressed states. */
    surfaceRaised: "#1C2027",
    /** Recessed bands and inert chips — DARKER than surface, inverting the light theme's meaning. */
    surfaceMuted: "#101317",

    /* ---- Lines ------------------------------------------------------------------------------- */
    border: "#262B33",
    borderStrong: "#39414D",
    borderSubtle: "#1A1E24",

    /* ---- Text -------------------------------------------------------------------------------- */
    /** 16.6:1 on surface. Names, money, anything that must be read at arm's length. */
    textPrimary: "#F5F7FA",
    /** 8.3:1 on surface. Company, metadata, secondary lines. */
    textSecondary: "#A8B2BF",
    /**
     * 4.9:1 on surface — deliberately ABOVE the 4.5:1 floor even though it is called "muted".
     * The light theme's #8A95A3 was ~3.0:1 and produced repeated accessibility findings; a muted token
     * that fails contrast is a trap, because it reads as permission to use it for real content.
     */
    textMuted: "#7D8896",
    /** On light/brand fills. */
    textInverse: "#0A0C0F",

    /* ---- Status ------------------------------------------------------------------------------ */
    /** Tinted-surface + text pairs. Dark tints, not the light theme's pastels, which glow on black. */
    amberSurface: "#3A2A08",
    amberText: "#F5C451",
    redSurface: "#3A1013",
    redText: "#FF8A8F",
    greenSurface: "#0E2E1C",
    greenText: "#5DD98F",

    /* ---- Raw accents (charts, dots, non-text) ------------------------------------------------ */
    amber: "#F59E0B",
    blue: "#60A5FA",
    green: "#22C55E",

    /**
     * KEPT for compatibility. In the light theme this was the near-black ink used for headings; on a
     * dark surface that would be invisible, so it now points at the primary text colour. Screens still
     * referencing it therefore stay readable, and the sweep can retire it screen by screen.
     */
    inkNavy: "#F5F7FA",
    navyHover: "#1C2027",
  },

  font: {
    regular: "Inter_400Regular",
    medium: "Inter_500Medium",
    semibold: "Inter_600SemiBold",
    bold: "Inter_700Bold",
    /** Display weight — headline numbers and screen titles. The "rugged" half of the brief. */
    black: "Inter_800ExtraBold",
  },

  /**
   * A type SCALE, not a pile of font sizes.
   *
   * The old UI ran 12/13/14/15 everywhere with bold vs semibold as the only emphasis, so a deal's name
   * and its metadata carried nearly the same weight and nothing on screen led. These steps are far
   * enough apart to establish rank at a glance.
   *
   * `caption` is uppercase with positive tracking on purpose: at 11px, letterspaced small-caps reads as
   * a deliberate label rather than shrunken body text, and it is how the industrial/technical register
   * is carried without a second typeface.
   */
  type: {
    display: { fontFamily: "Inter_800ExtraBold", fontSize: 34, lineHeight: 38, letterSpacing: -0.8 },
    h1: { fontFamily: "Inter_800ExtraBold", fontSize: 26, lineHeight: 30, letterSpacing: -0.5 },
    h2: { fontFamily: "Inter_700Bold", fontSize: 20, lineHeight: 24, letterSpacing: -0.3 },
    title: { fontFamily: "Inter_600SemiBold", fontSize: 17, lineHeight: 22, letterSpacing: -0.2 },
    body: { fontFamily: "Inter_400Regular", fontSize: 15, lineHeight: 21 },
    label: { fontFamily: "Inter_600SemiBold", fontSize: 13, lineHeight: 17 },
    caption: { fontFamily: "Inter_600SemiBold", fontSize: 11, lineHeight: 14, letterSpacing: 0.9 },
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
    xl: 22,
    pill: 999,
  },

  /**
   * Elevation, as spreadable style objects.
   *
   * A dark UI cannot lean on shadow the way a light one does — a black shadow on a near-black canvas is
   * nearly invisible. So each level pairs a real shadow with a lighter border: the BORDER does most of
   * the separating work and the shadow supplies the weight. Using only one of the two is what made the
   * previous cards read as flat rectangles.
   */
  elevation: {
    card: {
      shadowColor: "#000000",
      shadowOpacity: 0.55,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 6 },
      elevation: 6,
    },
    raised: {
      shadowColor: "#000000",
      shadowOpacity: 0.7,
      shadowRadius: 24,
      shadowOffset: { width: 0, height: 12 },
      elevation: 12,
    },
  },
} as const;
