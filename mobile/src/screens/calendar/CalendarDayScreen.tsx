import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, Animated, Easing } from 'react-native';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useDayViewMode } from '../../lib/calendarPrefs';
import { ymd } from '../../lib/calendar';
import { CalendarStackParamList } from '../../navigation/CalendarNavigator';
import { colors } from '../../theme';
import { TodayHandle } from './todayHandle';
import TimelineView from './dayview/TimelineView';
import AgendaView from './dayview/AgendaView';
import DayViewChrome, { TOP_BAR_ROW } from './dayview/DayViewChrome';
import { closeDayView, ENTER_ZOOM, ZOOM_IN_MS, useReduceMotion, zoomRange } from './dayTransition';

type Rt = RouteProp<CalendarStackParamList, 'CalendarDay'>;

// The Apple-style day view: tapping a month-grid day lands here. A thin host
// (mirroring CalendarScreen's layer pattern) that owns the anchor date, the
// persisted view mode, and the floating chrome, crossfading between the
// hour-grid timeline (Single/Multi Day share one mounted instance, so scroll
// position survives the switch) and the lazily-mounted agenda List. The route
// param just seeds the first anchor; swiping/paging is local state, not
// navigation.
export default function CalendarDayScreen() {
  const { date: initialDate } = useRoute<Rt>().params;
  const navigation = useNavigation<NativeStackNavigationProp<CalendarStackParamList, 'CalendarDay'>>();
  const insets = useSafeAreaInsets();
  const { mode, setMode } = useDayViewMode();
  const [anchor, setAnchor] = useState(initialDate);

  const isList = mode === 'list';
  const [listMounted, setListMounted] = useState(false);
  const progress = useRef(new Animated.Value(0)).current; // 0 = timeline, 1 = list
  const timelineRef = useRef<TodayHandle>(null);
  const agendaRef = useRef<TodayHandle>(null);

  // Crossfade whenever we cross into/out of List (button taps and the async
  // initial load of a stored List preference alike).
  useEffect(() => {
    if (isList) setListMounted(true);
    Animated.timing(progress, { toValue: isList ? 1 : 0, duration: 220, useNativeDriver: true }).start();
  }, [isList, progress]);

  const timelineLayer = {
    opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
    transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.97] }) }],
  };
  const listLayer = {
    opacity: progress,
    transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) }],
  };

  // ── The month ⇄ day zoom (see dayTransition) ──
  // The month has already faded out by the time this screen mounts (the push
  // itself is animation-less), so the day grows in from where the month left
  // off. 0 = away, 1 = in place; the exit runs the same value backwards and
  // pops only once it lands, so the screens swap while both are empty.
  const reduced = useReduceMotion();
  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(enter, {
      toValue: 1,
      duration: ZOOM_IN_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [enter]);

  // Every way out gets the reverse zoom: the back pill (which just calls
  // goBack), Android's hardware back, anything that pops this route. The flag
  // marks the re-dispatched action so the handler doesn't intercept its own.
  const leaving = useRef(false);
  useEffect(
    () =>
      navigation.addListener('beforeRemove', (e) => {
        // A RESET is the navigator being rebuilt under us (sign-out, lock) —
        // never hold that up for an animation.
        if (leaving.current || e.data.action.type === 'RESET') return;
        e.preventDefault();
        leaving.current = true;
        closeDayView(enter, () => navigation.dispatch(e.data.action));
      }),
    [navigation, enter],
  );

  const enterZoom = {
    opacity: enter,
    transform: [
      { scale: enter.interpolate({ inputRange: [0, 1], outputRange: zoomRange(ENTER_ZOOM, 1, reduced) }) },
    ],
  };

  const monthLabel = new Date(anchor + 'T12:00:00').toLocaleDateString(undefined, { month: 'long' });
  const topPad = insets.top + TOP_BAR_ROW;

  const onToday = () => {
    setAnchor(ymd(new Date()));
    (isList ? agendaRef : timelineRef).current?.scrollToToday(true);
  };

  return (
    <View style={styles.screen}>
      <Animated.View style={[StyleSheet.absoluteFill, enterZoom]}>
        <Animated.View
          style={[StyleSheet.absoluteFill, { paddingTop: topPad }, timelineLayer]}
          pointerEvents={isList ? 'none' : 'auto'}
        >
          <TimelineView
            ref={timelineRef}
            anchor={anchor}
            dayCount={mode === 'multi' ? 2 : 1}
            onChangeAnchor={setAnchor}
          />
        </Animated.View>
        {listMounted ? (
          <Animated.View
            style={[StyleSheet.absoluteFill, { paddingTop: topPad }, listLayer]}
            pointerEvents={isList ? 'auto' : 'none'}
          >
            <AgendaView ref={agendaRef} anchor={anchor} />
          </Animated.View>
        ) : null}
      </Animated.View>

      <DayViewChrome monthLabel={monthLabel} date={anchor} mode={mode} onMode={setMode} onToday={onToday} enter={enter} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
});
