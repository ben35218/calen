import React, { useState } from 'react';
import { View, StyleSheet, TouchableOpacity, Animated } from 'react-native';
import { Text } from '../../../components/Text';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import AnchoredMenu, { AnchoredMenuItem } from '../../../components/AnchoredMenu';
import AssistantButton from '../../../components/AssistantButton';
import { DayViewMode } from '../../../lib/calendarPrefs';
import { useAiEnabled } from '../../../lib/privacyPrefs';
import { colors, spacing } from '../../../theme';
import { popIn, useReduceMotion } from '../dayTransition';
import { DayNav } from './dayNav';

// Matches CalendarScreen's floating-pill vocabulary.
const PILL_BG = colors.surface;
const BTN_FG = '#fff';
export const TOP_BAR_ROW = 52;

// The day-view mode switcher, in menu order (List sits apart below a divider,
// mirroring Apple Calendar's Single Day / Multi Day / List menu). Each mode's
// glyph is also shown on the switcher button itself.
const MODE_META: { key: DayViewMode; label: string; icon: string; dividerBefore?: boolean }[] = [
  { key: 'single', label: 'Single Day', icon: 'view-day-outline' },
  { key: 'multi', label: 'Multi Day', icon: 'view-column-outline' },
  { key: 'list', label: 'List', icon: 'format-list-bulleted', dividerBefore: true },
];

// The day view's floating chrome, floating over whichever layer is active:
// back-to-month pill (labelled with the anchor's month) and the switcher/search/
// add pill on top; the Today | Calendars pill and the Calen FAB along the
// bottom. The bottom row deliberately matches CalendarScreen's exactly — the
// day view is the same canvas, so its floating controls must not differ.
// (The Invitations inbox lives in Profile — badged via the month view's avatar
// — not in this chrome.)
export default function DayViewChrome({
  monthLabel,
  date,
  mode,
  onMode,
  onToday,
  enter,
}: {
  monthLabel: string;
  date: string;
  mode: DayViewMode;
  onMode: (m: DayViewMode) => void;
  onToday: () => void;
  // The host's month ⇄ day zoom (0 = away, 1 = in place). Only the TOP row
  // rides it — the bottom row is the month view's own, unmoved.
  enter: Animated.Value;
}) {
  const navigation = useNavigation<DayNav>();
  const insets = useSafeAreaInsets();
  const aiEnabled = useAiEnabled();
  const reduced = useReduceMotion();
  const [menuOpen, setMenuOpen] = useState(false);

  const topZoom = { opacity: enter, transform: [{ scale: popIn(enter, reduced) }] };

  const menuItems: AnchoredMenuItem[] = MODE_META.map((m) => ({
    key: m.key,
    label: m.label,
    active: mode === m.key,
    dividerBefore: m.dividerBefore,
    icon: <MaterialCommunityIcons name={m.icon as any} size={20} color={colors.text} />,
    onPress: () => onMode(m.key),
  }));
  const activeIcon = MODE_META.find((m) => m.key === mode)?.icon ?? 'view-day-outline';

  return (
    <>
      <Animated.View
        style={[styles.topChrome, topZoom, { paddingTop: insets.top, height: insets.top + TOP_BAR_ROW }]}
        pointerEvents="box-none"
      >
        <TouchableOpacity
          style={[styles.pill, styles.backPill]}
          activeOpacity={0.8}
          onPress={() => navigation.goBack()}
          accessibilityLabel="Back to month"
        >
          <Ionicons name="chevron-back" size={20} color={BTN_FG} />
          <Text style={styles.backText}>{monthLabel}</Text>
        </TouchableOpacity>
        <View style={styles.pill}>
          <TouchableOpacity
            style={styles.pillBtn}
            onPress={() => setMenuOpen(true)}
            accessibilityLabel="Change day view"
          >
            <MaterialCommunityIcons name={activeIcon as any} size={22} color={BTN_FG} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.pillBtn} onPress={() => navigation.navigate('CalendarSearch')}>
            <Ionicons name="search" size={20} color={BTN_FG} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.pillBtn} onPress={() => navigation.navigate('EventForm', { date })}>
            <Ionicons name="add" size={26} color={BTN_FG} />
          </TouchableOpacity>
        </View>
      </Animated.View>

      <AnchoredMenu
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        top={insets.top + TOP_BAR_ROW}
        items={menuItems}
      />

      {/* ── Bottom chrome: identical to the month view's — Today | Calendars on
          the left, the Calen FAB alone on the right. (Back to the month is the
          top-left pill, so no calendar glyph down here.) ── */}
      <View style={[styles.pill, styles.bottomLeft, { bottom: insets.bottom + 16 }]}>
        <TouchableOpacity style={styles.todayBtn} onPress={onToday}>
          <Text style={styles.todayText}>Today</Text>
        </TouchableOpacity>
        <View style={styles.pillDivider} />
        <TouchableOpacity style={styles.todayBtn} onPress={() => navigation.navigate('Calendars')}>
          <Text style={styles.todayText}>Calendars</Text>
        </TouchableOpacity>
      </View>

      {aiEnabled ? (
        <AssistantButton
          style={[styles.bottomRight, { bottom: insets.bottom + 16 }]}
          onPress={() => navigation.navigate('Assistant', { initial: 'calendar' })}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  topChrome: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 20,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
  },
  pill: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: PILL_BG, borderRadius: 999,
    paddingHorizontal: 6, paddingVertical: 4,
    shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 3,
  },
  backPill: { paddingLeft: 8, paddingRight: 14, paddingVertical: 8 },
  backText: { color: BTN_FG, fontSize: 17, fontWeight: '700', marginLeft: 2 },
  pillBtn: { paddingHorizontal: 8, paddingVertical: 6 },
  bottomLeft: { position: 'absolute', left: spacing.md, zIndex: 10 },
  bottomRight: { position: 'absolute', right: spacing.md, zIndex: 10 },
  pillDivider: { width: StyleSheet.hairlineWidth, height: 20, backgroundColor: colors.border },
  // 16, not the 22 this pill used when Today sat in it alone: with a second
  // label beside it the wider padding pushed the divider off-centre and stretched
  // the group. Must stay in step with CalendarScreen's todayBtn.
  todayBtn: { paddingHorizontal: 16, paddingVertical: 6 },
  todayText: { color: BTN_FG, fontSize: 17, fontWeight: '700' },
});
