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
/**
 * Font families, named once.
 *
 * Declared above the theme so `type` can REFERENCE them instead of repeating the literal strings — the
 * scale and the family list drifting apart is a silent failure (text falls back to the system font and
 * simply looks slightly wrong, with nothing to catch it).
 */
const FONT = {
  regular: "Inter_400Regular",
  medium: "Inter_500Medium",
  semibold: "Inter_600SemiBold",
  bold: "Inter_700Bold",
  /** Display weight — headline numbers and screen titles. The "rugged" half of the brief. */
  black: "Inter_800ExtraBold",
} as const;

export const theme = {
  color: {
    /* ---- Brand ------------------------------------------------------------------------------- */
    /**
     * A FILL, never type.
     *
     * Brighter than the web's #CC0000, which is 2.6:1 on near-black and reads as dried blood. #E01B24
     * is 3.7:1 — enough for a fill or a rule, and NOT enough for the 13-15px back-links, retry labels
     * and call buttons that were using it. Red type uses `redText`; this colour fills the shape behind
     * white (`onBrand`, 4.8:1).
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
    /**
     * Text ON A FILLED CONTROL — which in this app means brand red, every time.
     *
     * WHITE, not the near-black that "inverse" suggests. Every primary button in the app (login,
     * change password, onboarding, save note, contacts action, the move commit, and the shared
     * formStyles.button) is `textInverse` on `brandRed`. Pointing this at the canvas colour made all
     * ten of them near-black on red at ~3.2:1 — the login button, the first thing anyone sees, became
     * the least readable control in the product.
     *
     * That was the cost of re-pointing a token by its NAME rather than by its call sites: "inverse of
     * the text colour" is a description of the light theme, and the actual usage is "on a brand fill".
     * White on #E01B24 is 4.83:1. Identical to `onBrand`, and kept as a separate name only because a
     * dozen call sites already say `textInverse`; the sweep collapses them.
     */
    textInverse: "#FFFFFF",

    /* ---- Status ------------------------------------------------------------------------------ */
    /** Tinted-surface + text pairs. Dark tints, not the light theme's pastels, which glow on black. */
    amberSurface: "#3A2A08",
    amberText: "#F5C451",
    // Chip borders. A tinted fill alone is nearly edgeless on a dark card, so each status pair carries
    // its own border a step lighter than the fill — tokenised here rather than left as literals in
    // Badge.tsx, which is the duplication that file exists to prevent.
    amberBorder: "#5A4210",
    redBorder: "#5C1A1F",
    greenBorder: "#17492C",
    redSurface: "#3A1013",
    /**
     * EVERY red that is TYPE. One token, one rule.
     *
     * Not just the status chip: back chevrons, retry labels, the "Call" action, board links and inline
     * error text all used `brandRed` or `brandRedDeep` at 13-15px, which on this palette is 3.7:1 and
     * 2.4:1 respectively — the error text inside `formStyles.errorBox` was the worst of them, red on a
     * red tint. Splitting "red I fill with" from "red I set type in" is what makes both safe;
     * 7.9:1 on surface, 9.3:1 on chrome, 7.4:1 on redSurface.
     */
    redText: "#FF8A8F",
    greenSurface: "#0E2E1C",
    greenText: "#5DD98F",

    /* ---- Raw accents (charts, dots, non-text) ------------------------------------------------ */
    amber: "#F59E0B",
    blue: "#60A5FA",
    green: "#22C55E",

    /**
     * KEPT for compatibility, as a TEXT colour only.
     *
     * In the light theme this was the near-black ink used for headings, and on a dark surface that is
     * invisible — so it now points at the primary text colour and its ~17 heading call sites stay
     * readable until the sweep retires them.
     *
     * The catch, and the reason this is spelled out: two screens also used it as a BACKGROUND (the
     * active scope pill on the deals and leads lists). A token used for both roles cannot survive a
     * re-point — inverting it fixes the text and breaks the fill in the same edit. Those two sites now
     * use `surfaceRaised`; do not reintroduce `inkNavy` as a fill.
     */
    inkNavy: "#F5F7FA",
    navyHover: "#1C2027",
  },

  font: FONT,

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
    display: { fontFamily: FONT.black, fontSize: 34, lineHeight: 38, letterSpacing: -0.8 },
    h1: { fontFamily: FONT.black, fontSize: 26, lineHeight: 30, letterSpacing: -0.5 },
    h2: { fontFamily: FONT.bold, fontSize: 20, lineHeight: 24, letterSpacing: -0.3 },
    title: { fontFamily: FONT.semibold, fontSize: 17, lineHeight: 22, letterSpacing: -0.2 },
    body: { fontFamily: FONT.regular, fontSize: 15, lineHeight: 21 },
    label: { fontFamily: FONT.semibold, fontSize: 13, lineHeight: 17 },
    caption: { fontFamily: FONT.semibold, fontSize: 11, lineHeight: 14, letterSpacing: 0.9 },
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
   * nearly invisible. Separation therefore takes BOTH a shadow and a lighter border, and the border is
   * doing most of that work. These tokens carry only the shadow half; the border belongs to the
   * component, because its colour and width vary by state (a pressed card moves to `borderStrong`).
   * Spreading one of these WITHOUT also setting a border is what made the previous cards read as flat
   * rectangles, so treat them as half of a pair rather than a complete recipe.
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
