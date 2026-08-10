import { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, Easing } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList>;

// ── The month ⇄ day zoom ────────────────────────────────────────────────────
// The month view and the day view are the same canvas: same background, the
// same bottom pill (Today | Calendars) and the same Calen FAB at the same
// coordinates, with only the content and the top pills differing. A stock
// push slides that whole canvas off and a new copy on, which throws the
// shared furniture across the screen and back for no reason.
//
// So CalendarDay's native stack animation is OFF (see AppNavigator) and the
// move is drawn here instead, as a zoom THROUGH the surface — Apple Calendar's
// month→day feel, and the same motion Material calls a shared-axis Z:
//
//   forward   month content scales UP (1 → 1.08) and fades out, the day mounts
//             already receded (0.92) and grows into place;
//   backward  exactly the reverse — the day shrinks away and the month settles
//             down from 1.08.
//
// Two rules make it read as one continuous surface rather than two screens:
//
//   1. **The bottom chrome never animates, on either screen.** The two copies
//      are pixel-identical and identically placed, so the swap underneath them
//      is invisible and they read as one pill that simply stayed put.
//   2. **The screens swap while both are empty.** The month animates out FIRST
//      and only navigates once it has faded (ZOOM_OUT_MS); at that instant both
//      screens are just the background colour plus that identical bottom
//      chrome, so the hard cut has nothing to show.
//
// The top pills are the part that genuinely differs (avatar vs. back pill), so
// they get the largest scale swing — out big and soft, back in with a slight
// overshoot: "grow, blur out, pop back with the new buttons".
//
// A true gaussian blur is deliberately not used: RN's `filter: [{blur}]` is
// Android-only (iOS supports brightness/opacity alone), so it would mean a
// native blur module and an EAS rebuild to defocus something for 200ms. Scale
// + fade is what Apple's zoom actually does, and it reads the same.

export const ZOOM_OUT_MS = 170; // month recedes, then CalendarDay is pushed
export const ZOOM_IN_MS = 260; // day (or the returning month) settles in
export const ZOOM_BACK_MS = 150; // day recedes, then the pop

// How far the receding surface travels. The top pills swing wider than the
// content so the button row is the part that visibly "pops".
export const CONTENT_ZOOM = 1.08;
export const CHROME_ZOOM = 1.14;
export const ENTER_ZOOM = 0.92;

// 0 = the month owns the screen; 1 = it has zoomed away beneath the day view.
// Module-level because both screens animate the SAME move from opposite sides:
// the month leaves it at 1 while the day is open and picks it back up on focus,
// so returning resumes the zoom instead of cutting to a cold month.
export const monthDepth = new Animated.Value(0);
let depth = 0;

export function isMonthZoomed() {
  return depth !== 0;
}

// ── Reduce Motion ───────────────────────────────────────────────────────────
// Under Reduce Motion the zoom is dropped for a plain crossfade (the
// substitution Apple itself makes) — the timings stay, so the choreography and
// the screen swap still line up; only the scaling goes away.
let reduceMotion = false;
const reduceSubs = new Set<(on: boolean) => void>();
AccessibilityInfo.isReduceMotionEnabled()
  .then((on) => {
    reduceMotion = on;
    reduceSubs.forEach((fn) => fn(on));
  })
  .catch(() => {});
AccessibilityInfo.addEventListener('reduceMotionChanged', (on) => {
  reduceMotion = on;
  reduceSubs.forEach((fn) => fn(on));
});

export function useReduceMotion() {
  const [on, setOn] = useState(reduceMotion);
  useEffect(() => {
    const sub = (v: boolean) => setOn(v);
    reduceSubs.add(sub);
    setOn(reduceMotion);
    return () => {
      reduceSubs.delete(sub);
    };
  }, []);
  return on;
}

// The scale pair for one end of the zoom, flattened to no-op under Reduce
// Motion so the same interpolation can be written unconditionally.
export function zoomRange(from: number, to: number, reduced: boolean): [number, number] {
  return reduced ? [1, 1] : [from, to];
}

// The arriving top pills don't glide back to size — they overshoot a hair
// under 1 near the end and settle back up, which is what reads as a *pop*
// rather than a slide. Kept as an interpolation rather than a springy easing
// because the same value drives opacity, and an easing that overshoots would
// push that past 1.
export const POP_OVERSHOOT = 0.99;
export function popIn(enter: Animated.Value, reduced: boolean) {
  if (reduced) return 1;
  return enter.interpolate({ inputRange: [0, 0.78, 1], outputRange: [CHROME_ZOOM, POP_OVERSHOOT, 1] });
}

// ── Moves ───────────────────────────────────────────────────────────────────

// Send the month away, then open the day view on top of the hole it left.
// Every route into the day view from the month goes through here (a grid cell,
// a week number, the Today pill) so the motion is the same wherever it starts.
export function openDayView(navigation: Nav, date: string) {
  depth = 1;
  Animated.timing(monthDepth, {
    toValue: 1,
    duration: ZOOM_OUT_MS,
    easing: Easing.in(Easing.cubic),
    useNativeDriver: true,
  }).start(() => navigation.navigate('CalendarDay', { date }));
}

// Bring the month back down into place — called on focus, so it runs whether
// the day view was dismissed by the back pill or by Android's back button.
export function settleMonth() {
  depth = 0;
  Animated.timing(monthDepth, {
    toValue: 0,
    duration: ZOOM_IN_MS,
    easing: Easing.out(Easing.cubic),
    useNativeDriver: true,
  }).start();
}

// The month was left zoomed away but is being shown for some other reason
// (the day view handed off sideways rather than popping) — no motion to
// resume, just be present.
export function resetMonthDepth() {
  depth = 0;
  monthDepth.setValue(0);
}

// Withdraw the day view, then run `done` (the actual pop) once it has faded —
// the same swap-while-empty rule as the way in.
export function closeDayView(enter: Animated.Value, done: () => void) {
  Animated.timing(enter, {
    toValue: 0,
    duration: ZOOM_BACK_MS,
    easing: Easing.in(Easing.cubic),
    useNativeDriver: true,
  }).start(done);
}
