import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";

const mockCameraProps: Record<string, unknown>[] = [];
const mockTakePictureAsync = jest.fn();
const mockFocusAtPoint = jest.fn();
let mockExposeFocusMethod = true;
let mockAutoReady = true;

jest.mock("expo-camera", () => {
  const React = require("react");
  const { View } = require("react-native");

  const CameraView = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
    React.useImperativeHandle(ref, () => ({
      takePictureAsync: mockTakePictureAsync,
      ...(mockExposeFocusMethod ? { focusAtPoint: mockFocusAtPoint } : {}),
    }));
    mockCameraProps.push(props);
    React.useLayoutEffect(() => {
      const onCameraReady = props.onCameraReady as (() => void) | undefined;
      if (mockAutoReady) onCameraReady?.();
    }, []);
    return <View testID="camera-view" />;
  });

  return {
    CameraView,
    useCameraPermissions: () => [{ granted: true }, jest.fn()],
  };
});

jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");

  return {
    Ionicons: ({ name }: { name: string }) => <Text>{name}</Text>,
  };
});

jest.mock("react-native-gesture-handler", () => {
  const React = require("react");
  const { View } = require("react-native");

  return {
    GestureHandlerRootView: ({ children, ...props }: { children: React.ReactNode }) => (
      <View testID="gesture-root" {...props}>
        {children}
      </View>
    ),
    PinchGestureHandler: ({ children, ...props }: { children: React.ReactNode }) => (
      <View testID="pinch-handler" {...props}>
        {children}
      </View>
    ),
    State: {
      BEGAN: "BEGAN",
      END: "END",
      CANCELLED: "CANCELLED",
      FAILED: "FAILED",
    },
  };
});

jest.mock("react-native-safe-area-context", () => {
  const React = require("react");
  const { View } = require("react-native");

  return {
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
    SafeAreaView: ({ children, ...props }: { children: React.ReactNode }) => <View {...props}>{children}</View>,
  };
});

jest.mock("../../components/PhotoCaptionEditor", () => {
  const React = require("react");
  const { Text, View } = require("react-native");

  return {
    PhotoCaptionEditor: ({ footer, label }: { footer?: React.ReactNode; label?: string }) => (
      <View>
        {label ? <Text>{label}</Text> : null}
        {footer}
      </View>
    ),
  };
});

import { State } from "react-native-gesture-handler";
import { AccessibilityInfo, Platform, StyleSheet } from "react-native";
import CameraCapture from "../CameraCapture";

const originalPlatformOs = Platform.OS;

function lastCameraProps() {
  return mockCameraProps[mockCameraProps.length - 1];
}

