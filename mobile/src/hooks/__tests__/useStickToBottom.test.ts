import { createStickToBottomTracker } from '../useStickToBottom';
import { ScrollGeom } from '../useScrollAwareKeyboard';

// The stick-to-bottom state machine: a streaming reply follows the newest text
// only while the user is parked at the bottom. Scrolling up unpins (freeze +
// jump button); scrolling back to the bottom re-pins. Only user-driven scrolls
// decide pinning — a programmatic scrollToEnd()'s onScroll frames must not
// flip the state, or the follow would die mid-animation.

const VIEWPORT = 600;
const CONTENT = 2000;
const BOTTOM = CONTENT - VIEWPORT; // offsetY when pinned to the newest message

const at = (offsetY: number): ScrollGeom => ({ offsetY, viewportH: VIEWPORT, contentH: CONTENT });

describe('createStickToBottomTracker', () => {
  it('unpins when a drag scrolls up off the bottom', () => {
    const t = createStickToBottomTracker();
    t.onBeginDrag();
    expect(t.onScroll(at(BOTTOM - 400))).toBe(false);
  });

  it('re-pins when a drag returns to the bottom', () => {
    const t = createStickToBottomTracker();
    t.onBeginDrag();
    expect(t.onScroll(at(BOTTOM - 400))).toBe(false);
    expect(t.onScroll(at(BOTTOM))).toBe(true);
  });

  it('stays pinned within the threshold of the bottom', () => {
    const t = createStickToBottomTracker();
    t.onBeginDrag();
    // 40px short of the bottom — the last line's slack, still "at bottom".
    expect(t.onScroll(at(BOTTOM - 40))).toBe(true);
  });

  it('ignores onScroll frames from a programmatic scroll (no drag in flight)', () => {
    const t = createStickToBottomTracker();
    // A scrollToEnd() animation emits onScroll with the offset lagging the
    // bottom; without a gesture these must not change the pin state.
    expect(t.onScroll(at(BOTTOM - 300))).toBeNull();
    expect(t.onScroll(at(BOTTOM - 100))).toBeNull();
  });

  it('samples pinned state when a drag ends', () => {
    const t = createStickToBottomTracker();
    t.onBeginDrag();
    expect(t.onEndDrag(at(BOTTOM - 500))).toBe(false);
  });

  it('a fling that settles up the thread unpins at momentum end', () => {
    const t = createStickToBottomTracker();
    t.onBeginDrag();
    t.onScroll(at(BOTTOM - 100));
    t.onEndDrag(at(BOTTOM - 150)); // finger lifts, still near-ish
    expect(t.onMomentumEnd(at(BOTTOM - 800))).toBe(false); // momentum carried up
  });

  it('an animated scrollToEnd landing at the bottom re-affirms pinned at momentum end', () => {
    const t = createStickToBottomTracker();
    expect(t.onMomentumEnd(at(BOTTOM))).toBe(true);
  });

  it('a new drag samples freshly — dragging does not linger after it ends', () => {
    const t = createStickToBottomTracker();
    t.onBeginDrag();
    t.onEndDrag(at(BOTTOM - 400)); // dragging cleared here
    // No onBeginDrag → these are programmatic frames again, ignored.
    expect(t.onScroll(at(BOTTOM - 200))).toBeNull();
  });
});
