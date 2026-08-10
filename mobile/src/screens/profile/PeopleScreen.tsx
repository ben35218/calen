import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  SectionList,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  ActionSheetIOS,
  Platform,
  Alert,
  RefreshControl,
  Keyboard,
  type GestureResponderEvent,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../store/auth';
import { peopleApi, Person } from '../../api';
import { openRecord } from '../../lib/e2ee';
import { ensureSelfPerson } from '../../lib/selfPerson';
import { normalizePerson } from '../../lib/personFields';
import { useContactSort, type ContactSort } from '../../lib/contactSortPref';
import * as replica from '../../lib/replica';
import { HeaderIconButton, CenteredLoader, EmptyState } from '../../components/ui';
import { colors, spacing, radius } from '../../theme';
import type { ProfileStackParamList } from '../../navigation/ProfileNavigator';

type Nav = NativeStackNavigationProp<ProfileStackParamList>;

// Tabs map onto the plaintext Person.type used for roster grouping.
type TabKey = 'family' | 'friend' | 'service';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'family', label: 'Family' },
  { key: 'friend', label: 'Friends' },
  { key: 'service', label: 'Professionals' },
];

// The right-edge scrubber, iOS Contacts style: full alphabet plus a trailing "#"
// bucket for names that don't start with a letter.
const INDEX_LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '#'];

type Section = { letter: string; data: Person[] };

