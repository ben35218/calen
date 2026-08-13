import React, { useMemo, useState } from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import { Text, TextInput } from './Text';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { colors, radius, spacing } from '../theme';

type MdiName = keyof typeof MaterialCommunityIcons.glyphMap;

// Every MaterialCommunityIcons glyph, computed once. Searching spans the full set
// so the user can find anything; the curated `suggested` list is what shows when
// the search box is empty.
const ALL_ICONS = Object.keys(MaterialCommunityIcons.glyphMap) as MdiName[];
// Cap search results so a broad query (e.g. "car") doesn't try to render hundreds
// of tiles at once.
const MAX_RESULTS = 60;

export default function IconPicker({
  value,
  onChange,
  suggested,
  accent = colors.primary,
}: {
  // Currently selected glyph (bare MCI name, no `mdi-` prefix). null/undefined = none.
  value?: string | null;
  onChange: (name: string) => void;
  // Curated shortlist shown when not searching.
  suggested: string[];
  accent?: string;
}) {
  const [query, setQuery] = useState('');
  // The picker is collapsed by default; the header row shows the current glyph
  // and expands the search + grid on tap.
  const [open, setOpen] = useState(false);
  const q = query.trim().toLowerCase();

  const results = useMemo(() => {
    if (!q) {
      // Keep the current selection visible even if it isn't in the shortlist
      // (e.g. picked earlier via search).
      const base = suggested.slice();
      if (value && !base.includes(value)) base.unshift(value);
      return base;
    }
    const matches = ALL_ICONS.filter((n) => n.includes(q));
    // Prefix matches first so "car" surfaces `car`, `car-battery`… before `race-car`.
    matches.sort((a, b) => Number(b.startsWith(q)) - Number(a.startsWith(q)));
    return matches.slice(0, MAX_RESULTS);
  }, [q, suggested, value]);

  return (
    <View>
      <TouchableOpacity
        style={styles.header}
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityLabel={open ? 'Collapse icon picker' : 'Expand icon picker'}
      >
        <View style={[styles.preview, { borderColor: value ? accent : colors.border }]}>
          <MaterialCommunityIcons
            name={(value as MdiName) || 'image-outline'}
            size={22}
            color={value ? accent : colors.textMuted}
          />
        </View>
        <Text style={styles.headerLabel}>{value ? 'Icon' : 'Choose an icon'}</Text>
        <MaterialCommunityIcons
          name={open ? 'chevron-up' : 'chevron-down'}
          size={22}
          color={colors.textMuted}
        />
      </TouchableOpacity>

      {!open ? null : (
      <>
      <View style={styles.searchWrap}>
        <MaterialCommunityIcons name="magnify" size={18} color={colors.textMuted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search icons…"
          placeholderTextColor={colors.textMuted}
          style={styles.searchInput}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
        {query ? (
          <TouchableOpacity onPress={() => setQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <MaterialCommunityIcons name="close-circle" size={18} color={colors.textMuted} />
          </TouchableOpacity>
        ) : null}
      </View>

      {results.length === 0 ? (
        <Text style={styles.empty}>No icons match “{query.trim()}”.</Text>
      ) : (
        <View style={styles.grid}>
          {results.map((name) => {
            const selected = value === name;
            return (
              <TouchableOpacity
                key={name}
                style={[styles.option, selected && { backgroundColor: accent, borderColor: accent }]}
                onPress={() => onChange(name)}
                accessibilityLabel={`Icon ${name}`}
              >
                <MaterialCommunityIcons name={name as MdiName} size={22} color={selected ? '#fff' : colors.textMuted} />
              </TouchableOpacity>
            );
          })}
        </View>
      )}
      </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  preview: {
    width: 40,
    height: 40,
    borderRadius: radius.sm,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerLabel: { flex: 1, fontSize: 15, color: colors.text },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    marginHorizontal: 14,
    height: 40,
  },
  searchInput: { flex: 1, fontSize: 15, color: colors.text, padding: 0 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 14 },
  option: {
    width: 44,
    height: 44,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: { fontSize: 14, color: colors.textMuted, padding: 14 },
});
