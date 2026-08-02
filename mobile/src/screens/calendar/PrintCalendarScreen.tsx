import React, { useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Switch, Alert, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useOwnedAddons } from '../../lib/addons';
import {
  CALENDARS,
  useCalendarVisibility,
  useCalendarColors,
  useCustomCalendars,
  useDeletedDefaultCalendars,
  useHolidayCalendars,
  holidayEnabledIds,
} from '../../lib/calendarPrefs';
import { loadCalendarData } from '../../lib/calendarData';
import { getHolidays } from '../../lib/holidays';
import { buildPrintHtml, PrintCalendar, PrintLayout } from '../../lib/printCalendar';
import { ymd } from '../../lib/calendar';
import { colors, spacing } from '../../theme';

// Print options (Calendars → Print). Selection is seeded from the visibility
// toggles one screen back but kept local — printing one calendar must not
// hide the others app-wide. Rendering happens on-device (see printCalendar.ts)
// and hands off to the OS print dialog, which supplies preview/paper/copies.

// expo-print / expo-sharing are native modules added after some installed
// dev builds. Require them lazily (not at module eval) so an older binary
// still boots the app — tapping Print then explains instead of white-screening
// everything at startup.
const loadPrint = () => require('expo-print') as typeof import('expo-print');
const loadSharing = () => require('expo-sharing') as typeof import('expo-sharing');

type AgendaPreset = 'week' | 'twoWeeks' | 'month';

const AGENDA_PRESETS: { key: AgendaPreset; label: string }[] = [
  { key: 'week', label: 'This week' },
  { key: 'twoWeeks', label: 'Next 2 weeks' },
  { key: 'month', label: 'This month' },
];

// Weather never prints — it has no printable records.
const NON_PRINTABLE_IDS = ['weather'];

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

