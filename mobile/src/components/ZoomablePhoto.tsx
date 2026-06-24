import React, { useCallback, useRef } from "react";
import { Animated, StyleSheet } from "react-native";
import {
  PanGestureHandler,
  PinchGestureHandler,
  State,
  TapGestureHandler,
  type PanGestureHandlerStateChangeEvent,
  type PinchGestureHandlerStateChangeEvent,
  type TapGestureHandlerStateChangeEvent,
} from "react-native-gesture-handler";

const MAX_SCALE = 4;
const MIN_SCALE = 1;
const DOUBLE_TAP_SCALE = 2;

/**
 * Pinch-to-zoom + pan + double-tap photo, built on gesture-handler's legacy Animated.event API because
 * this app has no reanimated. Reports zoom state up so the pager can disable horizontal swipe while
 * zoomed (otherwise a one-finger pan would page instead of moving the image).
 */
export function ZoomablePhoto({
  uri,
  width,
  height,
  onZoomChange,
}: {
  uri: string;
  width: number;
  height: number;
  onZoomChange?: (zoomed: boolean) => void;
}) {
  const pinchScale = useRef(new Animated.Value(1)).current;
  const baseScale = useRef(new Animated.Value(1)).current;
  const scale = useRef(Animated.multiply(baseScale, pinchScale)).current;
  const lastScale = useRef(1);

  const panX = useRef(new Animated.Value(0)).current;
  const panY = useRef(new Animated.Value(0)).current;
  const baseX = useRef(new Animated.Value(0)).current;
  const baseY = useRef(new Animated.Value(0)).current;
  const translateX = useRef(Animated.add(baseX, panX)).current;
  const translateY = useRef(Animated.add(baseY, panY)).current;
  const lastX = useRef(0);
  const lastY = useRef(0);

  const pinchRef = useRef(null);
  const panRef = useRef(null);
  const doubleTapRef = useRef(null);

  const resetPan = useCallback(() => {
    lastX.current = 0;
    lastY.current = 0;
    baseX.setValue(0);
    baseY.setValue(0);
    panX.setValue(0);
    panY.setValue(0);
  }, [baseX, baseY, panX, panY]);

  const applyScale = useCallback(
    (next: number) => {
      const clamped = Math.min(Math.max(next, MIN_SCALE), MAX_SCALE);
      lastScale.current = clamped;
      baseScale.setValue(clamped);
      pinchScale.setValue(1);
      if (clamped <= MIN_SCALE) resetPan();
      onZoomChange?.(clamped > MIN_SCALE);
    },
    [baseScale, pinchScale, resetPan, onZoomChange],
  );

  const onPinchEvent = Animated.event([{ nativeEvent: { scale: pinchScale } }], { useNativeDriver: true });

  const onPinchStateChange = useCallback(
    (event: PinchGestureHandlerStateChangeEvent) => {
      if (event.nativeEvent.oldState === State.ACTIVE) {
        applyScale(lastScale.current * event.nativeEvent.scale);
      }
    },
    [applyScale],
  );

  const onPanEvent = Animated.event([{ nativeEvent: { translationX: panX, translationY: panY } }], {
    useNativeDriver: true,
  });

  const onPanStateChange = useCallback(
    (event: PanGestureHandlerStateChangeEvent) => {
      if (event.nativeEvent.oldState === State.ACTIVE) {
        lastX.current += event.nativeEvent.translationX;
        lastY.current += event.nativeEvent.translationY;
        baseX.setValue(lastX.current);
        baseY.setValue(lastY.current);
        panX.setValue(0);
        panY.setValue(0);
      }
    },
    [baseX, baseY, panX, panY],
  );

  const onDoubleTap = useCallback(
    (event: TapGestureHandlerStateChangeEvent) => {
      if (event.nativeEvent.state !== State.ACTIVE) return;
      applyScale(lastScale.current > MIN_SCALE ? MIN_SCALE : DOUBLE_TAP_SCALE);
    },
    [applyScale],
  );

  return (
    <TapGestureHandler ref={doubleTapRef} numberOfTaps={2} onHandlerStateChange={onDoubleTap}>
      <Animated.View style={{ width, height }}>
        <PanGestureHandler
          ref={panRef}
          minPointers={1}
          maxPointers={1}
          avgTouches
          simultaneousHandlers={pinchRef}
          onGestureEvent={onPanEvent}
          onHandlerStateChange={onPanStateChange}
        >
          <Animated.View style={StyleSheet.absoluteFill}>
            <PinchGestureHandler
              ref={pinchRef}
              simultaneousHandlers={panRef}
              onGestureEvent={onPinchEvent}
              onHandlerStateChange={onPinchStateChange}
            >
              <Animated.Image
                source={{ uri }}
                resizeMode="contain"
                style={{
                  width,
                  height,
                  transform: [{ translateX }, { translateY }, { scale }],
                }}
              />
            </PinchGestureHandler>
          </Animated.View>
        </PanGestureHandler>
      </Animated.View>
    </TapGestureHandler>
  );
}
