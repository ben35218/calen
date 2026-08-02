import { createScrollKeyboardTracker, ScrollGeom } from '../useScrollAwareKeyboard';

// The chat scroll↔keyboard state machine: scrolling up to read dismisses the
// keyboard; a deliberate finger-down pull PAST the bottom (overscroll) summons
// it back. Merely reaching the bottom never opens it, and neither do
// programmatic scrolls or a fling's bounce overshoot.

const VIEWPORT = 600;
const CONTENT = 2000;
const BOTTOM = CONTENT - VIEWPORT; // offsetY when pinned to the newest message

const at = (offsetY: number): ScrollGeom => ({ offsetY, viewportH: VIEWPORT, contentH: CONTENT });

function harness(keyboardVisible = true) {
  const io = {
    visible: keyboardVisible,
    dismissKeyboard: jest.fn(() => {
      io.visible = false;
    }),
    focusComposer: jest.fn(() => {
      io.visible = true;
    }),
  };
  const tracker = createScrollKeyboardTracker({
    isKeyboardVisible: () => io.visible,
    dismissKeyboard: io.dismissKeyboard,
    focusComposer: io.focusComposer,
  });
  return { io, tracker };
}

// Drive a user drag from one offset to another in a few frames.
function drag(tracker: ReturnType<typeof harness>['tracker'], from: number, to: number, velocity = 0) {
  tracker.onBeginDrag();
  const step = (to - from) / 4;
  for (let i = 1; i <= 4; i++) tracker.onScroll(at(from + step * i));
  tracker.onEndDrag(at(to), velocity);
}

describe('createScrollKeyboardTracker', () => {
  it('dismisses the keyboard when a drag scrolls up through history', () => {
    const { io, tracker } = harness();
    drag(tracker, BOTTOM, BOTTOM - 400);
    expect(io.dismissKeyboard).toHaveBeenCalledTimes(1);
  });

  it('ignores upward movement with no gesture in flight (programmatic scrolls)', () => {
    const { io, tracker } = harness();
    tracker.onScroll(at(BOTTOM));
    tracker.onScroll(at(BOTTOM - 400));
    tracker.onMomentumEnd(at(BOTTOM - 400));
    expect(io.dismissKeyboard).not.toHaveBeenCalled();
    expect(io.focusComposer).not.toHaveBeenCalled();
  });

  it('does not treat the bottom overscroll bounce-back as scrolling up', () => {
    const { io, tracker } = harness();
    tracker.onBeginDrag();
    tracker.onScroll(at(BOTTOM));
    tracker.onScroll(at(BOTTOM + 60)); // overscrolled past the end
    tracker.onScroll(at(BOTTOM)); // spring back = upward delta, near bottom
    expect(io.dismissKeyboard).not.toHaveBeenCalled();
  });

  it('scrolling down TO the bottom does not summon the keyboard', () => {
    const { io, tracker } = harness();
    drag(tracker, BOTTOM, BOTTOM - 400); // dismissed by reading upward
    drag(tracker, BOTTOM - 400, BOTTOM); // back to the newest message, no overscroll
    expect(io.focusComposer).not.toHaveBeenCalled();
  });

  it('a finger-down pull past the bottom summons the keyboard on release', () => {
    const { io, tracker } = harness(false); // keyboard closed
    tracker.onBeginDrag();
    tracker.onScroll(at(BOTTOM));
    tracker.onScroll(at(BOTTOM + 40)); // past the bottom, beyond the threshold
    tracker.onEndDrag(at(BOTTOM), 0); // spring settles; finger lifted
    expect(io.focusComposer).toHaveBeenCalledTimes(1);
  });

  it('summons regardless of how the keyboard was closed (explicit gesture)', () => {
    const { io, tracker } = harness(false); // e.g. closed by tap-away, never scroll-dismissed
    tracker.onBeginDrag();
    tracker.onScroll(at(BOTTOM + 40));
    tracker.onEndDrag(at(BOTTOM), 0);
    expect(io.focusComposer).toHaveBeenCalledTimes(1);
  });

  it('a shallow pull under the threshold does not summon', () => {
    const { io, tracker } = harness(false);
    tracker.onBeginDrag();
    tracker.onScroll(at(BOTTOM + 10)); // within OVERSCROLL_PX
    tracker.onEndDrag(at(BOTTOM), 0);
    expect(io.focusComposer).not.toHaveBeenCalled();
  });

  it("a fling's bounce overshoot after the finger lifts does not summon", () => {
    const { io, tracker } = harness(false);
    tracker.onBeginDrag();
    tracker.onScroll(at(BOTTOM - 200));
    tracker.onEndDrag(at(BOTTOM - 100), 3); // flung toward the bottom
    tracker.onScroll(at(BOTTOM + 60)); // momentum overshoots into the bounce
    tracker.onScroll(at(BOTTOM));
    tracker.onMomentumEnd(at(BOTTOM));
    expect(io.focusComposer).not.toHaveBeenCalled();
  });

  it('does not summon when the keyboard is already open', () => {
    const { io, tracker } = harness(true);
    tracker.onBeginDrag();
    tracker.onScroll(at(BOTTOM + 40));
    tracker.onEndDrag(at(BOTTOM), 0);
    expect(io.focusComposer).not.toHaveBeenCalled();
  });

  it('each drag needs its own overscroll — the flag does not linger', () => {
    const { io, tracker } = harness(false);
    tracker.onBeginDrag();
    tracker.onScroll(at(BOTTOM + 40));
    tracker.onEndDrag(at(BOTTOM), 0); // summons once
    io.visible = false; // closed again some other way
    drag(tracker, BOTTOM, BOTTOM - 100); // ordinary scroll, no overscroll
    drag(tracker, BOTTOM - 100, BOTTOM);
    expect(io.focusComposer).toHaveBeenCalledTimes(1);
  });
});
