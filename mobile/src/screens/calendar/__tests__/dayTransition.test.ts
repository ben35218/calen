// The month ⇄ day move is a zoom the two screens draw themselves (the native
// push animation is off), and the whole illusion rests on ORDERING: the month
// has to be gone BEFORE CalendarDay is pushed, and the day has to be gone
// BEFORE the pop — the screens swap while both are empty, so the cut has
// nothing to show. Tested here because getting it backwards still "works",
// it just flashes. See specs/features/calendar.md.
import { Animated } from 'react-native';
import {
  CHROME_ZOOM, CONTENT_ZOOM, ENTER_ZOOM, ZOOM_BACK_MS, ZOOM_OUT_MS,
  closeDayView, isMonthZoomed, openDayView, popIn, resetMonthDepth, settleMonth, zoomRange,
} from '../dayTransition';

// Animated.timing, reduced to "call me with what you'd animate, then let the
// test decide when it finishes" — the assertions are about what runs before
// the completion callback, not about interpolation.
let pending: { toValue: number; duration: number; done?: (r: { finished: boolean }) => void }[] = [];
jest.spyOn(Animated, 'timing').mockImplementation((_value: any, config: any) => ({
  start: (done?: (r: { finished: boolean }) => void) => {
    pending.push({ toValue: config.toValue, duration: config.duration, done });
  },
} as any));

const finishAll = () => {
  const runs = pending;
  pending = [];
  runs.forEach((r) => r.done?.({ finished: true }));
};

beforeEach(() => {
  pending = [];
  resetMonthDepth();
});

describe('month → day', () => {
  it('sends the month away first and only then pushes CalendarDay', () => {
    const navigation = { navigate: jest.fn() } as any;
    openDayView(navigation, '2026-08-10');

    // Mid-zoom: nothing has been pushed yet.
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ toValue: 1, duration: ZOOM_OUT_MS });

    finishAll();
    expect(navigation.navigate).toHaveBeenCalledWith('CalendarDay', { date: '2026-08-10' });
  });

  it('leaves the month zoomed away while the day view is up, and settles it on return', () => {
    const navigation = { navigate: jest.fn() } as any;
    openDayView(navigation, '2026-08-10');
    finishAll();
    // The month keeps its receded state so returning resumes the same move
    // backwards instead of cutting to a cold month.
    expect(isMonthZoomed()).toBe(true);

    settleMonth();
    expect(pending[0]).toMatchObject({ toValue: 0 });
    expect(isMonthZoomed()).toBe(false);
  });
});

describe('day → month', () => {
  it('withdraws the day view before running the pop', () => {
    const enter = new Animated.Value(1);
    const pop = jest.fn();
    closeDayView(enter, pop);

    expect(pop).not.toHaveBeenCalled();
    expect(pending[0]).toMatchObject({ toValue: 0, duration: ZOOM_BACK_MS });

    finishAll();
    expect(pop).toHaveBeenCalledTimes(1);
  });
});

describe('Reduce Motion', () => {
  it('flattens the scaling to a plain crossfade, and leaves it alone otherwise', () => {
    expect(zoomRange(1, CONTENT_ZOOM, false)).toEqual([1, CONTENT_ZOOM]);
    expect(zoomRange(ENTER_ZOOM, 1, false)).toEqual([ENTER_ZOOM, 1]);
    expect(zoomRange(1, CHROME_ZOOM, true)).toEqual([1, 1]);
    expect(zoomRange(ENTER_ZOOM, 1, true)).toEqual([1, 1]);
  });

  it('swings the top pills wider than the content — the buttons are what pops', () => {
    expect(CHROME_ZOOM).toBeGreaterThan(CONTENT_ZOOM);
  });

  it('drops the top pills\' overshoot too — a pop is motion', () => {
    expect(popIn(new Animated.Value(0), true)).toBe(1);
  });
});

describe('the top pills pop rather than glide', () => {
  const at = (v: number) => {
    const scale = popIn(new Animated.Value(v), false) as any;
    return scale.__getValue();
  };

  it('arrives oversized, settles a hair under, then lands on 1', () => {
    expect(at(0)).toBeCloseTo(CHROME_ZOOM);
    expect(at(0.78)).toBeLessThan(1); // the overshoot that reads as a pop
    expect(at(1)).toBeCloseTo(1);
  });
});
