import React, { useState } from 'react';
import { View, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import { Text } from '../../components/Text';
import { Ionicons } from '@expo/vector-icons';
import { COLOR_PRESETS, useCalendarColors } from '../../lib/calendarPrefs';
import { useCalendarGroups } from '../../hooks/useCalendarGroups';
import { colors, spacing, radius } from '../../theme';

// Lets the user recolor and reorder their calendars, and re-sequence the
// audience sections themselves; all three persist to the account arrangement
// and flow through the Calendars manager, the calendar grid, day view, events
// list and search via lib/calendar.
//
// The list is the SAME list the Calendars manager shows (useCalendarGroups):
// every calendar the household has, sectioned by audience. It used to be built
// from the built-ins plus holiday calendars alone, so a calendar the user
// created or subscribed to never appeared here and could be neither recolored
// nor placed.
export default function CalendarColorsScreen() {
  const { colors: calColors, setColor, resetColor } = useCalendarColors();
  const { groups, order, setOrder, groupOrder, setGroupOrder } = useCalendarGroups();

  // One flat row model per section, in the section's own sequence: built-ins
  // carry their default color as the reset fallback, custom/subscribed/holiday
  // calendars their record color. Built-ins are not a block above the rest —
  // every calendar in a section moves against every other.
  const sections = groups
    .map((g) => ({
      key: g.key,
      label: g.label,
      items: g.items.map(({ cal }) => ({ id: cal.id, name: cal.name, color: cal.color })),
    }))
    .filter((s) => s.items.length > 0);

  // Persist the whole id sequence the screen is displaying, section by section.
  // The stored order is one flat list and every list re-sorts it per section,
  // so writing it in section order is what keeps a move inside one section from
  // reshuffling another.
  const commitOrder = (sectionKey: string, ids: string[]) => {
    const next = sections.flatMap((s) => (s.key === sectionKey ? ids : s.items.map((c) => c.id)));
    // Ranks for calendars this screen doesn't show (a locked add-on, a deleted
    // built-in) ride along at the end, so placing them again isn't the price of
    // reordering the ones that are here.
    const shown = new Set(next);
    setOrder([...next, ...order.filter((id) => !shown.has(id))]);
  };

  // Swap a calendar with its neighbour WITHIN its section — the sections are
  // audiences, so a calendar can't leave one by being nudged past its edge.
  const move = (sectionKey: string, index: number, dir: -1 | 1) => {
    const section = sections.find((s) => s.key === sectionKey);
    if (!section) return;
    const target = index + dir;
    if (target < 0 || target >= section.items.length) return;
    const ids = section.items.map((c) => c.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    commitOrder(sectionKey, ids);
  };

  // Swap two sections. Written as the full sequence (absolute, like the
  // calendar order) so the Calendars manager re-sections live.
  const moveSection = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= sections.length) return;
    const keys = sections.map((s) => s.key);
    [keys[index], keys[target]] = [keys[target], keys[index]];
    // Sections with nothing in them are filtered out of the display but still
    // hold a place in the stored sequence, so re-sequencing what IS on screen
    // can't silently drop them.
    const hidden = groupOrder.filter((k) => !keys.includes(k));
    setGroupOrder([...keys, ...hidden]);
  };

  const [openId, setOpenId] = useState<string | null>(null);
  // Local, instant selection. We only persist + apply app-wide when the panel
  // for a calendar is minimized, so picking a color feels immediate.
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
      {sections.map((section, sectionIndex) => (
        <View key={section.key} style={styles.section}>
          {/* The section header is itself reorderable: the sequence it lands in
              is the sequence the Calendars manager lists its groups in. */}
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionLabel}>{section.label}</Text>
            <View style={styles.reorder}>
              <TouchableOpacity
                style={styles.reorderBtn}
                onPress={() => moveSection(sectionIndex, -1)}
                disabled={sectionIndex === 0}
                hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                accessibilityRole="button"
                accessibilityLabel={`Move ${section.label} section up`}
              >
                <Ionicons
                  name="chevron-up"
                  size={18}
                  color={sectionIndex === 0 ? colors.border : colors.textMuted}
                />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.reorderBtn}
                onPress={() => moveSection(sectionIndex, 1)}
                disabled={sectionIndex === sections.length - 1}
                hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                accessibilityRole="button"
                accessibilityLabel={`Move ${section.label} section down`}
              >
                <Ionicons
                  name="chevron-down"
                  size={18}
                  color={sectionIndex === sections.length - 1 ? colors.border : colors.textMuted}
                />
              </TouchableOpacity>
            </View>
          </View>

          {section.items.map((cal, index) => {
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
                      onPress={() => move(section.key, index, -1)}
                      disabled={index === 0}
                      hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                      accessibilityRole="button"
                      accessibilityLabel={`Move ${cal.name} up`}
                    >
                      <Ionicons name="chevron-up" size={20} color={index === 0 ? colors.border : colors.textMuted} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.reorderBtn}
                      onPress={() => move(section.key, index, 1)}
                      disabled={index === section.items.length - 1}
                      hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                      accessibilityRole="button"
                      accessibilityLabel={`Move ${cal.name} down`}
                    >
                      <Ionicons
                        name="chevron-down"
                        size={20}
                        color={index === section.items.length - 1 ? colors.border : colors.textMuted}
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
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  section: { marginBottom: spacing.lg },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },
  sectionLabel: { flex: 1, fontSize: 11, fontWeight: '700', color: colors.textMuted, letterSpacing: 1 },
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
