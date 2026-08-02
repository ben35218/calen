import { useRef, useState } from 'react';
import { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { ScrollGeom } from './useScrollAwareKeyboard';

// "Stick to bottom" for streaming chat (the ChatGPT/iMessage pattern): while a
// reply streams in, the list follows the newest text ONLY when the user is
// already parked at the bottom. Scroll up to read and the view freezes where
// you left it — text keeps arriving below, but the screen holds still — and a
// jump-to-latest button appears. Scroll back to the bottom (or tap the button)
// and following re-engages.

// Within this many px of the bottom counts as "at the bottom" — keep following.
// Generous enough that the last line's ascent/line-height or a sub-pixel content
// measurement never reads as "scrolled up".
const PIN_THRESHOLD_PX = 48;

const distFromBottom = (g: ScrollGeom) => g.contentH - g.viewportH - g.offsetY;

// The platform-free core, factored out (like createScrollKeyboardTracker) so the
// pin/unpin logic is unit-testable without a renderer. Each handler returns the
// new pinned value, or null when this event shouldn't change it.
export function createStickToBottomTracker(threshold = PIN_THRESHOLD_PX) {
  // True only while the finger is down or a fling is settling — i.e. a
  // user-driven scroll. A programmatic scrollToEnd() also fires onScroll, and
  // mid-animation the reported offset lags the true bottom; trusting those
  // frames would flip us to "unpinned" and silently kill the follow. So we
  // sample pinned state from user gestures only.
  let dragging = false;
  const near = (g: ScrollGeom) => distFromBottom(g) <= threshold;
  return {
    onBeginDrag() {
      dragging = true;
    },
    onScroll(g: ScrollGeom): boolean | null {
      return dragging ? near(g) : null;
    },
    onEndDrag(g: ScrollGeom): boolean {
      dragging = false;
      return near(g);
    },
    onMomentumEnd(g: ScrollGeom): boolean {
      // Fires when a fling settles — and at the end of our own animated
      // scrollToEnd, which lands at the bottom, so this harmlessly re-affirms
      // pinned=true rather than fighting it.
      return near(g);
    },
  };
}

// Spread the returned scroll handlers onto the conversation ScrollView (compose
// them with any other onScroll consumer). `pinnedRef` is read synchronously by
// the streaming auto-scroll effect; `atBottom` drives the jump-to-latest button;
// `pinToBottom()` re-engages following (button tap / a fresh user send).
export function useStickToBottom(scrollToEnd: () => void) {
  // Start pinned: a fresh conversation opens at the bottom, following the reply.
  const pinnedRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const tracker = useRef(createStickToBottomTracker()).current;

  const apply = (pinned: boolean | null) => {
    if (pinned === null || pinned === pinnedRef.current) return;
    pinnedRef.current = pinned;
    setAtBottom(pinned);
  };

  const geom = (e: NativeSyntheticEvent<NativeScrollEvent>): ScrollGeom => ({
    offsetY: e.nativeEvent.contentOffset.y,
    viewportH: e.nativeEvent.layoutMeasurement.height,
    contentH: e.nativeEvent.contentSize.height,
  });

  const pinToBottom = () => {
    pinnedRef.current = true;
    setAtBottom(true);
    scrollToEnd();
  };

  return {
    pinnedRef,
    atBottom,
    pinToBottom,
    onScrollBeginDrag: () => tracker.onBeginDrag(),
    onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => apply(tracker.onScroll(geom(e))),
    onScrollEndDrag: (e: NativeSyntheticEvent<NativeScrollEvent>) => apply(tracker.onEndDrag(geom(e))),
    onMomentumScrollEnd: (e: NativeSyntheticEvent<NativeScrollEvent>) =>
      apply(tracker.onMomentumEnd(geom(e))),
  };
}