function renderCamera() {
  return render(<CameraCapture onCapture={jest.fn()} onClose={jest.fn()} count={0} recent={[]} />);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("CameraCapture camera controls", () => {
  beforeEach(() => {
    Object.defineProperty(Platform, "OS", { configurable: true, get: () => originalPlatformOs });
    mockCameraProps.length = 0;
    mockTakePictureAsync.mockReset();
    mockFocusAtPoint.mockReset();
    mockFocusAtPoint.mockResolvedValue(true);
    mockExposeFocusMethod = true;
    mockAutoReady = true;
  });

  it("wraps modal gesture handlers in a local gesture root", () => {
    const screen = renderCamera();

    expect(screen.getByTestId("gesture-root")).toBeTruthy();
    expect(screen.getByTestId("pinch-handler")).toBeTruthy();
  });

  it("starts unzoomed and updates CameraView zoom from the visible controls", () => {
    const screen = renderCamera();

    expect(lastCameraProps().zoom).toBe(0);
    expect(screen.getByText("0%")).toBeTruthy();

    fireEvent.press(screen.getByLabelText("Zoom in"));
    expect(lastCameraProps().zoom).toBeCloseTo(0.1);
    expect(screen.getByText("10%")).toBeTruthy();

    fireEvent.press(screen.getByLabelText("Reset zoom"));
    expect(lastCameraProps().zoom).toBe(0);
    expect(screen.getByText("0%")).toBeTruthy();
  });

  it("toggles photo flash from an accessible top control", () => {
    const screen = renderCamera();

    expect(lastCameraProps().flash).toBe("off");
    expect(screen.getByLabelText("Flash").props.accessibilityState).toEqual({ checked: false, disabled: false });
    expect(screen.getByLabelText("Flash").props.accessibilityHint).toBe("Turns photo flash on or off");

    fireEvent.press(screen.getByLabelText("Flash"));

    expect(lastCameraProps().flash).toBe("on");
    expect(screen.getByLabelText("Flash").props.accessibilityState).toEqual({ checked: true, disabled: false });
  });

  it("uses separate 44pt top controls without horizontal hitSlop overlap", () => {
    const screen = renderCamera();
    const flash = screen.getByTestId("camera-flash-toggle");
    const done = screen.getByTestId("camera-done-button");
    const actions = screen.getByTestId("camera-top-actions");
    const flashStyle = StyleSheet.flatten(flash.props.style);
    const doneStyle = StyleSheet.flatten(done.props.style);
    const actionsStyle = StyleSheet.flatten(actions.props.style);

    expect(flashStyle.width).toBeGreaterThanOrEqual(44);
    expect(flashStyle.height).toBeGreaterThanOrEqual(44);
    expect(doneStyle.minWidth).toBeGreaterThanOrEqual(44);
    expect(doneStyle.height).toBeGreaterThanOrEqual(44);
    expect(actionsStyle.gap).toBeGreaterThanOrEqual(12);
    expect(flash.props.hitSlop).toEqual({ top: 4, bottom: 4, left: 0, right: 0 });
    expect(done.props.hitSlop).toEqual({ top: 4, bottom: 4, left: 0, right: 0 });
  });

  it("focuses at the tapped preview coordinate and only then shows the success reticle", async () => {
    const screen = renderCamera();

    fireEvent.press(screen.getByTestId("camera-focus-surface"), {
      nativeEvent: { locationX: 96, locationY: 164 },
    });

    await waitFor(() => expect(mockFocusAtPoint).toHaveBeenCalledWith({ x: 96, y: 164 }));
    expect(screen.getByTestId("camera-focus-reticle")).toBeTruthy();
    expect(screen.queryByText("Tap focus is unavailable on this camera.")).toBeNull();
  });

  it("clamps only the displayed reticle at preview edges while forwarding the exact tap", async () => {
    const screen = renderCamera();
    const focusSurface = screen.getByTestId("camera-focus-surface");

    fireEvent(focusSurface, "layout", {
      nativeEvent: { layout: { x: 0, y: 0, width: 100, height: 200 } },
    });
    fireEvent.press(focusSurface, {
      nativeEvent: { locationX: 2, locationY: 197 },
    });

    await waitFor(() => expect(mockFocusAtPoint).toHaveBeenCalledWith({ x: 2, y: 197 }));
    const reticleStyle = StyleSheet.flatten(screen.getByTestId("camera-focus-reticle").props.style);
    expect(reticleStyle.left).toBe(0);
    expect(reticleStyle.top).toBe(136);
  });

  it("does not show a success reticle when the camera reports fixed/unsupported focus", async () => {
    mockFocusAtPoint.mockResolvedValue(false);
    Object.defineProperty(Platform, "OS", { configurable: true, get: () => "ios" });
    const announceSpy = jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => undefined);
    const screen = renderCamera();

    fireEvent.press(screen.getByTestId("camera-focus-surface"), {
      nativeEvent: { locationX: 70, locationY: 120 },
    });

    await waitFor(() => expect(screen.getByText("Tap focus is unavailable on this camera.")).toBeTruthy());
    expect(screen.queryByTestId("camera-focus-reticle")).toBeNull();
    expect(announceSpy).toHaveBeenCalledWith("Tap focus is unavailable on this camera.");
    announceSpy.mockRestore();
  });

  it("keeps capture usable when an older binary has no native point-focus method", async () => {
    mockExposeFocusMethod = false;
    const screen = renderCamera();

    fireEvent.press(screen.getByTestId("camera-focus-surface"), {
      nativeEvent: { locationX: 70, locationY: 120 },
    });

    await waitFor(() => expect(screen.getByText("Tap focus is unavailable on this camera.")).toBeTruthy());
    expect(screen.getByLabelText("Capture photo")).toBeTruthy();
  });

  it("suppresses rapid focus requests until the active native request settles", async () => {
    const pendingFocus = deferred<boolean>();
    mockFocusAtPoint.mockReturnValue(pendingFocus.promise);
    const screen = renderCamera();
    const focusSurface = screen.getByTestId("camera-focus-surface");

    fireEvent.press(focusSurface, { nativeEvent: { locationX: 40, locationY: 80 } });
    fireEvent.press(focusSurface, { nativeEvent: { locationX: 120, locationY: 160 } });

    expect(mockFocusAtPoint).toHaveBeenCalledTimes(1);
    await act(async () => pendingFocus.resolve(true));
    expect(screen.getByTestId("camera-focus-reticle")).toBeTruthy();
  });

  it("keeps Done active during native focus and ignores the cancelled completion", async () => {
    const pendingFocus = deferred<boolean>();
    const onClose = jest.fn();
    mockFocusAtPoint.mockReturnValue(pendingFocus.promise);
    const screen = render(
      <CameraCapture onCapture={jest.fn()} onClose={onClose} count={0} recent={[]} />,
    );

    fireEvent.press(screen.getByTestId("camera-focus-surface"), {
      nativeEvent: { locationX: 40, locationY: 80 },
    });
    expect(screen.getByLabelText("Done capturing").props.accessibilityState).toEqual({ disabled: false });
    fireEvent.press(screen.getByLabelText("Done capturing"));

    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => pendingFocus.resolve(true));
    expect(screen.queryByTestId("camera-focus-reticle")).toBeNull();
    expect(screen.queryByText("Tap focus is unavailable on this camera.")).toBeNull();
  });

  it("does not schedule focus feedback after unmounting with native focus pending", async () => {
    const pendingFocus = deferred<boolean>();
    mockFocusAtPoint.mockReturnValue(pendingFocus.promise);
    const timerSpy = jest.spyOn(global, "setTimeout");
    const screen = renderCamera();

    fireEvent.press(screen.getByTestId("camera-focus-surface"), {
      nativeEvent: { locationX: 40, locationY: 80 },
    });
    timerSpy.mockClear();
    screen.unmount();
    await act(async () => pendingFocus.resolve(true));

    expect(timerSpy).not.toHaveBeenCalled();
    timerSpy.mockRestore();
  });

  it("does not route top-control presses through the preview focus surface", () => {
    const onClose = jest.fn();
    mockTakePictureAsync.mockResolvedValue(undefined);
    const screen = render(
      <CameraCapture onCapture={jest.fn()} onClose={onClose} count={0} recent={[]} />,
    );

    fireEvent.press(screen.getByLabelText("Flash"));
    fireEvent.press(screen.getByLabelText("Zoom in"));
    fireEvent.press(screen.getByLabelText("Done capturing"));

    expect(mockFocusAtPoint).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("disables focus and flash until ready while keeping an escape route", () => {
    mockAutoReady = false;
    const onClose = jest.fn();
    const screen = render(
      <CameraCapture onCapture={jest.fn()} onClose={onClose} count={0} recent={[]} />,
    );

    expect(screen.getByTestId("camera-focus-surface").props.accessibilityState).toEqual({ disabled: true });
    expect(screen.getByLabelText("Flash").props.accessibilityState).toEqual({ checked: false, disabled: true });
    expect(screen.getByLabelText("Done capturing").props.accessibilityState).toEqual({ disabled: false });
    fireEvent.press(screen.getByTestId("camera-focus-surface"), {
      nativeEvent: { locationX: 40, locationY: 80 },
    });
    fireEvent.press(screen.getByLabelText("Flash"));
    fireEvent.press(screen.getByLabelText("Done capturing"));

    expect(mockFocusAtPoint).not.toHaveBeenCalled();
    expect(lastCameraProps().flash).toBe("off");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("disables focus, flash, and Done while a photo capture is in flight", async () => {
    const pendingCapture = deferred<undefined>();
    const onClose = jest.fn();
    mockTakePictureAsync.mockReturnValue(pendingCapture.promise);
    const screen = render(
      <CameraCapture onCapture={jest.fn()} onClose={onClose} count={0} recent={[]} />,
    );

    fireEvent.press(screen.getByLabelText("Capture photo"));
    await waitFor(() => {
      expect(screen.getByTestId("camera-focus-surface").props.accessibilityState).toEqual({ disabled: true });
      expect(screen.getByLabelText("Flash").props.accessibilityState).toEqual({ checked: false, disabled: true });
      expect(screen.getByLabelText("Done capturing").props.accessibilityState).toEqual({ disabled: true });
    });

    fireEvent.press(screen.getByTestId("camera-focus-surface"), {
      nativeEvent: { locationX: 40, locationY: 80 },
    });
    fireEvent.press(screen.getByLabelText("Flash"));
    fireEvent.press(screen.getByLabelText("Done capturing"));
    expect(mockFocusAtPoint).not.toHaveBeenCalled();
    expect(lastCameraProps().flash).toBe("off");
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => pendingCapture.resolve(undefined));
  });

  it("supports pinch-to-zoom on the camera preview", () => {
    const screen = renderCamera();
    const pinch = screen.getByTestId("pinch-handler");

    fireEvent(pinch, "onHandlerStateChange", { nativeEvent: { state: State.BEGAN } });
    fireEvent(pinch, "onGestureEvent", { nativeEvent: { scale: 2 } });

    expect(lastCameraProps().zoom).toBeCloseTo(0.35);
    expect(screen.getByText("35%")).toBeTruthy();
  });

  it("clamps zoom to min and max while disabling inert controls", () => {
    const screen = renderCamera();

    expect(screen.getByLabelText("Zoom out").props.accessibilityState).toEqual({ disabled: true });
    expect(screen.getByLabelText("Reset zoom").props.accessibilityState).toEqual({ disabled: true });

    for (let i = 0; i < 20; i += 1) fireEvent.press(screen.getByLabelText("Zoom in"));
    expect(lastCameraProps().zoom).toBe(1);
    expect(screen.getByText("100%")).toBeTruthy();
    expect(screen.getByLabelText("Zoom in").props.accessibilityState).toEqual({ disabled: true });

    for (let i = 0; i < 20; i += 1) fireEvent.press(screen.getByLabelText("Zoom out"));
    expect(lastCameraProps().zoom).toBe(0);
    expect(screen.getByText("0%")).toBeTruthy();
    expect(screen.getByLabelText("Zoom out").props.accessibilityState).toEqual({ disabled: true });
  });

  it("uses an immediately effective first Android zoom button step without jumping to max", () => {
    Object.defineProperty(Platform, "OS", { configurable: true, get: () => "android" });
    const screen = renderCamera();

    fireEvent.press(screen.getByLabelText("Zoom in"));

    expect(lastCameraProps().zoom).toBe(0.5);
    expect(screen.getByText("50%")).toBeTruthy();
    expect(screen.getByLabelText("Zoom in").props.accessibilityState).toEqual({ disabled: false });
  });
});
