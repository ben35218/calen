import React, { useLayoutEffect, useRef } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, RefreshControl, LayoutChangeEvent } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQuery } from '@tanstack/react-query';
import { occasionKindFromLabel } from '@household/calendar';
import { useAuth } from '../../store/auth';
import { peopleApi, ecardsApi, Person, OccasionKind, ECard } from '../../api';
import { openRecord } from '../../lib/e2ee';
import * as replica from '../../lib/replica';
import { normalizePerson } from '../../lib/personFields';
import { occasionIcon, occasionNoun, occasionFocusKey } from '../../lib/occasions';
import { CALENDAR_COLORS } from '../../lib/calendar';
import { Card, CenteredLoader, EmptyState, Hint, IconAvatar, HeaderIconButton, SectionHeader } from '../../components/ui';
import { useOwnedAddons } from '../../lib/addons';
import AddonLockedView from '../plan/AddonLockedView';
import { colors, spacing } from '../../theme';
import type { CalendarStackParamList } from '../../navigation/CalendarNavigator';

type Nav = NativeStackNavigationProp<CalendarStackParamList>;

const ACCENT = CALENDAR_COLORS.birthdays;
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

interface Upcoming {
  person: Person;
  kind: OccasionKind;
  label: string;   // 'Birthday' or the raw contact date label
  month: number;   // 1-based
  day: number;
  daysUntil: number;
  years: number | null; // origin year → age / years since
  hidden: boolean; // the person is excluded from the Occasions calendar
}

// Parse a YYYY-MM-DD value; returns null when it isn't a real month/day.
function parseYmd(value: string | undefined): { y: number; mo: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
  if (!m) return null;
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
}

// Every occasion on file (birthdays + labeled contact dates), sorted by next
// occurrence from today. Mirrors the shared engine's derivation, computed here
// for the upcoming list.
function upcomingOccasions(people: Person[]): Upcoming[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const out: Upcoming[] = [];
  const add = (person: Person, kind: OccasionKind, label: string, value: string | undefined) => {
    const p = parseYmd(value);
    if (!p) return;
    let next = new Date(today.getFullYear(), p.mo - 1, p.d);
    if (next < today) next = new Date(today.getFullYear() + 1, p.mo - 1, p.d);
    const daysUntil = Math.round((next.getTime() - today.getTime()) / 86400000);
    const years = p.y > 1900 && p.y <= today.getFullYear() ? next.getFullYear() - p.y : null;
    out.push({ person, kind, label, month: p.mo, day: p.d, daysUntil, years, hidden: Boolean(person.occasionsHidden) });
  };
  for (const person of people) {
    if (person.birthday) add(person, 'birthday', 'Birthday', String(person.birthday).slice(0, 10));
    for (const entry of normalizePerson(person).dates) {
      add(person, occasionKindFromLabel(entry.label), entry.label || 'Date', entry.value);
    }
  }
  return out.sort((a, b) => a.daysUntil - b.daysUntil || a.person.name.localeCompare(b.person.name));
}

function whenLabel(daysUntil: number): string {
  if (daysUntil === 0) return 'Today';
  if (daysUntil === 1) return 'Tomorrow';
  if (daysUntil < 30) return `in ${daysUntil} days`;
  return '';
}

function yearsLabel(kind: OccasionKind, years: number | null): string {
  if (!years) return '';
  return kind === 'birthday' ? ` · turns ${years}` : ` · ${years} years`;
}

// The Occasions calendar's drill-in from My Calendars: everyone's birthday plus
// labeled contact dates (anniversary/marriage/death/custom) from People, ordered
// by who's next. Rows open the person (dates are edited there); the card button
// schedules an e-card for that occasion. Free add-on gate: Occasions is opt-in
// (see billing-plans spec) — until claimed, every entry path lands on the locked
// view (add-on key stays `birthdays`).
export default function OccasionsScreen() {
  const { isUnlocked, loaded } = useOwnedAddons();
  if (!loaded) return <CenteredLoader color={ACCENT} />;
  if (!isUnlocked('birthdays')) return <AddonLockedView addon="birthdays" />;
  return <OccasionsHome />;
}

