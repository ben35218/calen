import React, { useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Switch, Alert, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRoute, type RouteProp } from '@react-navigation/native';
import type { CalendarData } from '../../api';
import { useCustomCalendars } from '../../lib/calendarPrefs';
import { loadCalendarData } from '../../lib/calendarData';
import { buildPrintHtml, PrintCalendar, PrintLayout } from '../../lib/printCalendar';
import { ymd } from '../../lib/calendar';
import type { RootStackParamList } from '../../navigation/types';
import { colors, spacing } from '../../theme';

// Free viewer mode's print sheet (the shell's Print button). Same on-device
// rendering as the unlocked app's Calendars → Print — E2EE means the HTML must
// be built client-side — but scoped to what a viewer may see: the calendars
// shared TO them, and nothing else. It deliberately does NOT reuse
// PrintCalendarScreen, whose checklist is built from the built-in lanes,
// holiday calendars, add-on ownership and the user's own visibility prefs —
// all paywalled surfaces here.
//
// expo-print / expo-sharing are native modules added after some installed dev
// builds. Require them lazily (not at module eval) so an older binary still
// boots — tapping Print then explains instead of white-screening at startup.
const loadPrint = () => require('expo-print') as typeof import('expo-print');
const loadSharing = () => require('expo-sharing') as typeof import('expo-sharing');

type Rt = RouteProp<RootStackParamList, 'ViewerPrint'>;
type AgendaPreset = 'week' | 'twoWeeks' | 'month';

const AGENDA_PRESETS: { key: AgendaPreset; label: string }[] = [
  { key: 'week', label: 'This week' },
  { key: 'twoWeeks', label: 'Next 2 weeks' },
  { key: 'month', label: 'This month' },
];

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

export default function ViewerPrintScreen() {
  const params = useRoute<Rt>().params;
  const { calendars } = useCustomCalendars();

  const now = new Date();
  const [layout, setLayout] = useState<PrintLayout>('month');
  // Opens on the month the grid was showing, so Print prints what's on screen.
  const [cursor, setCursor] = useState({
    year: params?.year ?? now.getFullYear(),
    month: params?.month ?? now.getMonth(),
  });
  const [preset, setPreset] = useState<AgendaPreset>('twoWeeks');
  const [useColor, setUseColor] = useState(true);
  const [use24h, setUse24h] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<'print' | 'share' | null>(null);

  // The only printable calendars a viewer has: the ones shared TO them.
  const shared: PrintCalendar[] = useMemo(
    () =>
      calendars
        .filter((c) => !c.mine && !c.feedUrl && !c.holiday)
        .map((c) => ({ id: c.id, name: c.name, color: c.color })),
    [calendars],
  );

  // All shared calendars print unless the user unticks one.
  const [off, setOff] = useState<Record<string, boolean>>({});
  const isSelected = (id: string) => !off[id];
  const selected = shared.filter((c) => isSelected(c.id));

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
    const loaded = await loadCalendarData({ from: fromDate.toISOString(), to: toDate.toISOString() });
    // Belt and braces: the selected-id filter inside collectPrintItems already
    // drops everything but the shared calendars, and the viewer's own lanes are
    // emptied here too so nothing paywalled can reach the page.
    const sharedIds = new Set(shared.map((c) => c.id));
    const data = {
      ...loaded,
      events: (loaded.events ?? []).filter((e) => sharedIds.has(e.calendarType)),
      tasks: [], chores: [], recipes: [], trips: [], occasions: [], groceryShopping: [],
    } as unknown as CalendarData;
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
      [], // no holiday calendars in the viewer shell
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
        'Printing was added after this build of the app was installed. Install a fresh build, then try again.'
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
          <TouchableOpacity style={styles.stepBtn} onPress={() => stepMonth(-1)} accessibilityLabel="Previous month">
            <Ionicons name="chevron-back" size={20} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.stepLabel}>{monthLabel}</Text>
          <TouchableOpacity style={styles.stepBtn} onPress={() => stepMonth(1)} accessibilityLabel="Next month">
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

      {/* ── Calendars (only shown when there's a choice to make) ── */}
      {shared.length > 1 ? (
        <>
          <Text style={styles.groupLabel}>CALENDARS</Text>
          <TouchableOpacity style={styles.summaryRow} activeOpacity={0.7} onPress={() => setExpanded((v) => !v)}>
            <Text style={styles.summaryText}>
              {selected.length === shared.length ? 'All calendars' : `${selected.length} of ${shared.length}`}
            </Text>
            <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textMuted} />
          </TouchableOpacity>
          {expanded ? (
            <View style={styles.checklist}>
              {shared.map((cal) => {
                const on = isSelected(cal.id);
                return (
                  <View key={cal.id} style={styles.row}>
                    <View style={[styles.accent, { backgroundColor: cal.color, opacity: on ? 1 : 0.25 }]} />
                    <Text style={[styles.name, !on && styles.nameOff]}>{cal.name}</Text>
                    <Switch
                      value={on}
                      onValueChange={(v) => setOff((o) => ({ ...o, [cal.id]: !v }))}
                      trackColor={{ true: cal.color }}
                    />
                  </View>
                );
              })}
            </View>
          ) : null}
        </>
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
