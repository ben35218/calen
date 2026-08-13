import React, { useState } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { Text } from '../../components/Text';
import { Ionicons } from '@expo/vector-icons';
import { useRoute, RouteProp } from '@react-navigation/native';
import { Button, Screen, Select, SegmentedControl, SwitchRow, BottomSheet } from '../../components/ui';
import {
  RepeatRule,
  RepeatFreq,
  WeekdayKind,
  FREQ_OPTIONS,
  FREQ_UNITS,
  WEEKDAY_NAMES,
  MONTH_ABBREV,
  ORDINAL_OPTIONS,
  WEEKDAY_KIND_OPTIONS,
  repeatSummary,
} from '../../lib/eventRepeat';
import { setRepeatDraft } from '../../lib/repeatDraft';
import { form } from '../../components/formStyles';
import WheelPicker, { WHEEL_ITEM_H, WHEEL_VISIBLE } from '../../components/WheelPicker';
import { CalendarStackParamList } from '../../navigation/CalendarNavigator';
import { colors, spacing, radius } from '../../theme';

type Rt = RouteProp<CalendarStackParamList, 'EventRepeat'>;

type MonthlyMode = 'each' | 'onThe';

// Wheel range for "Every N <unit>" per frequency.
const EVERY_MAX: Record<RepeatFreq, number> = { daily: 30, weekly: 52, monthly: 24, yearly: 10 };

// Concrete pattern selections for the incoming rule, so the screen never opens
// with an empty pattern (mirrors what setFreq seeds on a frequency change).
function seedRule(initial: RepeatRule, startDate: Date): RepeatRule {
  if (!initial.freq) return { ...initial, freq: 'weekly', daysOfWeek: [startDate.getDay()] };
  if (initial.freq === 'weekly' && !initial.daysOfWeek.length) {
    return { ...initial, daysOfWeek: [startDate.getDay()] };
  }
  if (initial.freq === 'monthly' && !initial.daysOfMonth.length && initial.weekOfMonth == null) {
    return { ...initial, daysOfMonth: [startDate.getDate()] };
  }
  if (initial.freq === 'yearly' && !initial.months.length) {
    return { ...initial, months: [startDate.getMonth() + 1] };
  }
  return initial;
}

