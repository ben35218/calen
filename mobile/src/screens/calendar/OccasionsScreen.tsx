import React, { useLayoutEffect, useRef, useState } from 'react';
import { View, ScrollView, StyleSheet, TouchableOpacity, RefreshControl, LayoutChangeEvent } from 'react-native';
import { Text } from '../../components/Text';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../store/auth';
import { contactsApi, ecardsApi, Contact, OccasionKind, ECard } from '../../api';
import { openRecord } from '../../lib/e2ee';
import * as replica from '../../lib/replica';
import {
  occasionIcon, occasionNoun, occasionFocusKey,
  collectOccasions, whenLabel, Occasion, COMING_UP_DAYS, PAST_WINDOW_DAYS,
} from '../../lib/occasions';
import { CALENDAR_COLORS } from '../../lib/calendar';
import { Card, CenteredLoader, EmptyState, Hint, IconAvatar, HeaderIconButton, SectionHeader, SkeletonList } from '../../components/ui';
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

function yearsLabel(kind: OccasionKind, years: number | null): string {
  if (!years) return '';
  return kind === 'birthday' ? ` · turns ${years}` : ` · ${years} years`;
}

// The Occasions calendar's drill-in from My Calendars: everyone's birthday plus
// labeled contact dates (anniversary/marriage/death/custom) from Contacts, ordered
// by who's next. Rows open the contact (dates are edited there); the card button
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
  const [showLater, setShowLater] = useState(false);

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

  // Same offline-first fetch as ContactsScreen (shared query key, so the roster
  // cache is reused): sync the replica, decrypt content over plaintext.
  const { data: contacts, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['contacts'],
    queryFn: async () => {
      try {
        const rows = (await contactsApi.list()).data;
        replica.upsert('Contact', rows as any).catch(() => {});
        return Promise.all(rows.map((p) => openRecord('Contact', p)));
      } catch (e) {
        const cached = await replica.getAll<Contact>('Contact');
        if (cached.length) return Promise.all(cached.map((p) => openRecord('Contact', p)));
        throw e;
      }
    },
  });

  // Scheduled e-cards, so each occasion row can show whether a card is set.
  const { data: ecards } = useQuery({
    queryKey: ['ecards'],
    queryFn: () => ecardsApi.list().then((r) => r.data),
  });

  if (isLoading || !contacts) {
    return <SkeletonList />;
  }

  // Match an occasion to a scheduled card by contact + kind + month/day. ACTIVE
  // cards drive the "schedule/edit" envelope; a card that already sent
  // (active:false, sentAt set) instead marks its row — today's or recently
  // passed — as "Sent". Sent rows persist server-side forever, so only a card
  // sent within the past window counts: last year's card must not label this
  // year's occurrence as sent.
  const cardKey = (contactId: string, kind: string, month: number, day: number) => `${contactId}|${kind}|${month}|${day}`;
  const activeCard = new Map<string, ECard>();
  const sentCard = new Map<string, ECard>();
  for (const c of ecards ?? []) {
    if (!c.contactId) continue;
    const k = cardKey(String(c.contactId), c.kind, c.month, c.day);
    if (c.active) activeCard.set(k, c);
    else if (c.sentAt && Date.now() - new Date(c.sentAt).getTime() <= (PAST_WINDOW_DAYS + 1) * 86400000) sentCard.set(k, c);
  }

  // Contacts hidden from the Occasions calendar (occasionsHidden) are omitted
  // entirely — they don't appear anywhere in this list.
  const visible = collectOccasions(contacts).filter((o) => !o.hidden);
  const recentlyPassed = visible.filter((o) => o.offset < 0);
  // Today's occasions sit directly under the "Today" marker — they're happening,
  // not "coming up", so they render above that section's header.
  const todayOccasions = visible.filter((o) => o.offset === 0);
  const comingUp = visible.filter((o) => o.offset > 0 && o.offset <= COMING_UP_DAYS);
  const later = visible.filter((o) => o.offset > COMING_UP_DAYS);

  const occKey = (o: Occasion) => occasionFocusKey({ contactId: o.contact._id, kind: o.kind, month: o.month, day: o.day, label: o.label });
  // Auto-expand "Later this year" when the occasion tapped from the calendar lives there.
  const focusInLater = Boolean(focusKey && later.some((o) => focusKey === occKey(o)));
  const laterOpen = showLater || focusInLater;

  const now = new Date();
  const todayLabel = `${MONTHS[now.getMonth()]} ${now.getDate()}`;

  // Scroll the tapped occasion to the top of the list, once, after it lays out.
  const onFocusRowLayout = (e: LayoutChangeEvent) => {
    if (scrolledToFocus.current) return;
    scrolledToFocus.current = true;
    const y = e.nativeEvent.layout.y;
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: Math.max(0, y - spacing.md), animated: true }));
  };

  const renderRow = (o: Occasion, i: number, variant: 'past' | 'upcoming' | 'later') => {
    const isSelf = Boolean(o.contact.accountId && String(o.contact.accountId) === selfId);
    const isPast = variant === 'past';
    const isToday = o.offset === 0;
    // "Later" rows drop the "in N days" cue and lean on the month/day; near-term
    // rows carry the relative when-label.
    const when = variant === 'later' ? '' : whenLabel(o.offset);
    const key = cardKey(o.contact._id, o.kind, o.month, o.day);
    const active = activeCard.get(key);
    const sent = sentCard.get(key);
    const isFocused = Boolean(focusKey && focusKey === occKey(o));
    return (
      <TouchableOpacity
        key={`${o.contact._id}-${o.kind}-${o.month}-${o.day}-${i}`}
        activeOpacity={0.7}
        onLayout={isFocused ? onFocusRowLayout : undefined}
        onPress={() => nav.navigate('ContactForm', { id: o.contact._id, isSelf: isSelf || undefined, focus: 'dates' })}
      >
        <Card style={[styles.row, isToday && styles.todayRow, isPast && styles.pastRow, isFocused && styles.focusedRow]}>
          <IconAvatar mdiIcon={occasionIcon(o.kind)} bg={isPast ? `${ACCENT}99` : ACCENT} size={40} />
          <View style={styles.main}>
            <Text style={styles.name}>
              {o.contact.name}
              {isSelf ? ' (you)' : ''}
            </Text>
            <Text style={styles.date}>
              {occasionNoun({ kind: o.kind, label: o.label })} · {MONTHS[o.month - 1]} {o.day}
              {yearsLabel(o.kind, o.years)}
            </Text>
          </View>
          {when ? <Text style={[styles.when, isToday && styles.whenToday]}>{when}</Text> : null}
          {isPast ? (
            // Recently passed: no scheduling prompt (that would fire a year out).
            // Show only whether the card that was set actually went out.
            sent ? (
              <View style={styles.sentPill}>
                <MaterialCommunityIcons name="email-check" size={13} color={ACCENT} />
                <Text style={styles.sentPillText}>Sent</Text>
              </View>
            ) : null
          ) : sent && !active ? (
            // The card for this occurrence already went out (it sends once, then
            // deactivates) — say so instead of offering to schedule another.
            <View style={styles.sentPill}>
              <MaterialCommunityIcons name="email-check" size={13} color={ACCENT} />
              <Text style={styles.sentPillText}>Sent</Text>
            </View>
          ) : (
            <TouchableOpacity
              accessibilityLabel={active ? 'Edit scheduled e-card' : 'Schedule an e-card'}
              hitSlop={8}
              style={styles.cardBtn}
              onPress={() => nav.navigate('ECardForm', {
                contactId: o.contact._id,
                contactName: o.contact.name,
                kind: o.kind,
                occasionLabel: o.label,
                month: o.month,
                day: o.day,
                ecardId: active?._id,
              })}
            >
              <MaterialCommunityIcons name={active ? 'email-check' : 'email-plus-outline'} size={22} color={ACCENT} />
            </TouchableOpacity>
          )}
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
      {visible.length > 0 ? (
        <Hint>Occasions come from the dates on your contacts — birthdays, anniversaries, and anything else you add. Tap one to edit its dates.</Hint>
      ) : null}

      {recentlyPassed.length > 0 ? (
        <>
          <SectionHeader>Recently observed</SectionHeader>
          {recentlyPassed.map((o, i) => renderRow(o, i, 'past'))}
        </>
      ) : null}

      {visible.length > 0 ? (
        <View style={styles.todayMarker}>
          <View style={styles.todayLine} />
          <Text style={styles.todayMarkerText}>Today · {todayLabel}</Text>
          <View style={styles.todayLine} />
        </View>
      ) : null}

      {todayOccasions.map((o, i) => renderRow(o, i, 'upcoming'))}

      {comingUp.length > 0 ? (
        <>
          <SectionHeader>Coming up</SectionHeader>
          {comingUp.map((o, i) => renderRow(o, i, 'upcoming'))}
        </>
      ) : visible.length > 0 ? (
        <Text style={styles.noneSoon}>Nothing in the next {COMING_UP_DAYS} days.</Text>
      ) : null}

      {later.length > 0 ? (
        <>
          <TouchableOpacity style={styles.laterToggle} activeOpacity={0.7} onPress={() => setShowLater((v) => !v)}>
            <Text style={styles.laterToggleText}>Later this year ({later.length})</Text>
            <Ionicons name={laterOpen ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textMuted} />
          </TouchableOpacity>
          {laterOpen ? later.map((o, i) => renderRow(o, i, 'later')) : null}
        </>
      ) : null}

      {visible.length === 0 ? (
        <EmptyState
          variant="inline"
          mdiIcon="calendar-heart"
          title="No occasions yet"
          message="Dates you add to a contact — birthdays, anniversaries, and more — show up here. Open a contact and add a date to get started."
          accent={ACCENT}
        >
          <TouchableOpacity style={styles.emptyBtn} onPress={() => nav.navigate('Contacts')}>
            <Ionicons name="calendar-outline" size={16} color={colors.primary} />
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
  // Recently-passed occasions read as history: dimmed so the eye lands on what's next.
  pastRow: { opacity: 0.6 },
  // The occasion tapped from the calendar: a bolder outline + faint accent wash.
  focusedRow: { borderWidth: 2, borderColor: ACCENT, backgroundColor: `${ACCENT}1A` },
  main: { flex: 1 },
  name: { fontSize: 16, fontWeight: '600', color: colors.text },
  date: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  when: { fontSize: 13, fontWeight: '600', color: colors.textMuted },
  whenToday: { color: ACCENT },
  cardBtn: { padding: 4 },
  sentPill: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  sentPillText: { fontSize: 12, fontWeight: '600', color: ACCENT },
  // The "Today · <date>" anchor: today's occasions render directly beneath it,
  // then the "Coming up" section.
  todayMarker: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm, marginBottom: spacing.md },
  todayLine: { flex: 1, height: 1, backgroundColor: ACCENT, opacity: 0.4 },
  todayMarkerText: { fontSize: 12, fontWeight: '700', color: ACCENT, textTransform: 'uppercase', letterSpacing: 0.5 },
  noneSoon: { fontSize: 13, color: colors.textMuted, fontStyle: 'italic', marginTop: spacing.xs, marginBottom: spacing.sm },
  laterToggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing.md, marginTop: spacing.xs },
  laterToggleText: { fontSize: 14, fontWeight: '600', color: colors.textMuted },
  emptyBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: spacing.md },
  emptyBtnText: { color: colors.primary, fontWeight: '600', fontSize: 14 },
});
