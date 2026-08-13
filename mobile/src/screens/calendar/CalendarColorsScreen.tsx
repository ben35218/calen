import React, { useState } from 'react';
import { View, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import { Text } from '../../components/Text';
import { Ionicons } from '@expo/vector-icons';
import {
  CALENDARS,
  COLOR_PRESETS,
  useCalendarColors,
  useCalendarOrder,
  useHolidayCalendars,
  sortByCalendarOrder,
} from '../../lib/calendarPrefs';
import { Hint } from '../../components/ui';
import { useOwnedAddons } from '../../lib/addons';
import { colors, spacing, radius } from '../../theme';

// Lets the user recolour and reorder each calendar; both persist and flow
// through the calendar grid, day view, events list and search via lib/calendar.
export default function CalendarColorsScreen() {
  const { colors: calColors, setColor, resetColor } = useCalendarColors();
  const { calendars: holidayCals } = useHolidayCalendars();
  const { order, setOrder } = useCalendarOrder();
  const { isUnlocked } = useOwnedAddons();
  // Built-in + per-country holiday calendars share the same recolour flow; each
  // holiday calendar's base colour is its reset fallback. The user's saved order
  // wins; unordered calendars (e.g. a freshly added one) trail in natural order.
  // Locked add-on calendars are excluded — the household doesn't have them.
  const items = sortByCalendarOrder(
    [
      ...CALENDARS.filter((c) => isUnlocked(c.id)).map((c) => ({ id: c.id, name: c.name, color: c.color })),
      ...holidayCals.map((c) => ({ id: c.id, name: c.name, color: c.color })),
    ],
    order
  );

  // Swap a calendar with its neighbour, then persist the whole id sequence so
  // the new order sticks and re-sorts every calendar list live.
  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= items.length) return;
    const ids = items.map((c) => c.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setOrder(ids);
  };

  const [openId, setOpenId] = useState<string | null>(null);
  // Local, instant selection. We only persist + apply app-wide when the panel
  // for a calendar is minimized, so picking a colour feels immediate.
  const [draft, setDraft] = useState<Record<string, string>>({});

  const commit = (id: string) => {
    const picked = draft[id];
    if (picked && picked.toLowerCase() !== (calColors[id] ?? '').toLowerCase()) setColor(id, picked);
    setDraft((d) => {
      const n = { ...d };
      delete n[id];
      return n;
    });
  };

  const togglePanel = (id: string) => {
    if (openId === id) {
      commit(id);
      setOpenId(null);
    } else {
      if (openId) commit(openId);
      setOpenId(id);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Hint>Tap a calendar to recolour it; use the arrows to reorder. Changes apply everywhere.</Hint>

      {items.map((cal, index) => {
        const current = draft[cal.id] ?? calColors[cal.id] ?? cal.color;
        const open = openId === cal.id;
        return (
          <View key={cal.id} style={styles.card}>
            <TouchableOpacity style={styles.row} activeOpacity={0.7} onPress={() => togglePanel(cal.id)}>
              <View style={[styles.swatch, { backgroundColor: current }]} />
              <Text style={styles.name}>{cal.name}</Text>
              <View style={styles.reorder}>
                <TouchableOpacity
                  style={styles.reorderBtn}
                  onPress={() => move(index, -1)}
                  disabled={index === 0}
                  hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                  accessibilityRole="button"
                  accessibilityLabel={`Move ${cal.name} up`}
                >
                  <Ionicons name="chevron-up" size={20} color={index === 0 ? colors.border : colors.textMuted} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.reorderBtn}
                  onPress={() => move(index, 1)}
                  disabled={index === items.length - 1}
                  hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                  accessibilityRole="button"
                  accessibilityLabel={`Move ${cal.name} down`}
                >
                  <Ionicons
                    name="chevron-down"
                    size={20}
                    color={index === items.length - 1 ? colors.border : colors.textMuted}
                  />
                </TouchableOpacity>
              </View>
              {open ? (
                <View style={[styles.confirmBadge, { backgroundColor: current }]}>
                  <Ionicons name="checkmark" size={16} color="#fff" />
                </View>
              ) : (
                <Ionicons name="color-palette-outline" size={18} color={colors.textMuted} />
              )}
            </TouchableOpacity>

            {open ? (
              <View style={styles.palette}>
                {COLOR_PRESETS.map((c) => {
                  const selected = c.toLowerCase() === current.toLowerCase();
                  return (
                    <TouchableOpacity
                      key={c}
                      style={[styles.paletteSwatch, { backgroundColor: c }, selected && styles.paletteSelected]}
                      onPress={() => setDraft((d) => ({ ...d, [cal.id]: c }))}
                    >
                      {selected ? <Ionicons name="checkmark" size={16} color="#fff" /> : null}
                    </TouchableOpacity>
                  );
                })}
                <TouchableOpacity
                  style={styles.resetBtn}
                  onPress={() => {
                    resetColor(cal.id);
                    setDraft((d) => {
                      const n = { ...d };
                      delete n[cal.id];
                      return n;
                    });
                  }}
                >
                  <Ionicons name="refresh" size={14} color={colors.textMuted} />
                  <Text style={styles.resetText}>Reset</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md },
  card: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, marginBottom: spacing.sm, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md },
  swatch: { width: 28, height: 28, borderRadius: 6 },
  confirmBadge: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  name: { flex: 1, fontSize: 16, color: colors.text },
  reorder: { flexDirection: 'row', alignItems: 'center' },
  reorderBtn: { paddingHorizontal: 2 },
  palette: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingHorizontal: spacing.md, paddingBottom: spacing.md },
  paletteSwatch: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  paletteSelected: { borderWidth: 3, borderColor: '#fff' },
  resetBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, height: 36, borderRadius: 18, borderWidth: 1, borderColor: colors.border },
  resetText: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
});
