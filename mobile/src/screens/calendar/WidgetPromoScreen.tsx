import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { FixedText, Text } from '../../components/Text';
import { Card, Hint, Screen, SectionHeader, Skeleton } from '../../components/ui';
import {
  computeWidgetSnapshot,
  type WidgetDay,
} from '../../lib/widgetSnapshot';
import { getInstalledWidgetCount } from '../../../modules/calen-widget';
import { colors, radius, spacing } from '../../theme';

// The Home Screen widget promo (spec: features/calendar.md — Home-screen
// widget; the nudge cadence that presents it is notifications.md "Widget
// nudge"). iOS has no API to add a widget for the user, so this screen is the
// whole pitch: a mock of the widget rendered from the user's OWN next days
// (computeWidgetSnapshot — the same pipeline that feeds the real widget), then
// the manual add steps. Reached from the widget-adoption nudge and, durably,
// from the Profile "Home Screen Widget" row.

// Mirror of the widget's own sample day (targets/widget/index.swift) — the
// preview falls back to it when the user's next two weeks are empty or the
// vault is locked, so the pitch never renders as a blank rectangle.
const SAMPLE_DAY: WidgetDay = {
  date: '',
  allDay: [],
  timed: [
    { title: 'Morning practice', color: '#388E3C', startMin: 9 * 60, endMin: 10 * 60 },
    { title: 'Dentist', color: '#1976D2', startMin: 13 * 60 + 30, endMin: 14 * 60 + 30 },
    { title: 'Dinner with friends', color: '#5E35B1', startMin: 18 * 60 + 30, endMin: 20 * 60 },
  ],
};

// Compact time in the widget's own style: "4 PM", "9:30 AM".
function fmtTime(min: number, withMeridiem: boolean): string {
  const clamped = Math.min(min, 24 * 60);
  const h24 = Math.floor(clamped / 60) % 24;
  const m = clamped % 60;
  const h = h24 % 12 || 12;
  const base = m ? `${h}:${String(m).padStart(2, '0')}` : `${h}`;
  return withMeridiem ? `${base} ${h24 < 12 ? 'AM' : 'PM'}` : base;
}

// "4–5 PM", "9:30–10 AM", "11 AM–1 PM" — the start's meridiem is dropped when
// it matches the end's, like the widget (and Apple's).
export function timeRangeLabel(startMin: number, endMin: number): string {
  const sAM = Math.floor(Math.min(startMin, 24 * 60 - 1) / 60) % 24 < 12;
  const eAM = Math.floor(Math.min(endMin, 24 * 60 - 1) / 60) % 24 < 12;
  return `${fmtTime(startMin, sAM !== eAM)}–${fmtTime(endMin, true)}`;
}

// The first covered day that actually holds something — today's card when
// today has items, else the nearest busy day (its header says which day it
// is, so a "TUESDAY 18" preview reads correctly, not as a wrong today).
export function pickPreviewDay(days: WidgetDay[] | undefined): WidgetDay | null {
  return days?.find((d) => d.allDay.length > 0 || d.timed.length > 0) ?? null;
}

// All-day kind → trailing label, mirroring the widget's allDayKindLabel.
const KIND_LABELS: Record<string, string> = {
  trip: 'Trip', holiday: 'Holiday', occasion: 'Occasion', task: 'Task',
  chore: 'Chore', recipe: 'Meal', grocery: 'Grocery',
};

// A mock of the small widget, drawn with the app's primitives in the widget's
// visual language (accent weekday eyebrow, big day number, colour-tinted
// chips). Fixed geometry throughout — FixedText, per the Dynamic Type rules.
function WidgetMock({ day, sample }: { day: WidgetDay; sample: boolean }) {
  const date = sample || !day.date ? new Date() : new Date(day.date + 'T12:00:00');
  const weekday = date.toLocaleDateString(undefined, { weekday: 'long' }).toUpperCase();
  const rows: React.ReactNode[] = [];
  for (const [i, a] of day.allDay.slice(0, 2).entries()) {
    rows.push(
      <View key={`a${i}`} style={[styles.chip, { backgroundColor: a.color + '2B' }]}>
        <View style={[styles.chipBar, { backgroundColor: a.color }]} />
        <FixedText numberOfLines={1} style={[styles.chipTitle, styles.chipFlex, a.struck && styles.struck, { color: a.color }]}>
          {a.title}
        </FixedText>
        <FixedText style={[styles.chipTime, { color: a.color }]}>
          {KIND_LABELS[a.kind] ?? 'All day'}
        </FixedText>
      </View>,
    );
  }
  for (const [i, t] of day.timed.slice(0, 3 - Math.min(day.allDay.length, 2)).entries()) {
    rows.push(
      <View key={`t${i}`} style={[styles.chip, { backgroundColor: t.color + '2B' }]}>
        <View style={[styles.chipBar, { backgroundColor: t.color }]} />
        <View style={styles.chipFlex}>
          <FixedText numberOfLines={1} style={[styles.chipTitle, t.struck && styles.struck, { color: t.color }]}>
            {t.title}
          </FixedText>
          <FixedText numberOfLines={1} style={[styles.chipTime, { color: t.color }]}>
            {timeRangeLabel(t.startMin, t.endMin)}
          </FixedText>
        </View>
      </View>,
    );
  }
  return (
    <View style={styles.mock}>
      <FixedText style={styles.mockWeekday}>{weekday}</FixedText>
      <FixedText style={styles.mockDay}>{date.getDate()}</FixedText>
      <View style={styles.mockChips}>{rows}</View>
    </View>
  );
}