// Contacts roster split across Family / Friends / Professionals tabs, presented
// as an iOS-Contacts-style alphabetical list: initials avatars, letter section
// headers, a right-edge A–Z scrubber, and a floating search pill. The account
// holder's own "You" card is not shown among the contacts — it is excluded from
// the roster and edited from Account; the header "+" (kept in the nav bar) adds
// into the active tab.
export default function PeopleScreen() {
  const nav = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const selfId = String(user?._id ?? '');
  const [tab, setTab] = useState<TabKey>('family');
  const [query, setQuery] = useState('');
  const [kbHeight, setKbHeight] = useState(0);
  // Device-local: sort the roster by first name (default) or last name.
  const { sort, setContactSort } = useContactSort();

  // Lift the floating search pill above the keyboard so the field it opens stays
  // visible while typing. Use the `Will` events on iOS (they fire with the show
  // animation for a smooth ride) and `Did` on Android (no `Will` there).
  React.useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, (e) => setKbHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const listRef = useRef<SectionList<Person, Section>>(null);
  const indexHeight = useRef(0);

  // Header "+" opens a menu: add a person manually (into the active tab) or
  // import from the device address book.
  const openAddMenu = useCallback(() => {
    const addManually = () => nav.navigate('PersonForm', { type: tab });
    // Seed the import's default classification from the tab we launched from.
    const importContacts = () => nav.navigate('ContactImport', { type: tab });
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ['Add', 'Import from Contacts', 'Cancel'], cancelButtonIndex: 2 },
        (i) => {
          if (i === 0) addManually();
          else if (i === 1) importContacts();
        }
      );
    } else {
      Alert.alert('Add contact', undefined, [
        { text: 'Add', onPress: addManually },
        { text: 'Import from Contacts', onPress: importContacts },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  }, [nav, tab]);

  useLayoutEffect(() => {
    nav.setOptions({
      headerRight: () => (
        <HeaderIconButton icon="add" size={30} onPress={openAddMenu} accessibilityLabel="Add contact" />
      ),
    });
  }, [nav, openAddMenu]);

  const { data: people, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['people'],
    // Offline-first (Phase 4b): fetch + sync the local replica, falling back to
    // the cached copy when the network is unavailable. Decrypt content over
    // plaintext (dual-write); no-op without an HDK.
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

  const qc = useQueryClient();

  // Fallback seed of the encrypted "You" Person (the primary seed runs at app
  // boot — see hooks/useSelfPersonSeed). ensureSelfPerson guards on e2eeActive +
  // a held key and no-ops once a self-record exists, so this is just a belt-and-
  // suspenders retry for a session where boot seeding didn't land.
  React.useEffect(() => {
    if (!people || !user) return;
    ensureSelfPerson(user).then((created) => {
      if (created) qc.invalidateQueries({ queryKey: ['people'] });
    });
  }, [people, user, qc]);

  // Reap orphans from the pre-2026-07-27 person-form bug: a stale local
  // PERSON_ENC sealed contacts without `type`, so they decrypt fine but can
  // never appear in any tab. Rows only reach this decrypted Person bucket after
  // a successful unseal (lib/records skips undecryptable rows), so a missing
  // type here is definitive — tombstone them. accountId-bearing records are
  // left alone as belt-and-suspenders for the "You"/member cards.
  const reaped = React.useRef(false);
  React.useEffect(() => {
    if (reaped.current || !people) return;
    const orphans = people.filter((p) => !p.accountId && !TABS.some((t) => t.key === p.type));
    if (!orphans.length) return;
    reaped.current = true;
    Promise.all(orphans.map((p) => peopleApi.delete(p._id).catch(() => {})))
      .then(() => qc.invalidateQueries({ queryKey: ['people'] }));
  }, [people, qc]);

  const selfPerson = useMemo(
    () => people?.find((p) => p.accountId && String(p.accountId) === selfId),
    [people, selfId]
  );

  // Group the active tab's contacts into alphabetical sections, sorted and
  // section-keyed by the chosen name field (first or last; non-letter leads fall
  // into "#"), then filtered by the search query. The account holder's own self
  // Person is excluded entirely.
  const sections = useMemo<Section[]>(() => {
    if (!people) return [];
    const q = query.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, '');
    const roster = people.filter(
      (p) => p.type === tab && p !== selfPerson && (!q || matchesPerson(p, q, qDigits))
    );
    // Precompute the sort key once per contact (it normalizes to read structured
    // first/last), then sort and section by it.
    const keyed = roster.map((p) => ({ p, key: sortKey(p, sort) }));
    keyed.sort((a, b) => a.key.localeCompare(b.key));
    const buckets = new Map<string, Person[]>();
    for (const { p, key } of keyed) {
      const first = key.charAt(0).toUpperCase();
      const letter = /[A-Z]/.test(first) ? first : '#';
      const bucket = buckets.get(letter);
      if (bucket) bucket.push(p);
      else buckets.set(letter, [p]);
    }
    return [...buckets.entries()]
      .sort(([a], [b]) => (a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b)))
      .map(([letter, data]) => ({ letter, data }));
  }, [people, tab, selfPerson, query, sort]);

  // Jump the list to a scrubbed letter, snapping to the nearest following
  // section when that exact letter has no contacts.
  const scrollToLetter = useCallback(
    (letter: string) => {
      if (!sections.length) return;
      let idx = sections.findIndex((s) => s.letter === letter);
      if (idx < 0) {
        idx = sections.findIndex((s) => s.letter !== '#' && s.letter > letter);
        if (idx < 0) idx = sections.length - 1;
      }
      listRef.current?.scrollToLocation({ sectionIndex: idx, itemIndex: 0, viewPosition: 0, animated: false });
    },
    [sections]
  );

  const onIndexTouch = useCallback(
    (e: GestureResponderEvent) => {
      const h = indexHeight.current;
      if (!h) return;
      const ratio = e.nativeEvent.locationY / h;
      const i = Math.max(0, Math.min(INDEX_LETTERS.length - 1, Math.floor(ratio * INDEX_LETTERS.length)));
      scrollToLetter(INDEX_LETTERS[i]);
    },
    [scrollToLetter]
  );

  if (isLoading || !people) {
    return <CenteredLoader />;
  }

  const emptyLabel = {
    family: query.trim() ? 'No matching family members.' : 'No family members yet.',
    friend: query.trim() ? 'No matching friends.' : 'No friends added yet.',
    service: query.trim() ? 'No matching professionals.' : 'No professionals added yet.',
  }[tab];

  return (
    <View style={styles.container}>
      <View style={styles.tabBar}>
        {TABS.map((t) => (
          <TouchableOpacity
            key={t.key}
            style={[styles.tab, tab === t.key && styles.tabActive]}
            onPress={() => setTab(t.key)}
            activeOpacity={0.7}
          >
            <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.sortRow}>
        <TouchableOpacity
          style={styles.sortBtn}
          onPress={() => setContactSort(sort === 'first' ? 'last' : 'first')}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel={`Sorting by ${sort === 'first' ? 'first' : 'last'} name. Tap to switch.`}
        >
          <Ionicons name="swap-vertical" size={14} color={colors.primary} />
          <Text style={styles.sortText}>{sort === 'first' ? 'First name' : 'Last name'}</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.body}>
        <SectionList
          ref={listRef}
          sections={sections}
          keyExtractor={(p) => p._id}
          stickySectionHeadersEnabled
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
          onScrollToIndexFailed={() => {}}
          renderSectionHeader={({ section }) => (
            <Text style={styles.sectionHeader}>{section.letter}</Text>
          )}
          renderItem={({ item }) => (
            <ContactRow person={item} onPress={() => nav.navigate('PersonDetail', { id: item._id })} />
          )}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListEmptyComponent={<EmptyState variant="inline" message={emptyLabel} />}
        />

        {!query.trim() && sections.length > 0 ? (
          <View
            style={styles.index}
            onLayout={(e) => (indexHeight.current = e.nativeEvent.layout.height)}
            onStartShouldSetResponder={() => true}
            onMoveShouldSetResponder={() => true}
            onResponderGrant={onIndexTouch}
            onResponderMove={onIndexTouch}
          >
            {INDEX_LETTERS.map((l) => (
              <Text key={l} style={styles.indexLetter} allowFontScaling={false}>
                {l}
              </Text>
            ))}
          </View>
        ) : null}

        <View
          style={[
            styles.searchWrap,
            { bottom: kbHeight > 0 ? kbHeight + spacing.sm : insets.bottom + spacing.md },
          ]}
          pointerEvents="box-none"
        >
          <View style={styles.searchPill}>
            <Ionicons name="search" size={18} color={colors.textMuted} />
            <TextInput
              style={styles.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder="Search"
              placeholderTextColor={colors.textMuted}
              returnKeyType="search"
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="never"
            />
            {query.length > 0 ? (
              <TouchableOpacity onPress={() => setQuery('')} hitSlop={8} accessibilityLabel="Clear search">
                <Ionicons name="close-circle" size={18} color={colors.textMuted} />
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      </View>
    </View>
  );
}

// One roster row: an initials avatar, the name (surname bolded, iOS style), and a
// "You"/"Member" chip for the self and household-member cards.
function ContactRow({ person, self, onPress }: { person: Person; self?: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.row} activeOpacity={0.6} onPress={onPress}>
      <View style={[styles.avatar, self && styles.avatarSelf]}>
        <Text style={[styles.avatarText, self && styles.avatarTextSelf]}>{initialsOf(person.name)}</Text>
      </View>
      <Text style={styles.rowName} numberOfLines={1}>
        {renderName(person.name, person.lastName)}
      </Text>
      {self ? (
        <Text style={styles.youChip}>You</Text>
      ) : person.accountId ? (
        <Text style={styles.memberChip}>Member</Text>
      ) : null}
    </TouchableOpacity>
  );
}

// Search matches a contact on any human-facing field — name, how you know them
// (relationship), company, job title, and every address/email/related name —
// via case-insensitive substring. Phones are matched separately on digits only,
// since they're stored as canonical E.164 and users type spaces/parens/dashes.
// `q` is already trimmed + lowercased; `qDigits` is `q` stripped to digits. The
// contact is normalized so legacy single-value records match the same way.
function matchesPerson(p: Person, q: string, qDigits: string): boolean {
  const n = normalizePerson(p);
  const hay = [
    p.name, p.relationship, n.company, n.jobTitle,
    ...n.emails.map((e) => e.value),
    ...n.addresses.map((a) => a.value),
    ...n.relatedNames.map((r) => r.value),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (hay.includes(q)) return true;
  if (qDigits) return n.phones.some((ph) => ph.value.replace(/\D/g, '').includes(qDigits));
  return false;
}

// The lowercased sort/section key for a contact under the chosen order. Sorting
// by last name leads with the surname (falling back to the first name when a
// contact has none, e.g. a single-token or business name), then the first name
// as a tiebreak; sorting by first name is the mirror. Reads the structured
// first/last via normalizePerson so legacy single-`name` records sort sensibly.
function sortKey(p: Person, mode: ContactSort): string {
  const n = normalizePerson(p);
  const first = (n.firstName || p.name || '').trim();
  const last = (n.lastName || '').trim();
  const primary = mode === 'last' ? last || first : first || last;
  const secondary = mode === 'last' ? first : last;
  return `${primary} ${secondary}`.trim().toLowerCase();
}

function nameParts(name: string): string[] {
  return name.trim().split(/\s+/).filter(Boolean);
}

function initialsOf(name: string): string {
  const parts = nameParts(name);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

// Bold the surname the way iOS Contacts does. Prefer the contact's structured
// `lastName` (exact, handles multi-word surnames like "Van Der Berg"); fall back
// to the last whitespace token for legacy records that carry only `name`. A
// single-token name renders plain.
function renderName(name: string, lastName?: string): React.ReactNode {
  const trimmed = name.trim();
  const surname = (lastName ?? '').trim();
  if (surname && trimmed.toLowerCase().endsWith(surname.toLowerCase())) {
    const lead = trimmed.slice(0, trimmed.length - surname.length).trim();
    if (!lead) return trimmed || name;
    return (
      <>
        {lead + ' '}
        <Text style={styles.rowNameLast}>{trimmed.slice(trimmed.length - surname.length)}</Text>
      </>
    );
  }
  const parts = nameParts(name);
  if (parts.length <= 1) return trimmed || name;
  const lead = parts.slice(0, -1).join(' ');
  const last = parts[parts.length - 1];
  return (
    <>
      {lead + ' '}
      <Text style={styles.rowNameLast}>{last}</Text>
    </>
  );
}

const AVATAR = 40;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  body: { flex: 1 },
  content: { paddingBottom: 96 },
  tabBar: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
    backgroundColor: colors.background,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  tabActive: { backgroundColor: colors.primary },
  tabText: { fontSize: 13, fontWeight: '600', color: colors.textMuted },
  tabTextActive: { color: '#fff' },

  sortRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
    paddingBottom: spacing.xs,
    backgroundColor: colors.background,
  },
  sortBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 2 },
  sortText: { fontSize: 13, fontWeight: '600', color: colors.primary },

  sectionHeader: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textMuted,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.background,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginLeft: spacing.md + AVATAR + spacing.md,
  },
  avatar: {
    width: AVATAR,
    height: AVATAR,
    borderRadius: AVATAR / 2,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  avatarSelf: { backgroundColor: colors.primary, borderColor: colors.primary },
  avatarText: { fontSize: 15, fontWeight: '600', color: colors.text },
  avatarTextSelf: { color: '#fff' },
  rowName: { flex: 1, fontSize: 17, color: colors.text },
  rowNameLast: { fontWeight: '700' },
  youChip: {
    marginLeft: spacing.sm,
    fontSize: 11,
    fontWeight: '700',
    color: '#fff',
    backgroundColor: colors.primary,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  memberChip: {
    marginLeft: spacing.sm,
    fontSize: 11,
    fontWeight: '600',
    color: colors.primary,
    backgroundColor: colors.primary + '18',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },

  index: {
    position: 'absolute',
    right: 2,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  indexLetter: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '600',
    color: colors.primary,
    textAlign: 'center',
  },

  searchWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  searchPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    width: '86%',
    height: 44,
    paddingHorizontal: spacing.md,
    borderRadius: 22,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  searchInput: { flex: 1, fontSize: 16, color: colors.text, padding: 0 },
});