export default function PrintCalendarScreen() {
  const { visibility } = useCalendarVisibility();
  const { colors: calColors } = useCalendarColors();
  const { calendars: customCalendars } = useCustomCalendars();
  const { deletedIds } = useDeletedDefaultCalendars();
  const { calendars: holidayCals } = useHolidayCalendars();

  const now = new Date();
  const [layout, setLayout] = useState<PrintLayout>('month');
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() });
  const [preset, setPreset] = useState<AgendaPreset>('twoWeeks');
  const [useColor, setUseColor] = useState(true);
  const [use24h, setUse24h] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<'print' | 'share' | null>(null);

  // Every printable calendar row, in the checklist's order. Locked add-on
  // calendars are excluded (their items are already dropped at the
  // loadCalendarData chokepoint; hiding the row keeps the checklist honest).
  const { owned, isUnlocked } = useOwnedAddons();
  const allCalendars: PrintCalendar[] = useMemo(() => {
    const defaults = CALENDARS.filter(
      (c) => !NON_PRINTABLE_IDS.includes(c.id) && !deletedIds.includes(c.id) && isUnlocked(c.id)
    ).map((c) => ({ id: c.id, name: c.name, color: calColors[c.id] ?? c.color }));
    const custom = customCalendars.map((c) => ({ id: c.id, name: c.name, color: c.color }));
    const holidays = holidayCals.map((c) => ({ id: c.id, name: c.name, color: calColors[c.id] ?? c.color }));
    return [...defaults, ...custom, ...holidays];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deletedIds, calColors, customCalendars, holidayCals, owned]);

  // Selection: null = "follow visibility" until the user touches a switch.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const isSelected = (id: string) => overrides[id] ?? visibility[id] !== false;
  const selected = allCalendars.filter((c) => isSelected(c.id));

  const monthLabel = new Date(cursor.year, cursor.month, 1).toLocaleDateString(undefined, {
    month: 'long', year: 'numeric',
  });

  const stepMonth = (delta: number) => {
    const d = new Date(cursor.year, cursor.month + delta, 1);
    setCursor({ year: d.getFullYear(), month: d.getMonth() });
  };

  // Inclusive yyyy-MM-dd print range. Month layout covers the whole 6-week
  // grid (leading/trailing cells included); agenda uses the preset.
  const range = useMemo(() => {
    if (layout === 'month') {
      const first = new Date(cursor.year, cursor.month, 1);
      const gridStart = addDays(first, -first.getDay());
      return { from: ymd(gridStart), to: ymd(addDays(gridStart, 41)) };
    }
    const today = new Date();
    if (preset === 'week') return { from: ymd(today), to: ymd(addDays(today, 6)) };
    if (preset === 'twoWeeks') return { from: ymd(today), to: ymd(addDays(today, 13)) };
    return {
      from: ymd(new Date(today.getFullYear(), today.getMonth(), 1)),
      to: ymd(new Date(today.getFullYear(), today.getMonth() + 1, 0)),
    };
  }, [layout, cursor, preset]);

  const buildHtml = async (): Promise<string> => {
    const [fy, fm, fd] = range.from.split('-').map(Number);
    const [ty, tm, td] = range.to.split('-').map(Number);
    const fromDate = new Date(fy, fm - 1, fd);
    const toDate = new Date(ty, tm - 1, td, 23, 59, 59);
    const data = await loadCalendarData({ from: fromDate.toISOString(), to: toDate.toISOString() });
    // Every selected holiday calendar's holidays, each tagged for the legend.
    const holidays = holidayCals
      .filter((cal) => isSelected(cal.id))
      .flatMap((cal) =>
        getHolidays(cal.country, fromDate, toDate, holidayEnabledIds(cal)).map((h) => ({
          calendarId: cal.id,
          name: h.name,
          date: h.date,
        }))
      );
    return buildPrintHtml(
      {
        layout,
        from: range.from,
        to: range.to,
        months: [{ year: cursor.year, month: cursor.month }],
        calendars: selected,
        useColor,
        use24h,
      },
      data,
      holidays
    );
  };

  const guardSelection = (): boolean => {
    if (selected.length > 0) return true;
    Alert.alert('No calendars selected', 'Choose at least one calendar to print.');
    return false;
  };

  const explainError = (e: any, fallbackTitle: string) => {
    const msg = String(e?.message ?? '');
    // Dismissing the iOS print dialog rejects — that's a cancel, not an error.
    if (/cancel|did not complete/i.test(msg)) return;
    if (/native module|ExpoPrint|ExpoSharing/i.test(msg)) {
      Alert.alert(
        'App update needed',
        'Printing was added after this build of the app was installed. Install a fresh development build, then try again.'
      );
      return;
    }
    Alert.alert(fallbackTitle, msg || 'Something went wrong.');
  };

  const onPrint = async () => {
    if (!guardSelection()) return;
    setBusy('print');
    try {
      const Print = loadPrint();
      const html = await buildHtml();
      await Print.printAsync({
        html,
        orientation: layout === 'month' ? Print.Orientation.landscape : Print.Orientation.portrait,
      });
    } catch (e: any) {
      explainError(e, 'Could not print');
    } finally {
      setBusy(null);
    }
  };

  const onShare = async () => {
    if (!guardSelection()) return;
    setBusy('share');
    try {
      const Print = loadPrint();
      const Sharing = loadSharing();
      const html = await buildHtml();
      // Letter-sized points; landscape for the month grid.
      const size = layout === 'month' ? { width: 792, height: 612 } : { width: 612, height: 792 };
      const { uri } = await Print.printToFileAsync({ html, ...size });
      await Sharing.shareAsync(uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf' });
    } catch (e: any) {
      explainError(e, 'Could not create PDF');
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* ── Layout ── */}
      <Text style={styles.groupLabel}>LAYOUT</Text>
      <View style={styles.segment}>
        {(
          [
            { key: 'month', label: 'Month grid' },
            { key: 'agenda', label: 'Agenda list' },
          ] as { key: PrintLayout; label: string }[]
        ).map((s) => (
          <TouchableOpacity
            key={s.key}
            style={[styles.segmentBtn, layout === s.key && styles.segmentBtnOn]}
            onPress={() => setLayout(s.key)}
          >
            <Text style={[styles.segmentText, layout === s.key && styles.segmentTextOn]}>{s.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* ── Range ── */}
      <Text style={styles.groupLabel}>{layout === 'month' ? 'MONTH' : 'RANGE'}</Text>
      {layout === 'month' ? (
        <View style={styles.stepper}>
          <TouchableOpacity style={styles.stepBtn} onPress={() => stepMonth(-1)}>
            <Ionicons name="chevron-back" size={20} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.stepLabel}>{monthLabel}</Text>
          <TouchableOpacity style={styles.stepBtn} onPress={() => stepMonth(1)}>
            <Ionicons name="chevron-forward" size={20} color={colors.text} />
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.chips}>
          {AGENDA_PRESETS.map((p) => (
            <TouchableOpacity
              key={p.key}
              style={[styles.chip, preset === p.key && styles.chipOn]}
              onPress={() => setPreset(p.key)}
            >
              <Text style={[styles.chipText, preset === p.key && styles.chipTextOn]}>{p.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* ── Calendars (collapsed summary → checklist) ── */}
      <Text style={styles.groupLabel}>CALENDARS</Text>
      <TouchableOpacity style={styles.summaryRow} activeOpacity={0.7} onPress={() => setExpanded((v) => !v)}>
        <Text style={styles.summaryText}>
          {selected.length === allCalendars.length ? 'All calendars' : `${selected.length} of ${allCalendars.length}`}
        </Text>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textMuted} />
      </TouchableOpacity>
      {expanded ? (
        <View style={styles.checklist}>
          {allCalendars.map((cal) => {
            const on = isSelected(cal.id);
            return (
              <View key={cal.id} style={styles.row}>
                <View style={[styles.accent, { backgroundColor: cal.color, opacity: on ? 1 : 0.25 }]} />
                <Text style={[styles.name, !on && styles.nameOff]}>{cal.name}</Text>
                <Switch
                  value={on}
                  onValueChange={(v) => setOverrides((o) => ({ ...o, [cal.id]: v }))}
                  trackColor={{ true: cal.color }}
                />
              </View>
            );
          })}
        </View>
      ) : null}

      {/* ── Options ── */}
      <Text style={styles.groupLabel}>OPTIONS</Text>
      <View style={styles.row}>
        <Text style={styles.name}>Print calendar colours</Text>
        <Switch value={useColor} onValueChange={setUseColor} trackColor={{ true: colors.primary }} />
      </View>
      <View style={styles.row}>
        <Text style={styles.name}>24-hour clock</Text>
        <Switch value={use24h} onValueChange={setUse24h} trackColor={{ true: colors.primary }} />
      </View>
      <Text style={styles.hint}>
        {useColor
          ? selected.length > 1
            ? 'A colour legend prints at the bottom of the page.'
            : ''
          : 'Black & white: events are tagged with a short calendar code instead.'}
      </Text>

      {/* ── Actions ── */}
      <TouchableOpacity style={styles.printBtn} activeOpacity={0.8} onPress={onPrint} disabled={busy !== null}>
        {busy === 'print' ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <>
            <Ionicons name="print-outline" size={20} color="#fff" />
            <Text style={styles.printBtnText}>Print</Text>
          </>
        )}
      </TouchableOpacity>
      <TouchableOpacity style={styles.shareBtn} activeOpacity={0.8} onPress={onShare} disabled={busy !== null}>
        {busy === 'share' ? (
          <ActivityIndicator color={colors.text} />
        ) : (
          <>
            <Ionicons name="share-outline" size={20} color={colors.text} />
            <Text style={styles.shareBtnText}>Share PDF</Text>
          </>
        )}
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  groupLabel: { fontSize: 11, fontWeight: '700', color: colors.textMuted, letterSpacing: 1, marginBottom: spacing.sm, marginTop: spacing.lg },
  segment: { flexDirection: 'row', backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 3 },
  segmentBtn: { flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: 'center' },
  segmentBtnOn: { backgroundColor: colors.primary },
  segmentText: { fontSize: 14, fontWeight: '600', color: colors.textMuted },
  segmentTextOn: { color: '#fff' },
  stepper: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border },
  stepBtn: { padding: 12 },
  stepLabel: { flex: 1, textAlign: 'center', fontSize: 15, fontWeight: '600', color: colors.text },
  chips: { flexDirection: 'row', gap: spacing.sm },
  chip: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 13, fontWeight: '600', color: colors.textMuted },
  chipTextOn: { color: '#fff' },
  summaryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, paddingHorizontal: spacing.md, backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border },
  summaryText: { fontSize: 15, fontWeight: '600', color: colors.text },
  checklist: { marginTop: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 8 },
  accent: { width: 4, height: 36, borderRadius: 2 },
  name: { flex: 1, fontSize: 16, color: colors.text },
  nameOff: { opacity: 0.4 },
  hint: { fontSize: 12, color: colors.textMuted, marginTop: 2, minHeight: 16 },
  printBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 14, marginTop: spacing.xl },
  printBtnText: { fontSize: 16, fontWeight: '700', color: '#fff' },
  shareBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border, paddingVertical: 14, marginTop: spacing.sm },
  shareBtnText: { fontSize: 16, fontWeight: '600', color: colors.text },
});