const STEPS = [
  'Touch and hold an empty spot on your Home Screen until the apps jiggle.',
  'Tap Edit in the top corner, then Add Widget. (On older iOS, tap the + instead.)',
  'Search for Calen, pick a size, and tap Add Widget.',
];

export default function WidgetPromoScreen() {
  // The preview is the user's own data through the widget's exact pipeline; a
  // locked vault or empty fortnight falls back to the sample day.
  const snap = useQuery({ queryKey: ['widgetPromoSnapshot'], queryFn: computeWidgetSnapshot });
  // Whether a Calen widget is already on the Home/Lock Screen (null = no
  // bridge, unknowable — treated as not installed for display).
  const installed = useQuery({ queryKey: ['widgetInstalled'], queryFn: getInstalledWidgetCount });

  const ownDay = pickPreviewDay(snap.data?.days);
  const day = ownDay ?? SAMPLE_DAY;
  const hasWidget = (installed.data ?? 0) > 0;

  return (
    <Screen>
      <View style={styles.hero}>
        <Text style={styles.heroTitle}>Your day, on your Home Screen</Text>
        <Text style={styles.heroSub}>
          The Calen widget shows today's schedule at a glance — and keeps itself up to date, even
          when you don't open the app.
        </Text>
      </View>

      <View style={styles.previewWrap}>
        {snap.isLoading ? (
          <Skeleton width={172} height={172} radius={radius.lg * 2} />
        ) : (
          <WidgetMock day={day} sample={!ownDay} />
        )}
        <Hint style={styles.previewHint}>
          {ownDay
            ? 'A preview of the small widget, showing your own calendar.'
            : 'A preview of the small widget. Once your calendar has events, it shows your own day.'}
        </Hint>
      </View>

      <Hint style={styles.privacyHint}>
        The widget is drawn from data already on your phone — nothing new leaves your device.
      </Hint>

      {hasWidget ? (
        <Card style={styles.installedCard}>
          <Ionicons name="checkmark-circle" size={22} color={colors.success} />
          <Text style={styles.installedText}>
            The Calen widget is on your Home Screen. You can add more sizes anytime with the steps
            below.
          </Text>
        </Card>
      ) : null}

      <SectionHeader style={styles.section}>
        {hasWidget ? 'Add another size' : 'Add it in seconds'}
      </SectionHeader>
      <Card style={styles.steps}>
        {STEPS.map((step, i) => (
          <View key={i} style={styles.stepRow}>
            <View style={styles.stepDisc}>
              <FixedText style={styles.stepNum}>{i + 1}</FixedText>
            </View>
            <Text style={styles.stepText}>{step}</Text>
          </View>
        ))}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: {
    alignItems: 'center',
    paddingTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  heroTitle: { fontSize: 24, fontWeight: '700', color: colors.text, textAlign: 'center' },
  heroSub: { fontSize: 15, color: colors.textMuted, textAlign: 'center' },

  previewWrap: { alignItems: 'center', marginTop: spacing.lg, gap: spacing.sm },
  previewHint: { textAlign: 'center' },
  privacyHint: { textAlign: 'center', marginTop: spacing.sm, paddingHorizontal: spacing.lg },

  // The mock small widget: iOS-widget proportions (~square, big corner round),
  // on the widget's own background so the chips read exactly as they will on
  // the Home Screen.
  mock: {
    width: 172,
    height: 172,
    borderRadius: radius.lg * 2,
    backgroundColor: '#000',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingVertical: 14,
    paddingHorizontal: 14,
  },
  mockWeekday: { fontSize: 11, fontWeight: '600', color: colors.primary, letterSpacing: 0.5 },
  mockDay: { fontSize: 26, fontWeight: '500', color: colors.text },
  mockChips: { marginTop: 6, gap: 4 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 7,
    paddingVertical: 2,
    paddingLeft: 4,
    paddingRight: 6,
  },
  chipBar: { width: 3, borderRadius: 1.5, alignSelf: 'stretch', marginVertical: 1 },
  chipFlex: { flex: 1, minWidth: 0 },
  chipTitle: { fontSize: 11, fontWeight: '600' },
  chipTime: { fontSize: 10, opacity: 0.8 },
  struck: { textDecorationLine: 'line-through', opacity: 0.55 },

  installedCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  installedText: { flex: 1, fontSize: 14, color: colors.text },

  section: { marginTop: spacing.xl, marginBottom: spacing.sm },
  steps: { gap: spacing.md },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  stepDisc: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  stepNum: { color: '#fff', fontSize: 13, fontWeight: '700' },
  stepText: { flex: 1, fontSize: 15, color: colors.text },
});
