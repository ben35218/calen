import React, { useEffect, useLayoutEffect } from 'react';
import { View, Text, StyleSheet, Linking, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQuery } from '@tanstack/react-query';
import { peopleApi, Person } from '../../api';
import { openRecord } from '../../lib/e2ee';
import { Card, Screen, ListRow, EmptyState, HeaderIconButton } from '../../components/ui';
import { formatCalendarDate } from '../../lib/recurrence';
import { formatDisplay } from '../../lib/phone';
import { normalizePerson } from '../../lib/personFields';
import { colors, spacing } from '../../theme';
import type { ProfileStackParamList } from '../../navigation/ProfileNavigator';

type Nav = NativeStackNavigationProp<ProfileStackParamList, 'PersonDetail'>;
type Rt = RouteProp<ProfileStackParamList, 'PersonDetail'>;

const TYPE_LABEL: Record<string, string> = { family: 'Family', friend: 'Friend', service: 'Professional' };

// Prefix a bare URL with https:// so Linking can open it.
function withScheme(url: string): string {
  return /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
}

// A round icon + label used for the Call / Text / Email quick actions.
function ActionButton({ icon, label, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.action} activeOpacity={0.8} onPress={onPress} accessibilityLabel={label}>
      <View style={styles.actionCircle}>
        <Ionicons name={icon} size={22} color={colors.primary} />
      </View>
      <Text style={styles.actionLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

export default function PersonDetailScreen() {
  const nav = useNavigation<Nav>();
  const { id } = useRoute<Rt>().params;

  // Read the decrypted roster (shared ['people'] cache); fetch if not present so
  // the screen works from any entry point (People list or an item's service pro).
  const { data: people, isLoading } = useQuery({
    queryKey: ['people'],
    queryFn: async () => {
      const rows = (await peopleApi.list()).data;
      return Promise.all(rows.map((p) => openRecord('Person', p))) as Promise<Person[]>;
    },
  });
  const person = people?.find((p) => p._id === id);

  // If the roster has loaded but this contact is gone (e.g. it was just deleted
  // from the edit screen, which pops back here), there's nothing to show — pop
  // back to the list instead of spinning forever on a missing record.
  useEffect(() => {
    if (!isLoading && people && !person) nav.goBack();
  }, [isLoading, people, person, nav]);

  useLayoutEffect(() => {
    nav.setOptions({
      title: 'Contact',
      headerRight: () => (
        <HeaderIconButton icon="pencil" accessibilityLabel="Edit contact" onPress={() => nav.navigate('PersonForm', { id })} />
      ),
    });
  }, [nav, id]);

  if (!person) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const n = normalizePerson(person);
  const primaryPhone = n.phones[0]?.value;
  const primaryEmail = n.emails[0]?.value;
  const subtitle = [TYPE_LABEL[person.type] || person.type, person.relationship].filter(Boolean).join(' · ');
  const work = [n.jobTitle, n.company].filter(Boolean).join(' · ');

  const call = (phone: string) => Linking.openURL(`tel:${phone}`);
  const text = (phone: string) => Linking.openURL(`sms:${phone}`);
  const mail = (email: string) => Linking.openURL(`mailto:${email}`);
  const map = (address: string) => Linking.openURL(`https://maps.apple.com/?q=${encodeURIComponent(address)}`);

  // A contact with nothing but a name/type is an empty shell — nudge the user to
  // flesh it out rather than show a blank card.
  const hasDetails =
    !!(n.phones.length || n.emails.length || n.addresses.length || n.dates.length ||
      n.urls.length || n.relatedNames.length || person.birthday || work) || !!person.notes;

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.name}>{person.name}</Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        {work ? <Text style={styles.work}>{work}</Text> : null}
      </View>

      {!hasDetails ? (
        <EmptyState
          variant="inline"
          icon="person-add-outline"
          title="Add contact details"
          message="This contact only has a name. Add a phone number, email, birthday, and more."
          actionLabel="Add details"
          onAction={() => nav.navigate('PersonForm', { id })}
        />
      ) : null}

      {primaryPhone || primaryEmail ? (
        <View style={styles.actions}>
          {primaryPhone ? <ActionButton icon="call" label="Call" onPress={() => call(primaryPhone)} /> : null}
          {primaryPhone ? <ActionButton icon="chatbubble" label="Text" onPress={() => text(primaryPhone)} /> : null}
          {primaryEmail ? <ActionButton icon="mail" label="Email" onPress={() => mail(primaryEmail)} /> : null}
        </View>
      ) : null}

      {hasDetails ? (
        <Card style={styles.infoCard}>
          {n.company ? <ListRow icon="business-outline" title="Company" subtitle={n.company} /> : null}
          {n.jobTitle ? <ListRow icon="briefcase-outline" title="Job title" subtitle={n.jobTitle} /> : null}
          {n.phones.map((p, i) => (
            <ListRow key={`ph${i}`} icon="call-outline" title={p.label} subtitle={formatDisplay(p.value)} onPress={() => call(p.value)} />
          ))}
          {n.emails.map((e, i) => (
            <ListRow key={`em${i}`} icon="mail-outline" title={e.label} subtitle={e.value} onPress={() => mail(e.value)} />
          ))}
          {n.addresses.map((a, i) => (
            <ListRow key={`ad${i}`} icon="location-outline" title={a.label} subtitle={a.value} onPress={() => map(a.value)} />
          ))}
          {person.birthday ? (
            <ListRow icon="gift-outline" title="Birthday" subtitle={formatCalendarDate(String(person.birthday).slice(0, 10))} />
          ) : null}
          {n.dates.map((d, i) => (
            <ListRow key={`dt${i}`} icon="calendar-outline" title={d.label} subtitle={formatCalendarDate(d.value)} />
          ))}
          {n.urls.map((u, i) => (
            <ListRow key={`ur${i}`} icon="globe-outline" title={u.label} subtitle={u.value} onPress={() => Linking.openURL(withScheme(u.value))} />
          ))}
          {n.relatedNames.map((r, i) => (
            <ListRow
              key={`rn${i}`}
              icon="people-outline"
              title={r.label}
              subtitle={r.value}
              // push (not navigate): we're already on PersonDetail, so navigate
              // would swap params in place and leave nothing to go Back to — push
              // stacks a fresh instance so Back returns to this contact.
              onPress={r.personId && people?.some((p) => p._id === r.personId)
                ? () => nav.push('PersonDetail', { id: r.personId! })
                : undefined}
            />
          ))}
        </Card>
      ) : null}

      {person.notes ? (
        <Card style={styles.textCard}>
          <Text style={styles.overline}>Notes</Text>
          <Text style={styles.body}>{person.notes}</Text>
        </Card>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  header: { marginBottom: spacing.md },
  name: { fontSize: 24, fontWeight: '700', color: colors.text },
  subtitle: { fontSize: 15, color: colors.textMuted, marginTop: 2 },
  work: { fontSize: 14, color: colors.textMuted, marginTop: 2 },
  actions: { flexDirection: 'row', gap: spacing.lg, marginTop: spacing.md, marginBottom: spacing.md },
  action: { alignItems: 'center', gap: 6 },
  actionCircle: {
    width: 52, height: 52, borderRadius: 26,
    borderWidth: 1.5, borderColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  actionLabel: { fontSize: 13, fontWeight: '600', color: colors.primary },
  infoCard: { padding: 0, paddingVertical: spacing.xs, marginBottom: spacing.md },
  textCard: { marginBottom: spacing.md },
  overline: { fontSize: 12, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.5, marginBottom: spacing.xs },
  body: { fontSize: 15, color: colors.text, lineHeight: 21 },
});
