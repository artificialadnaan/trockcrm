import React, { useCallback, useEffect, useRef, useState } from "react";
import { Animated, StyleSheet } from "react-native";
import { Image as ExpoImage } from "expo-image";
import { photoCacheKey, thumbnailCacheKey } from "../photos/cache-keys";
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
  thumbnailUri,
  cacheKey,
  width,
  height,
  active = true,
  onZoomChange,
  onLoadStart,
  onLoad,
  onError,
}: {
  uri: string;
  /** The already-cached grid thumbnail, shown as the placeholder while the full-res original decodes — and
   *  left on screen if it never does. Without it a slow or failed full-res load renders as pure black. */
  thumbnailUri?: string | null;
  /**
   * The PHOTO ID, from which both cache keys are derived (see photos/cache-keys) — the original's and the
   * thumbnail placeholder's. Not a key itself; passing a pre-built key here would put the placeholder on a
   * different entry from the one the grid wrote. See the source prop for why the uri won't do.
   */
  cacheKey?: string | null;
  width: number;
  height: number;
  /** Whether this is the photo currently on screen; going inactive resets zoom/pan so paging back is clean. */
  active?: boolean;
  onZoomChange?: (zoomed: boolean) => void;
  onLoadStart?: () => void;
  onLoad?: () => void;
  onError?: () => void;
}) {
  // Mirrors lastScale > 1 so the pan handler is only enabled while zoomed (a 1x one-finger drag must not
  // translate the image or fight the pager).
  const [isZoomed, setIsZoomed] = useState(false);
  // Full-res decode is DEFERRED until the user actually zooms. The server has no mid-size derivative — the
  // viewer's URL is the untouched original (4032px for app captures, uncapped for CompanyCam imports), so
  // decoding it at native resolution costs ~48MB of bitmap. At 1x that detail is invisible on a ~1200px-wide
  // phone screen, and on a project with thousands of photos (the unvirtualized grid already holds a tile per
  // photo in memory) the allocation simply fails — expo-image then renders NOTHING, which is the black frame
  // this viewer was showing. Downscaled at 1x, native-res once zoomed: #888's crisp-zoom intent is preserved
  // exactly where it's observable. Latched, not mirrored off isZoomed, so pinching in and out can't thrash a
  // 48MB decode on every gesture.
  const [fullResRequested, setFullResRequested] = useState(false);
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
      const zoomed = clamped > MIN_SCALE;
      if (!zoomed) resetPan();
      setIsZoomed(zoomed);
      // Latch on the first zoom; zooming back out keeps the native-res bitmap we already paid for.
      if (zoomed) setFullResRequested(true);
      onZoomChange?.(zoomed);
    },
    [baseScale, pinchScale, resetPan, onZoomChange],
  );

  // When this photo scrolls off-screen, snap it back to 1x so returning to it (and the pager) starts clean,
  // and drop back to the downscaled decode so the full-res bitmap is released with the page.
  useEffect(() => {
    if (!active) {
      if (lastScale.current > MIN_SCALE) applyScale(MIN_SCALE);
      setFullResRequested(false);
    }
  }, [active, applyScale]);

  // All zoom state (isZoomed, lastScale, the Animated values) is instance-local, so ANY remount silently
  // resets the image to 1x — and the parent gates the pager on its own `zoomed` copy, which only
  // onZoomChange ever writes. Without this, a remount while zoomed (the viewer swaps in a re-minted URL, or
  // the user taps Retry) leaves the photo visibly at 1x while the parent still believes it is zoomed, so
  // horizontal paging stays disabled with no way to tell why. Reported through a ref so the cleanup runs
  // only on real unmount rather than on every prop change.
  const onZoomChangeRef = useRef(onZoomChange);
  onZoomChangeRef.current = onZoomChange;
  useEffect(() => () => onZoomChangeRef.current?.(false), []);

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
          enabled={isZoomed}
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
              {/* Transform lives on the Animated.View wrapper (always native-drivable) so the image
                  itself can be expo-image. RN's core <Image> downsamples the decoded bitmap to ~view
                  size — fine at 1x, but blurry the instant you pinch-zoom a detail-dense shot (design
                  boards, punch defects). expo-image with allowDownscaling={false} decodes the FULL-res
                  original at native resolution so zoom stays crisp — but that decode is ~48MB, so it is
                  now DEFERRED until the first zoom (see fullResRequested) rather than paid on every page;
                  recyclingKey resets decode state as the pager recycles this view across photos.
                  cachePolicy="disk" (NOT "memory-disk"): the in-memory cache would retain ~48MB full-res
                  bitmaps for pages the FlatList has already unmounted, defeating the windowSize cap and
                  jetsamming older iPhones after enough swiping. Disk-only keeps the compressed JPEG for
                  offline re-open while bounding RAM to the mounted window; swipe-back re-decodes from
                  local disk (cheap). */}
              <Animated.View
                style={{
                  width,
                  height,
                  transform: [{ translateX }, { translateY }, { scale }],
                }}
              >
                <ExpoImage
                  // Without an explicit cacheKey expo-image keys the cache on the WHOLE uri, signature query
                  // params and all — so every re-minted presigned URL is a cache miss and the "offline
                  // re-open" the disk policy is here for never happens. Keying on the immutable photo id
                  // makes the cache actually hit, which also means a re-minted URL after an expiry costs
                  // nothing to render.
                  // Deliberately NOT tiered by decode size: the disk cache holds the ENCODED original, and
                  // the tier only changes how it is decoded — so one entry serves both. Suffixing the key
                  // per tier would guarantee a miss and re-download the whole original on the first pinch,
                  // which on jobsite LTE is a multi-second stall and offline is an outright failure for
                  // bytes already sitting on disk.
                  source={{ uri, cacheKey: cacheKey ? photoCacheKey(cacheKey) : undefined }}
                  // The grid thumbnail is already in expo-image's cache, so it paints immediately and stays
                  // put until the full-res original decodes over it. On a failed load it is what the user
                  // keeps seeing — a downscaled photo beats the black rectangle this used to render.
                  // It MUST carry the grid's cacheKey: without it expo-image looks the placeholder up by
                  // URL, misses the entry the grid stored under the id, and goes to the network for a
                  // thumbnail URL that is expired in exactly the situation the placeholder exists for —
                  // so the fallback is absent precisely when it is needed and the pane is blank again.
                  placeholder={
                    thumbnailUri
                      ? { uri: thumbnailUri, cacheKey: cacheKey ? thumbnailCacheKey(cacheKey) : undefined }
                      : undefined
                  }
                  placeholderContentFit="contain"
                  style={{ width, height }}
                  contentFit="contain"
                  // enforceEarlyResizing is the prop that actually bounds the DECODE: it is the only thing
                  // that sets SDWebImage's imageThumbnailPixelSize (ios/ImageView.swift:161-168), so the
                  // bitmap is produced at container size instead of the original's 4032px. allowDownscaling
                  // alone does NOT do this — it is read in processImage (ios/ImageView.swift:374), i.e.
                  // AFTER a full-resolution decode has already happened, so on its own it lowers only the
                  // RETAINED bitmap, not the peak allocation that fails. Both are tied to the zoom latch.
                  enforceEarlyResizing={!fullResRequested}
                  allowDownscaling={!fullResRequested}
                  cachePolicy="disk"
                  // The tier is part of the recycling key so latching full-res actually forces the re-decode
                  // rather than leaving the downscaled bitmap on screen; the thumbnail placeholder covers the
                  // brief swap.
                  recyclingKey={fullResRequested ? `${uri}#full` : uri}
                  // Surfaced so the viewer can show a spinner, re-mint an expired presigned URL and retry,
                  // and finally show an explicit error. expo-image renders NOTHING on a failed load, so
                  // without these a 403/decode failure is indistinguishable from a black photo.
                  onLoadStart={onLoadStart}
                  onLoad={onLoad}
                  onError={onError}
                />
              </Animated.View>
            </PinchGestureHandler>
          </Animated.View>
        </PanGestureHandler>
      </Animated.View>
    </TapGestureHandler>
  );
}
