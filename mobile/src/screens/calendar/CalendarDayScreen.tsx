import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, Animated } from 'react-native';
import { useRoute, RouteProp } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useDayViewMode } from '../../lib/calendarPrefs';
import { ymd } from '../../lib/calendar';
import { CalendarStackParamList } from '../../navigation/CalendarNavigator';
import { colors } from '../../theme';
import { TodayHandle } from './todayHandle';
import TimelineView from './dayview/TimelineView';
import AgendaView from './dayview/AgendaView';
import DayViewChrome, { TOP_BAR_ROW } from './dayview/DayViewChrome';

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

  const monthLabel = new Date(anchor + 'T12:00:00').toLocaleDateString(undefined, { month: 'long' });
  const topPad = insets.top + TOP_BAR_ROW;

  const onToday = () => {
    setAnchor(ymd(new Date()));
    (isList ? agendaRef : timelineRef).current?.scrollToToday(true);
  };

  return (
    <View style={styles.screen}>
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

      <DayViewChrome monthLabel={monthLabel} date={anchor} mode={mode} onMode={setMode} onToday={onToday} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
});
