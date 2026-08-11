/**
 * That BOTH pairing-callback paths in the root layout go through `deliverPairingUrl`.
 *
 * The two paths are not interchangeable and neither is optional: a COLD return from the Meta AI app
 * (iOS terminated us mid-pairing) arrives as `getInitialURL()`, a WARM one as a live `url` event. The
 * original defect existed in both, and a fix applied to one of them looks complete from every angle
 * except the one the user is standing in. `pairing-callback.test.ts` covers what the policy DOES;
 * this covers that the layout actually reaches it, on both paths, rather than calling the SDK itself.
 *
 * Fonts are mocked unloaded so `RootLayout` renders null: the effects under test run above that early
 * return (they must, or hook order would shift), so the whole provider tree never has to be stood up
 * to observe them.
 */
import React from "react";
import { render, waitFor } from "@testing-library/react-native";

const mockDeliverPairingUrl = jest.fn();
const mockEnsureWearablesConfigured = jest.fn();
const mockGetInitialURL = jest.fn();
const mockRemove = jest.fn();
let urlListener: ((event: { url: string }) => void) | null = null;

jest.mock("expo-linking", () => ({
  getInitialURL: () => mockGetInitialURL(),
  addEventListener: (_type: string, listener: (event: { url: string }) => void) => {
    urlListener = listener;
    return { remove: mockRemove };
  },
}));

jest.mock("../native", () => ({ isAvailable: true }));

jest.mock("../pairing-callback", () => ({
  deliverPairingUrl: (url: string) => mockDeliverPairingUrl(url),
  ensureWearablesConfigured: () => mockEnsureWearablesConfigured(),
}));

// Unloaded, so the layout returns null before the provider tree renders.
jest.mock("@expo-google-fonts/inter", () => ({
  useFonts: () => [false],
  Inter_400Regular: "Inter_400Regular",
  Inter_500Medium: "Inter_500Medium",
  Inter_600SemiBold: "Inter_600SemiBold",
  Inter_700Bold: "Inter_700Bold",
}));

jest.mock("expo-router", () => ({
  Stack: Object.assign(() => null, { Screen: () => null }),
}));

jest.mock("../../auth/AuthContext", () => ({ AuthProvider: ({ children }: { children?: React.ReactNode }) => children }));
jest.mock("../../components/ErrorBoundary", () => ({
  ErrorBoundary: ({ children }: { children?: React.ReactNode }) => children,
}));
// Side-effect imports that register OS background tasks at module load; nothing here exercises them.
jest.mock("../../capture/upload-background-task", () => ({}));
jest.mock("../../walkthrough/upload-background-task", () => ({}));

// eslint-disable-next-line import/first
import RootLayout from "../../../app/_layout";

const COLD_URL = "trockcam://wearables/callback?state=cold";
const WARM_URL = "trockcam://wearables/callback?state=warm";

beforeEach(() => {
  jest.clearAllMocks();
  urlListener = null;
  mockGetInitialURL.mockResolvedValue(null);
  mockEnsureWearablesConfigured.mockResolvedValue(true);
  mockDeliverPairingUrl.mockResolvedValue(undefined);
});

it("REGRESSION: a COLD-start callback goes through deliverPairingUrl, not straight to the SDK", async () => {
  mockGetInitialURL.mockResolvedValue(COLD_URL);

  render(<RootLayout />);

  await waitFor(() => expect(mockDeliverPairingUrl).toHaveBeenCalledWith(COLD_URL));
  expect(mockDeliverPairingUrl).toHaveBeenCalledTimes(1);
});

it("REGRESSION: a WARM callback delivered as a live url event goes through the same path", async () => {
  render(<RootLayout />);

  await waitFor(() => expect(urlListener).not.toBeNull());
  urlListener!({ url: WARM_URL });

  await waitFor(() => expect(mockDeliverPairingUrl).toHaveBeenCalledWith(WARM_URL));
});

it("GUARD: no initial URL means nothing is delivered — an empty launch is not a pairing callback", async () => {
  render(<RootLayout />);

  await waitFor(() => expect(mockGetInitialURL).toHaveBeenCalled());
  expect(mockDeliverPairingUrl).not.toHaveBeenCalled();
});

it("GUARD: configuration is still started at launch, with or without a callback", async () => {
  // The reason this runs unconditionally: a user can go from a project straight to Capture without
  // ever visiting Profile, and an unconfigured SDK selects no device — the walk then fails after 8s
  // blaming the glasses for a step the app skipped.
  render(<RootLayout />);

  await waitFor(() => expect(mockEnsureWearablesConfigured).toHaveBeenCalled());
});

it("GUARD: the url listener is removed on unmount", async () => {
  const view = render(<RootLayout />);
  await waitFor(() => expect(urlListener).not.toBeNull());

  view.unmount();

  expect(mockRemove).toHaveBeenCalled();
});
