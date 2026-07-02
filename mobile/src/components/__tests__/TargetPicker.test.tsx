import React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import { TargetPicker } from "../TargetPicker";
import type { FieldCaptureTarget } from "../../api/types";

const mockUseCaptureTargets = jest.fn();
const mockUseNearbyCaptureTargets = jest.fn();
const mockGetLiveGps = jest.fn();

jest.mock("../../hooks/useDebouncedValue", () => ({
  useDebouncedValue: (value: string) => value,
}));

jest.mock("../../query/hooks", () => ({
  useCaptureTargets: (...args: unknown[]) => mockUseCaptureTargets(...args),
  useNearbyCaptureTargets: (...args: unknown[]) => mockUseNearbyCaptureTargets(...args),
}));

jest.mock("../../capture/metadata", () => ({
  getLiveGps: (...args: unknown[]) => mockGetLiveGps(...args),
}));

jest.mock("react-native-safe-area-context", () => {
  const React = require("react");
  const { View } = require("react-native");

  return {
    SafeAreaView: ({ children, ...props }: { children: React.ReactNode }) => <View {...props}>{children}</View>,
  };
});

const nearbyDeal: FieldCaptureTarget = {
  id: "deal-1",
  type: "deal",
  name: "121 Preston Oaks",
  recordNumber: "DFW-1-17426-aa",
  stageName: "Construction",
  companyName: "Preston Oaks HOA",
  lastUpdatedAt: "2026-06-20T12:00:00.000Z",
  distanceMiles: 0.42,
};

const searchLead: FieldCaptureTarget = {
  id: "lead-1",
  type: "lead",
  name: "Oak Creek Lead",
  recordNumber: null,
  stageName: "New Lead",
  companyName: "Oak Creek",
  lastUpdatedAt: "2026-06-21T12:00:00.000Z",
};

function renderPicker(onSelect = jest.fn()) {
  return {
    onSelect,
    screen: render(<TargetPicker visible onClose={jest.fn()} onSelect={onSelect} />),
  };
}

async function flushGpsEffect() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("TargetPicker nearby defaults", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockGetLiveGps.mockResolvedValue({ latitude: 32.911, longitude: -96.775, takenAt: "2026-06-23T14:00:00.000Z" });
    mockUseCaptureTargets.mockReturnValue({ data: { targets: [] }, isFetching: false });
    mockUseNearbyCaptureTargets.mockReturnValue({ data: { targets: [nearbyDeal] }, isFetching: false });
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  it("shows nearby deal/project jobs while the search box is empty", async () => {
    const { onSelect, screen } = renderPicker();

    await flushGpsEffect();
    expect(mockUseNearbyCaptureTargets).toHaveBeenLastCalledWith({ latitude: 32.911, longitude: -96.775 }, true, 3);

    expect(screen.getByText("Closest jobs")).toBeTruthy();
    expect(screen.getByText("121 Preston Oaks")).toBeTruthy();
    expect(screen.getByText(/0.4 mi/)).toBeTruthy();
    expect(screen.getByText(/DFW-1-17426-aa/)).toBeTruthy();

    fireEvent.press(screen.getByText("121 Preston Oaks"));
    expect(onSelect).toHaveBeenCalledWith(nearbyDeal);
  });

  it("keeps typed search on the existing broad target search results", async () => {
    mockUseCaptureTargets.mockReturnValue({ data: { targets: [searchLead] }, isFetching: false });
    const { screen } = renderPicker();

    await flushGpsEffect();
    expect(mockUseNearbyCaptureTargets).toHaveBeenLastCalledWith({ latitude: 32.911, longitude: -96.775 }, true, 3);

    fireEvent.changeText(screen.getByPlaceholderText("Search deals, opportunities, leads"), "oak");

    expect(mockUseCaptureTargets).toHaveBeenLastCalledWith("oak", false); // default picker: dealsOnly = false
    expect(screen.queryByText("121 Preston Oaks")).toBeNull();
    expect(screen.getByText("Oak Creek Lead")).toBeTruthy();
    expect(screen.getByText("Lead")).toBeTruthy();
  });

  it("falls back to manual search when GPS coordinates are unavailable", async () => {
    mockGetLiveGps.mockResolvedValue({ takenAt: "2026-06-23T14:00:00.000Z" });
    mockUseNearbyCaptureTargets.mockReturnValue({ data: { targets: [] }, isFetching: false });
    const { screen } = renderPicker();

    await flushGpsEffect();

    expect(screen.getByText("Search to begin")).toBeTruthy();
    expect(screen.getByText("Type a project name or number.")).toBeTruthy();
    expect(screen.queryByText("Closest jobs")).toBeNull();
    expect(screen.queryByText("121 Preston Oaks")).toBeNull();
  });

  it("does not request GPS when the picker reopens with an active manual search", async () => {
    const onClose = jest.fn();
    const onSelect = jest.fn();
    const screen = render(<TargetPicker visible onClose={onClose} onSelect={onSelect} />);

    await flushGpsEffect();
    expect(mockGetLiveGps).toHaveBeenCalledTimes(1);

    fireEvent.changeText(screen.getByPlaceholderText("Search deals, opportunities, leads"), "oak");
    screen.rerender(<TargetPicker visible={false} onClose={onClose} onSelect={onSelect} />);
    screen.rerender(<TargetPicker visible onClose={onClose} onSelect={onSelect} />);
    await flushGpsEffect();

    expect(mockUseCaptureTargets).toHaveBeenLastCalledWith("oak", false); // default picker: dealsOnly = false
    expect(mockGetLiveGps).toHaveBeenCalledTimes(1);
  });
});

describe("TargetPicker dealsOnly (scorecard)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockGetLiveGps.mockResolvedValue({ latitude: 32.911, longitude: -96.775, takenAt: "2026-06-23T14:00:00.000Z" });
    mockUseNearbyCaptureTargets.mockReturnValue({ data: { targets: [] }, isFetching: false });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("passes dealsOnly=true to the search hook (server filters before the cap) and drops any stray non-deal", () => {
    mockUseCaptureTargets.mockReturnValue({ data: { targets: [nearbyDeal, searchLead] }, isFetching: false });
    const screen = render(<TargetPicker visible dealsOnly onClose={jest.fn()} onSelect={jest.fn()} />);
    fireEvent.changeText(screen.getByPlaceholderText("Search projects"), "oak");
    expect(mockUseCaptureTargets).toHaveBeenLastCalledWith("oak", true);
    expect(screen.getByText("121 Preston Oaks")).toBeTruthy(); // the deal shows
    expect(screen.queryByText("Oak Creek Lead")).toBeNull(); // client fallback drops a stray lead
  });
});
