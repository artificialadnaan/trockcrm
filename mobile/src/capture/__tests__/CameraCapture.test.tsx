import React from "react";
import { fireEvent, render } from "@testing-library/react-native";

const mockCameraProps: Record<string, unknown>[] = [];
const mockTakePictureAsync = jest.fn();

jest.mock("expo-camera", () => {
  const React = require("react");
  const { View } = require("react-native");

  const CameraView = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
    React.useImperativeHandle(ref, () => ({
      takePictureAsync: mockTakePictureAsync,
    }));
    mockCameraProps.push(props);
    React.useEffect(() => {
      const onCameraReady = props.onCameraReady as (() => void) | undefined;
      onCameraReady?.();
    }, [props.onCameraReady]);
    return <View testID="camera-view" />;
  });

  return {
    CameraView,
    useCameraPermissions: () => [{ granted: true }, jest.fn()],
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
import { Platform } from "react-native";
import CameraCapture from "../CameraCapture";

const originalPlatformOs = Platform.OS;

function lastCameraProps() {
  return mockCameraProps[mockCameraProps.length - 1];
}

function renderCamera() {
  return render(<CameraCapture onCapture={jest.fn()} onClose={jest.fn()} count={0} recent={[]} />);
}

describe("CameraCapture zoom", () => {
  beforeEach(() => {
    Object.defineProperty(Platform, "OS", { configurable: true, get: () => originalPlatformOs });
    mockCameraProps.length = 0;
    mockTakePictureAsync.mockReset();
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

  it("uses an immediately effective first Android zoom button step", () => {
    Object.defineProperty(Platform, "OS", { configurable: true, get: () => "android" });
    const screen = renderCamera();

    fireEvent.press(screen.getByLabelText("Zoom in"));

    expect(lastCameraProps().zoom).toBe(1);
    expect(screen.getByText("100%")).toBeTruthy();
  });
});
