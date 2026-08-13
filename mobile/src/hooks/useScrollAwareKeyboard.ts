import { RefObject, useEffect, useRef } from 'react';
import {
  Keyboard,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
} from 'react-native';
import { TextInput } from '../components/Text';

// Scroll-aware keyboard for chat surfaces (the iMessage/WhatsApp pattern):
// scrolling UP to read history tucks the keyboard away; a deliberate pull
// PAST the bottom (into the overscroll bounce, finger down) summons it back.
// Merely reaching the bottom never opens the keyboard — the user often wants
// to read the newest message, not type — and neither does a fling that
// overshoots into the bounce after the finger lifted.

export type ScrollGeom = {
  offsetY: number;
  viewportH: number;
  contentH: number;
};

// Don't treat upward movement this close to the bottom as "reading history" —
// it's the overscroll bounce springing back, not an intent to scroll up.
const DISMISS_GUARD_PX = 80;
// How far past the bottom a finger-down pull must go to summon the keyboard.
const OVERSCROLL_PX = 24;
// Per-frame upward movement below this is jitter, not a scroll.
const MIN_UP_DELTA_PX = 2;

// The platform-free core, factored out so the gesture/geometry state machine is
// unit-testable without a React renderer or native Keyboard events.
export function createScrollKeyboardTracker(io: {
  isKeyboardVisible: () => boolean;
  dismissKeyboard: () => void;
  focusComposer: () => void;
}) {
  let lastY = 0;
  // True from drag start until the gesture (incl. its momentum) settles, so
  // programmatic scrolls (new-message scrollToEnd) never trigger anything.
  let gesture = false;
  // True only while the finger is down — overscroll counts as intent to open
  // the keyboard only during an active drag, not a fling's bounce overshoot.
  let dragging = false;
  let overscrolled = false;

  const distFromBottom = (g: ScrollGeom) => g.contentH - g.viewportH - g.offsetY;

  return {
    onBeginDrag() {
      gesture = true;
      dragging = true;
      overscrolled = false;
    },
    onScroll(g: ScrollGeom) {
      const dy = g.offsetY - lastY;
      lastY = g.offsetY;
      if (!gesture) return;
      if (dy <= -MIN_UP_DELTA_PX && distFromBottom(g) > DISMISS_GUARD_PX && io.isKeyboardVisible()) {
        io.dismissKeyboard();
      }
      // Pulled past the bottom with the finger down — the summon gesture.
      if (dragging && distFromBottom(g) < -OVERSCROLL_PX) overscrolled = true;
    },
    onEndDrag(g: ScrollGeom, velocityY: number) {
      lastY = g.offsetY;
      dragging = false;
      if (overscrolled && !io.isKeyboardVisible()) io.focusComposer();
      overscrolled = false;
      // No fling → no momentum phase will follow; the gesture is over now.
      if (Math.abs(velocityY) < 0.1) gesture = false;
    },
    onMomentumEnd(g: ScrollGeom) {
      lastY = g.offsetY;
      gesture = false;
    },
  };
}

// Spread the returned props onto the conversation ScrollView; pass the composer
// TextInput's ref and a scrollToEnd so a summoned keyboard re-pins the list.
export function useScrollAwareKeyboard(
  inputRef: RefObject<TextInput | null>,
  scrollToEnd: () => void,
) {
  const keyboardVisible = useRef(false);
  const pinOnShow = useRef(false);
  const tracker = useRef(
    createScrollKeyboardTracker({
      isKeyboardVisible: () => keyboardVisible.current,
      dismissKeyboard: () => Keyboard.dismiss(),
      focusComposer: () => {
        pinOnShow.current = true;
        inputRef.current?.focus();
      },
    }),
  ).current;

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => {
      keyboardVisible.current = true;
      // The keyboard we just summoned shrank the viewport — keep the newest
      // message in view rather than leaving the list stranded mid-thread.
      if (pinOnShow.current) {
        pinOnShow.current = false;
        scrollToEnd();
      }
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      keyboardVisible.current = false;
    });
    return () => {
      show.remove();
      hide.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const geom = (e: NativeSyntheticEvent<NativeScrollEvent>): ScrollGeom => ({
    offsetY: e.nativeEvent.contentOffset.y,
    viewportH: e.nativeEvent.layoutMeasurement.height,
    contentH: e.nativeEvent.contentSize.height,
  });

  return {
    scrollEventThrottle: 16,
    // iOS gets the native finger-tracking dismissal as well; on Android the
    // tracker's direction logic does the dismissing ('on-drag' would also fire
    // on downward scrolls). The summon gesture needs the bounce, so keep it on.
    bounces: true,
    keyboardDismissMode: Platform.OS === 'ios' ? ('interactive' as const) : ('none' as const),
    onScrollBeginDrag: () => tracker.onBeginDrag(),
    onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => tracker.onScroll(geom(e)),
    onScrollEndDrag: (e: NativeSyntheticEvent<NativeScrollEvent>) =>
      tracker.onEndDrag(geom(e), e.nativeEvent.velocity?.y ?? 0),
    onMomentumScrollEnd: (e: NativeSyntheticEvent<NativeScrollEvent>) =>
      tracker.onMomentumEnd(geom(e)),
  };
}