// Pushed from the event form's Repeat row ("Custom…" / the active custom rule).
// Edits sync back to the form live through the repeatDraft store; going back is
// the only "save". `date` is the event's start date, used to seed the pattern
// defaults when a frequency is first selected.
export default function EventRepeatScreen() {
  const { rule: initial, date } = useRoute<Rt>().params;
  // Local noon avoids TZ day-rollover (matches the ui.tsx date parsing).
  const startDate = new Date(`${date}T12:00:00`);

  const [rule, setRule] = useState<RepeatRule>(() => seedRule(initial, startDate));
  const [monthlyMode, setMonthlyMode] = useState<MonthlyMode>(
    initial.freq === 'monthly' && initial.weekOfMonth != null ? 'onThe' : 'each',
  );
  // The Every wheel edits a temp value; Done commits it (like the time picker).
  const [everyOpen, setEveryOpen] = useState(false);
  const [everyTemp, setEveryTemp] = useState(1);

  const sync = (patch: Partial<RepeatRule>) => {
    const next = { ...rule, ...patch };
    setRule(next);
    setRepeatDraft(next);
  };

  // Changing frequency reseeds that frequency's pattern from the event's start
  // date (weekly: its weekday; monthly: its date; yearly: its month) and drops
  // the others'.
  const setFreq = (freq: RepeatFreq) => {
    if (freq === rule.freq) return;
    setMonthlyMode('each');
    sync({
      freq,
      interval: Math.min(rule.interval, EVERY_MAX[freq]),
      daysOfWeek: freq === 'weekly' ? [startDate.getDay()] : [],
      daysOfMonth: freq === 'monthly' ? [startDate.getDate()] : [],
      months: freq === 'yearly' ? [startDate.getMonth() + 1] : [],
      weekOfMonth: null,
      weekdayKind: null,
    });
  };

  // At least one weekday / month date / month stays selected (a repeat on
  // nothing has no meaning), so the last one can't be toggled off.
  const toggleIn = (list: number[], v: number): number[] | null => {
    const on = list.includes(v);
    if (on && list.length === 1) return null;
    return on ? list.filter((x) => x !== v) : [...list, v].sort((a, b) => a - b);
  };
  const toggleWeekday = (d: number) => {
    const next = toggleIn(rule.daysOfWeek, d);
    if (next) sync({ daysOfWeek: next });
  };
  const toggleMonthDay = (d: number) => {
    const next = toggleIn(rule.daysOfMonth, d);
    if (next) sync({ daysOfMonth: next });
  };
  const toggleMonth = (m: number) => {
    const next = toggleIn(rule.months, m);
    if (next) sync({ months: next });
  };

  const setMode = (m: MonthlyMode) => {
    setMonthlyMode(m);
    if (m === 'each') {
      sync({ daysOfMonth: rule.daysOfMonth.length ? rule.daysOfMonth : [startDate.getDate()], weekOfMonth: null, weekdayKind: null });
    } else {
      sync({ daysOfMonth: [], weekOfMonth: rule.weekOfMonth ?? 1, weekdayKind: rule.weekdayKind ?? 'sun' });
    }
  };

  // Yearly "Days of Week" switch: on = an ordinal rule within each chosen
  // month; off = the event's date in each chosen month.
  const yearlyOrdinalOn = rule.weekOfMonth != null;
  const toggleYearlyOrdinal = (on: boolean) =>
    sync(on ? { weekOfMonth: 1, weekdayKind: 'sun' } : { weekOfMonth: null, weekdayKind: null });

  const freq = rule.freq as RepeatFreq;
  const units = FREQ_UNITS[freq];
  const unitLabel = rule.interval === 1 ? units[0] : units[1];
  const tempUnitLabel = everyTemp === 1 ? units[0] : units[1];
  // "Weekly on Monday" -> "Event will repeat weekly on Monday."
  const summary = repeatSummary(rule);
  const summarySentence = `Event will repeat ${summary.charAt(0).toLowerCase()}${summary.slice(1)}.`;

  const openEvery = () => {
    setEveryTemp(Math.min(rule.interval, EVERY_MAX[freq]));
    setEveryOpen(true);
  };

  const ordinalSelects = (
    <>
      <Select
        inlineLabel="On the"
        value={rule.weekOfMonth ?? 1}
        options={ORDINAL_OPTIONS}
        onChange={(v) => sync({ weekOfMonth: (v as number) ?? 1 })}
        containerStyle={form.dtFieldWrap}
        fieldStyle={form.rowField}
        valueStyle={form.dtValue}
        chevronIcon="chevron-expand"
      />
      <View style={form.cardDivider} />
      <Select
        inlineLabel="Day"
        value={rule.weekdayKind ?? 'sun'}
        options={WEEKDAY_KIND_OPTIONS}
        onChange={(v) => sync({ weekdayKind: (v as WeekdayKind) ?? 'sun' })}
        containerStyle={form.dtFieldWrap}
        fieldStyle={form.rowField}
        valueStyle={form.dtValue}
        chevronIcon="chevron-expand"
      />
    </>
  );

  return (
    <Screen>
      {/* Frequency / Every */}
      <View style={form.groupCard}>
        <Select
          inlineLabel="Frequency"
          value={freq}
          options={FREQ_OPTIONS}
          onChange={(v) => setFreq((v as RepeatFreq) ?? 'weekly')}
          containerStyle={form.dtFieldWrap}
          fieldStyle={form.rowField}
          valueStyle={form.dtValue}
          chevronIcon="chevron-expand"
        />
        <View style={form.cardDivider} />
        <TouchableOpacity style={form.dtRow} activeOpacity={0.7} onPress={openEvery}>
          <Text style={form.dtLabel}>Every</Text>
          <Text style={form.groupValue}>{rule.interval} {unitLabel}</Text>
          <Ionicons name="chevron-expand" size={18} color={colors.textMuted} style={form.rowChevron} />
        </TouchableOpacity>
      </View>

      {/* Weekly: pick the weekday(s) */}
      {freq === 'weekly' ? (
        <View style={form.groupCard}>
          {WEEKDAY_NAMES.map((name, d) => (
            <React.Fragment key={name}>
              {d > 0 ? <View style={form.cardDivider} /> : null}
              <TouchableOpacity style={form.dtRow} activeOpacity={0.7} onPress={() => toggleWeekday(d)}>
                <Text style={form.dtLabel}>{name}</Text>
                {rule.daysOfWeek.includes(d) ? <Ionicons name="checkmark" size={20} color={colors.primary} /> : null}
              </TouchableOpacity>
            </React.Fragment>
          ))}
        </View>
      ) : null}

      {/* Monthly: numbered dates ("Each") or an ordinal rule ("On the…") */}
      {freq === 'monthly' ? (
        <>
          <SegmentedControl<MonthlyMode>
            value={monthlyMode}
            onChange={setMode}
            options={[
              { label: 'Each', value: 'each' },
              { label: 'On the…', value: 'onThe' },
            ]}
          />
          <View style={{ height: spacing.md }} />

          {monthlyMode === 'each' ? (
            <View style={[form.groupCard, styles.gridPad]}>
              <View style={styles.grid}>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => {
                  const sel = rule.daysOfMonth.includes(d);
                  return (
                    <TouchableOpacity
                      key={d}
                      style={[styles.gridCell, sel && styles.gridCellSel]}
                      onPress={() => toggleMonthDay(d)}
                    >
                      <Text style={[styles.gridCellText, sel && styles.gridCellTextSel]}>{d}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          ) : (
            <View style={form.groupCard}>{ordinalSelects}</View>
          )}
        </>
      ) : null}

      {/* Yearly: pick the month(s), plus an optional ordinal weekday rule */}
      {freq === 'yearly' ? (
        <>
          <View style={[form.groupCard, styles.gridPad]}>
            <View style={styles.grid}>
              {MONTH_ABBREV.map((name, i) => {
                const sel = rule.months.includes(i + 1);
                return (
                  <TouchableOpacity
                    key={name}
                    style={[styles.monthCell, sel && styles.gridCellSel]}
                    onPress={() => toggleMonth(i + 1)}
                  >
                    <Text style={[styles.gridCellText, sel && styles.gridCellTextSel]}>{name}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          <View style={form.groupCard}>
            <View style={form.groupPad}>
              <SwitchRow label="Days of week" value={yearlyOrdinalOn} onValueChange={toggleYearlyOrdinal} />
            </View>
            {yearlyOrdinalOn ? (
              <>
                <View style={form.cardDivider} />
                {ordinalSelects}
              </>
            ) : null}
          </View>
        </>
      ) : null}

      <Text style={styles.summary}>{summarySentence}</Text>

      {/* "Every" wheel — the time picker's bottom sheet: spin, then Done commits. */}
      <BottomSheet visible={everyOpen} onClose={() => setEveryOpen(false)} style={styles.everySheet}>
        <View style={styles.wheelRow}>
          {/* Selection band spans the number + unit, like the native spinner's. */}
          <View pointerEvents="none" style={styles.wheelBand} />
          <WheelPicker
            // Remount per open so the wheel re-positions on the current value.
            key={String(everyOpen)}
            items={Array.from({ length: EVERY_MAX[freq] }, (_, i) => ({ label: String(i + 1), value: i + 1 }))}
            value={everyTemp}
            onChange={setEveryTemp}
          />
          <Text style={styles.wheelUnit}>{tempUnitLabel}</Text>
        </View>
        <Button
          title="Done"
          onPress={() => {
            sync({ interval: everyTemp });
            setEveryOpen(false);
          }}
        />
      </BottomSheet>
    </Screen>
  );
}

// Grouped-card styles come from components/formStyles; only the grid/wheel
// styles are local.
const styles = StyleSheet.create({
  // 1..31 date grid (7 columns, like a month view) / Jan..Dec grid (4 columns)
  gridPad: { padding: spacing.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  gridCell: {
    width: `${100 / 7}%`, aspectRatio: 1.4,
    alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm,
  },
  monthCell: {
    width: '25%', paddingVertical: 12,
    alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm,
  },
  gridCellSel: { backgroundColor: colors.primary },
  gridCellText: { fontSize: 15, color: colors.text },
  gridCellTextSel: { color: '#fff', fontWeight: '600' },
  summary: { fontSize: 13, color: colors.textMuted, marginTop: -spacing.xs, marginBottom: spacing.md },
  // "Every" wheel content inside the shared BottomSheet.
  everySheet: { gap: spacing.sm },
  wheelRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: spacing.md, height: WHEEL_ITEM_H * WHEEL_VISIBLE,
  },
  wheelBand: {
    position: 'absolute', left: 0, right: 0,
    top: ((WHEEL_VISIBLE - 1) / 2) * WHEEL_ITEM_H, height: WHEEL_ITEM_H,
    borderRadius: radius.sm, backgroundColor: colors.border + '55',
  },
  wheelUnit: { fontSize: 23, color: colors.text },
});
