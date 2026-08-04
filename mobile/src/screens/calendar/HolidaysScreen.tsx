import React, { useEffect, useMemo } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { getHolidays, getHolidayDefs, regionalHolidaysLabel, HolidayDef } from '../../lib/holidays';
import { useHolidayCalendars, useCustomCalendars } from '../../lib/calendarPrefs';
import { colorOf } from '../../lib/calendar';
import { Card, Hint, HeaderIconButton } from '../../components/ui';
import { colors, spacing } from '../../theme';
import type { CalendarStackParamList } from '../../navigation/CalendarNavigator';

type Nav = NativeStackNavigationProp<CalendarStackParamList>;

// Per-calendar holiday editor (one country's holidays):
//   • National — always shown (no toggle), with each date.
//   • Provincial / State — pick one or more subdivisions; the selected ones'
//     holidays then show (with dates), no per-holiday toggle.
//   • Cultural / Religious — individually toggleable.
export default function HolidaysScreen() {
  const nav = useNavigation<Nav>();
  const { calendarId } = useRoute<RouteProp<CalendarStackParamList, 'Holidays'>>().params;
  const { calendars, toggle, isEnabled, toggleRegion, isRegionSelected } = useHolidayCalendars();
  const { calendars: customCals } = useCustomCalendars();
  const cal = calendars.find((c) => c.id === calendarId);
  // Shared holiday calendars are the owner's to configure; a housemate reads.
  const rec = customCals.find((c) => c.id === calendarId);
  const readOnly = rec ? !rec.mine : false;

  useEffect(() => {
    if (!cal) return;
    // No header pencil — the Calendars view's per-row edit button is the
    // single path to a calendar's name/colour/sharing form. The one header
    // action is the alarm bell (same as the Occasions view): holiday alerts,
    // which are device-local, so a housemate reading a shared calendar sets
    // their own.
    nav.setOptions({
      title: cal.name,
      headerRight: () => (
        <HeaderIconButton
          icon="notifications-outline"
          size={26}
          color={colorOf(cal.id)}
          accessibilityLabel="Holiday alert settings"
          onPress={() => nav.navigate('HolidayAlerts', { calendarId: cal.id })}
        />
      ),
    });
  }, [cal, nav]);

  const defs = useMemo(() => (cal ? getHolidayDefs(cal.country) : []), [cal]);

  // This year's date for each holiday id (day + month; the year is irrelevant to
  // the label but floating holidays need a concrete year to resolve).
  const dateById = useMemo(() => {
    if (!cal) return {} as Record<string, string>;
    const year = new Date().getFullYear();
    const map: Record<string, string> = {};
    for (const h of getHolidays(cal.country, new Date(year, 0, 1), new Date(year, 11, 31))) {
      if (!(h.id in map)) map[h.id] = h.date;
    }
    return map;
  }, [cal]);

  const fmtDate = (id: string): string => {
    const iso = dateById[id];
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  // Provincial/state holidays grouped by subdivision, in first-seen order.
  const regionalGroups = useMemo(() => {
    const order: string[] = [];
    const byRegion: Record<string, HolidayDef[]> = {};
    for (const d of defs) {
      if (d.group !== 'regional' || !d.region) continue;
      if (!byRegion[d.region]) {
        byRegion[d.region] = [];
        order.push(d.region);
      }
      byRegion[d.region].push(d);
    }
    return order.map((region) => ({ region, defs: byRegion[region] }));
  }, [defs]);

  const national = defs.filter((d) => d.group === 'statutory');
  const cultural = defs.filter((d) => d.group === 'cultural');
  // Religious holidays roam the Gregorian year, so order them by this year's date.
  const religious = defs
    .filter((d) => d.group === 'multicultural')
    .sort((a, b) => (dateById[a.id] ?? '').localeCompare(dateById[b.id] ?? ''));

  if (!cal) {
    return (
      <View style={styles.missing}>
        <Text style={styles.missingText}>This holiday calendar is no longer available.</Text>
      </View>
    );
  }

  // A read-only holiday row: name on the left, date on the right.
  const infoRow = (def: HolidayDef) => (
    <View key={def.id} style={styles.row}>
      <Text style={styles.name}>{def.name}</Text>
      <Text style={styles.date}>{fmtDate(def.id)}</Text>
    </View>
  );

  // A toggleable holiday row (cultural / religious) — name on the left, date on
  // the right (religious dates are approximate, so they're flagged as such).
  const toggleRow = (def: HolidayDef, approx = false) => {
    const on = isEnabled(cal.id, def.id);
    return (
      <TouchableOpacity
        key={def.id}
        style={styles.row}
        activeOpacity={0.7}
        disabled={readOnly}
        onPress={() => toggle(cal.id, def.id)}
      >
        <Ionicons name={on ? 'checkbox' : 'square-outline'} size={22} color={on ? colors.primary : colors.textMuted} />
        <Text style={styles.name}>{def.name}</Text>
        {approx ? <Text style={styles.approx}>approx.</Text> : null}
        <Text style={styles.date}>{fmtDate(def.id)}</Text>
      </TouchableOpacity>
    );
  };

  const groupHead = (label: string) => (
    <View style={styles.cardHead}>
      <Text style={styles.groupLabel}>{label}</Text>
    </View>
  );

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Hint>Choose which of {cal.name} to display on your calendar.</Hint>

      {national.length > 0 ? (
        <Card style={styles.card}>
          {groupHead('National Holidays')}
          {national.map(infoRow)}
        </Card>
      ) : null}

      {regionalGroups.length > 0 ? (
        <Card style={styles.card}>
          {groupHead(regionalHolidaysLabel(cal.country))}
          <Text style={styles.hint}>Select the regions whose holidays you want.</Text>
          {regionalGroups.map((g) => {
            const selected = isRegionSelected(cal.id, g.region);
            return (
              <View key={g.region}>
                <TouchableOpacity style={styles.row} activeOpacity={0.7} disabled={readOnly} onPress={() => toggleRegion(cal.id, g.region)}>
                  <Ionicons
                    name={selected ? 'checkbox' : 'square-outline'}
                    size={22}
                    color={selected ? colors.primary : colors.textMuted}
                  />
                  <Text style={styles.regionName}>{g.region}</Text>
                </TouchableOpacity>
                {selected
                  ? g.defs.map((def) => (
                      <View key={def.id} style={styles.regionalRow}>
                        <Text style={styles.name}>{def.name}</Text>
                        <Text style={styles.date}>{fmtDate(def.id)}</Text>
                      </View>
                    ))
                  : null}
              </View>
            );
          })}
        </Card>
      ) : null}

      {cultural.length > 0 ? (
        <Card style={styles.card}>
          {groupHead('Cultural Holidays')}
          {cultural.map((def) => toggleRow(def))}
        </Card>
      ) : null}

      {religious.length > 0 ? (
        <Card style={styles.card}>
          {groupHead('Religious Holidays')}
          {religious.map((def) => toggleRow(def, true))}
        </Card>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md },
  card: { marginBottom: spacing.md },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm },
  groupLabel: { fontSize: 15, fontWeight: '700', color: colors.text, flex: 1 },
  hint: { fontSize: 12, color: colors.textMuted, marginBottom: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 8 },
  regionName: { flex: 1, fontSize: 14, fontWeight: '600', color: colors.text },
  regionalRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingLeft: spacing.lg },
  name: { flex: 1, fontSize: 14, color: colors.text },
  date: { fontSize: 13, color: colors.textMuted },
  approx: { fontSize: 11, color: colors.textMuted },
  missing: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, backgroundColor: colors.background },
  missingText: { fontSize: 15, color: colors.textMuted, textAlign: 'center' },
});