function OccasionsHome() {
  const nav = useNavigation<Nav>();
  const route = useRoute<RouteProp<CalendarStackParamList, 'Birthdays'>>();
  const { user } = useAuth();
  const selfId = String(user?._id ?? '');

  // A tapped-from-calendar occasion to scroll to + highlight.
  const focus = route.params?.focus;
  const focusKey = focus ? occasionFocusKey(focus) : null;
  const scrollRef = useRef<ScrollView>(null);
  const scrolledToFocus = useRef(false);

  useLayoutEffect(() => {
    nav.setOptions({
      headerRight: () => (
        <HeaderIconButton
          icon="notifications-outline"
          size={26}
          color={ACCENT}
          accessibilityLabel="Occasion alert settings"
          onPress={() => nav.navigate('OccasionAlerts')}
        />
      ),
    });
  }, [nav]);

  // Same offline-first fetch as PeopleScreen (shared query key, so the roster
  // cache is reused): sync the replica, decrypt content over plaintext.
  const { data: people, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['people'],
    queryFn: async () => {
      try {
        const rows = (await peopleApi.list()).data;
        replica.upsert('Person', rows as any).catch(() => {});
        return Promise.all(rows.map((p) => openRecord('Person', p)));
      } catch (e) {
        const cached = await replica.getAll<Person>('Person');
        if (cached.length) return Promise.all(cached.map((p) => openRecord('Person', p)));
        throw e;
      }
    },
  });

  // Scheduled e-cards, so each occasion row can show whether a card is set.
  const { data: ecards } = useQuery({
    queryKey: ['ecards'],
    queryFn: () => ecardsApi.list().then((r) => r.data),
  });

  if (isLoading || !people) {
    return <CenteredLoader color={ACCENT} />;
  }

  // Match an occasion to a scheduled card by contact + kind + month/day.
  const cardKey = (personId: string, kind: string, month: number, day: number) => `${personId}|${kind}|${month}|${day}`;
  const cardByOccasion = new Map<string, ECard>();
  for (const c of ecards ?? []) {
    if (c.personId) cardByOccasion.set(cardKey(String(c.personId), c.kind, c.month, c.day), c);
  }

  const upcoming = upcomingOccasions(people);
  const visible = upcoming.filter((o) => !o.hidden);
  const hiddenOccasions = upcoming.filter((o) => o.hidden);

  // Scroll the tapped occasion to the top of the list, once, after it lays out.
  const onFocusRowLayout = (e: LayoutChangeEvent) => {
    if (scrolledToFocus.current) return;
    scrolledToFocus.current = true;
    const y = e.nativeEvent.layout.y;
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: Math.max(0, y - spacing.md), animated: true }));
  };

  const renderRow = (o: Upcoming, i: number) => {
    const isSelf = Boolean(o.person.accountId && String(o.person.accountId) === selfId);
    const when = o.hidden ? '' : whenLabel(o.daysUntil);
    const card = cardByOccasion.get(cardKey(o.person._id, o.kind, o.month, o.day));
    const isFocused = Boolean(
      focusKey &&
      focusKey === occasionFocusKey({ personId: o.person._id, kind: o.kind, month: o.month, day: o.day, label: o.label })
    );
    return (
      <TouchableOpacity
        key={`${o.person._id}-${o.kind}-${o.month}-${o.day}-${i}`}
        activeOpacity={0.7}
        onLayout={isFocused ? onFocusRowLayout : undefined}
        onPress={() => nav.navigate('PersonForm', { id: o.person._id, isSelf: isSelf || undefined, focus: 'dates' })}
      >
        <Card style={[styles.row, !o.hidden && o.daysUntil === 0 && styles.todayRow, o.hidden && styles.hiddenRow, isFocused && styles.focusedRow]}>
          <IconAvatar mdiIcon={o.hidden ? 'eye-off-outline' : occasionIcon(o.kind)} bg={o.hidden ? colors.textMuted : ACCENT} size={40} />
          <View style={styles.main}>
            <Text style={styles.name}>
              {o.person.name}
              {isSelf ? ' (you)' : ''}
            </Text>
            <Text style={styles.date}>
              {occasionNoun({ kind: o.kind, label: o.label })} · {MONTHS[o.month - 1]} {o.day}
              {yearsLabel(o.kind, o.years)}
            </Text>
          </View>
          {when ? <Text style={[styles.when, o.daysUntil === 0 && styles.whenToday]}>{when}</Text> : null}
          <TouchableOpacity
            accessibilityLabel={card ? 'Edit scheduled e-card' : 'Schedule an e-card'}
            hitSlop={8}
            style={styles.cardBtn}
            onPress={() => nav.navigate('ECardForm', {
              personId: o.person._id,
              personName: o.person.name,
              kind: o.kind,
              occasionLabel: o.label,
              month: o.month,
              day: o.day,
              ecardId: card?._id,
            })}
          >
            <MaterialCommunityIcons name={card ? 'email-check' : 'email-plus-outline'} size={22} color={ACCENT} />
          </TouchableOpacity>
        </Card>
      </TouchableOpacity>
    );
  };

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
    >
      <Hint>Occasions come from your People — birthdays plus anniversaries and other dates on a person&apos;s card. Tap one to edit its dates or hide it from the calendar.</Hint>

      {visible.map((o, i) => renderRow(o, i))}

      {hiddenOccasions.length ? (
        <>
          <SectionHeader style={styles.hiddenHeader}>Hidden from calendar</SectionHeader>
          {hiddenOccasions.map((o, i) => renderRow(o, i))}
        </>
      ) : null}

      {upcoming.length === 0 ? (
        <EmptyState
          variant="inline"
          mdiIcon="calendar-heart"
          title="No occasions yet"
          accent={ACCENT}
        >
          <TouchableOpacity style={styles.emptyBtn} onPress={() => nav.navigate('People')}>
            <Ionicons name="people-outline" size={16} color={colors.primary} />
            <Text style={styles.emptyBtnText}>Add dates in Contacts</Text>
          </TouchableOpacity>
        </EmptyState>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.sm },
  todayRow: { borderWidth: 1, borderColor: ACCENT },
  // The occasion tapped from the calendar: a bolder outline + faint accent wash.
  focusedRow: { borderWidth: 2, borderColor: ACCENT, backgroundColor: `${ACCENT}1A` },
  hiddenRow: { opacity: 0.55 },
  hiddenHeader: { marginTop: spacing.md },
  main: { flex: 1 },
  name: { fontSize: 16, fontWeight: '600', color: colors.text },
  date: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  when: { fontSize: 13, fontWeight: '600', color: colors.textMuted },
  whenToday: { color: ACCENT },
  cardBtn: { padding: 4 },
  emptyBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: spacing.md },
  emptyBtnText: { color: colors.primary, fontWeight: '600', fontSize: 14 },
});
