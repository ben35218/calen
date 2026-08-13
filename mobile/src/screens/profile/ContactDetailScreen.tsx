import React, { useEffect, useLayoutEffect, useState } from 'react';
import { View, StyleSheet, Linking, TouchableOpacity, Alert, Share } from 'react-native';
import { Text } from '../../components/Text';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQuery } from '@tanstack/react-query';
import * as Sharing from 'expo-sharing';
import { cacheDirectory, writeAsStringAsync } from 'expo-file-system/legacy';
import { contactsApi, Contact } from '../../api';
import { openRecord } from '../../lib/e2ee';
import { Card, Screen, ListRow, EmptyState, HeaderIconButton, Button, CenteredLoader } from '../../components/ui';
import { formatCalendarDate } from '../../lib/recurrence';
import { formatDisplay } from '../../lib/phone';
import { normalizeContact } from '../../lib/contactFields';
import { addContactToDeviceContacts, ContactsPermissionError } from '../../lib/deviceContacts';
import { buildVCard } from '../../lib/vcard';
import { colors, spacing } from '../../theme';
import type { ProfileStackParamList } from '../../navigation/ProfileNavigator';

type Nav = NativeStackNavigationProp<ProfileStackParamList, 'ContactDetail'>;
type Rt = RouteProp<ProfileStackParamList, 'ContactDetail'>;

const TYPE_LABEL: Record<string, string> = { family: 'Family', friend: 'Friend', service: 'Professional' };

// Prefix a bare URL with https:// so Linking can open it.
function withScheme(url: string): string {
  return /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
}

// Contact labels are stored lowercase; present them Title Case (display only —
// ListRow's title is a plain string, so we transform the value, not a style).
function titleCase(label: string): string {
  return label.replace(/\b\w/g, (c) => c.toUpperCase());
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

export default function ContactDetailScreen() {
  const nav = useNavigation<Nav>();
  const { id } = useRoute<Rt>().params;
  const [exporting, setExporting] = useState(false);

  // Read the decrypted roster (shared ['contacts'] cache); fetch if not present so
  // the screen works from any entry point (Contacts list or an item's service pro).
  const { data: contacts, isLoading } = useQuery({
    queryKey: ['contacts'],
    queryFn: async () => {
      const rows = (await contactsApi.list()).data;
      return Promise.all(rows.map((p) => openRecord('Contact', p))) as Promise<Contact[]>;
    },
  });
  const contact = contacts?.find((p) => p._id === id);

  // If the roster has loaded but this contact is gone (e.g. it was just deleted
  // from the edit screen, which pops back here), there's nothing to show — pop
  // back to the list instead of spinning forever on a missing record.
  useEffect(() => {
    if (!isLoading && contacts && !contact) nav.goBack();
  }, [isLoading, contacts, contact, nav]);

  useLayoutEffect(() => {
    nav.setOptions({
      title: 'Contact',
      headerRight: () => (
        <HeaderIconButton icon="pencil" accessibilityLabel="Edit contact" onPress={() => nav.navigate('ContactForm', { id })} />
      ),
    });
  }, [nav, id]);

  if (!contact) {
    return <CenteredLoader />;
  }

  const n = normalizeContact(contact);
  const primaryPhone = n.phones[0]?.value;
  const primaryEmail = n.emails[0]?.value;
  const subtitle = [TYPE_LABEL[contact.type] || contact.type, contact.relationship].filter(Boolean).join(' · ');
  const work = [n.jobTitle, n.company].filter(Boolean).join(' · ');

  const call = (phone: string) => Linking.openURL(`tel:${phone}`);
  const text = (phone: string) => Linking.openURL(`sms:${phone}`);
  const mail = (email: string) => Linking.openURL(`mailto:${email}`);
  const map = (address: string) => Linking.openURL(`https://maps.apple.com/?q=${encodeURIComponent(address)}`);

  // Share the contact as a vCard (.vcf) through the OS share sheet — the
  // universal contact format other apps (Contacts, Mail, messaging) can import.
  async function shareContact() {
    try {
      const vcf = buildVCard({
        name: contact!.name,
        firstName: contact!.type === 'service' ? undefined : n.firstName,
        lastName: contact!.type === 'service' ? undefined : n.lastName,
        type: contact!.type,
        company: n.company,
        jobTitle: n.jobTitle,
        birthday: contact!.birthday ? String(contact!.birthday).slice(0, 10) : undefined,
        phones: n.phones,
        emails: n.emails,
        addresses: n.addresses,
        urls: n.urls,
      });
      const safe = contact!.name.trim().replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'contact';
      const uri = `${cacheDirectory}${safe}.vcf`;
      await writeAsStringAsync(uri, vcf);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: 'text/vcard', UTI: 'public.vcard', dialogTitle: `Share ${contact!.name}` });
      } else {
        await Share.share({ url: uri, title: contact!.name });
      }
    } catch (e: any) {
      Alert.alert('Could not share', e?.message || 'Please try again.');
    }
  }

  // Write this Calen contact into the device address book (shares the contact-form
  // opt-in logic). Best-effort; confirms first if it may already be on the phone.
  async function exportToDevice() {
    if (exporting) return;
    const run = async () => {
      setExporting(true);
      try {
        await addContactToDeviceContacts({
          name: contact!.name,
          firstName: contact!.type === 'service' ? undefined : n.firstName,
          lastName: contact!.type === 'service' ? undefined : n.lastName,
          type: contact!.type,
          company: n.company,
          jobTitle: n.jobTitle,
          birthday: contact!.birthday ? String(contact!.birthday).slice(0, 10) : undefined,
          phones: n.phones,
          emails: n.emails,
          addresses: n.addresses,
          urls: n.urls,
        });
        Alert.alert('Added to iPhone Contacts', `${contact!.name} was saved to your phone's address book.`);
      } catch (e) {
        Alert.alert(
          'Not added',
          e instanceof ContactsPermissionError
            ? 'Contacts permission is off. Allow Contacts access in Settings to add this contact to your iPhone.'
            : "Couldn't add this contact to your iPhone Contacts."
        );
      } finally {
        setExporting(false);
      }
    };
    if (contact!.deviceContactId) {
      Alert.alert('Add again?', 'This contact may already be in your iPhone Contacts. Add another copy?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Add', onPress: run },
      ]);
    } else {
      run();
    }
  }

  // A contact with nothing but a name/type is an empty shell — nudge the user to
  // flesh it out rather than show a blank card.
  const hasDetails =
    !!(n.phones.length || n.emails.length || n.addresses.length || n.dates.length ||
      n.urls.length || n.relatedNames.length || contact.birthday || work) || !!contact.notes;

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.name}>{contact.name}</Text>
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
          onAction={() => nav.navigate('ContactForm', { id })}
        />
      ) : null}

      <View style={styles.actions}>
        {primaryPhone ? <ActionButton icon="call" label="Call" onPress={() => call(primaryPhone)} /> : null}
        {primaryPhone ? <ActionButton icon="chatbubble" label="Text" onPress={() => text(primaryPhone)} /> : null}
        {primaryEmail ? <ActionButton icon="mail" label="Email" onPress={() => mail(primaryEmail)} /> : null}
        <ActionButton icon="share-outline" label="Share" onPress={shareContact} />
      </View>

      {hasDetails ? (
        <Card style={styles.infoCard}>
          {n.company ? <ListRow icon="business-outline" title="Company" subtitle={n.company} /> : null}
          {n.jobTitle ? <ListRow icon="briefcase-outline" title="Job title" subtitle={n.jobTitle} /> : null}
          {n.phones.map((p, i) => (
            <ListRow key={`ph${i}`} icon="call-outline" title={titleCase(p.label)} subtitle={formatDisplay(p.value)} onPress={() => call(p.value)} />
          ))}
          {n.emails.map((e, i) => (
            <ListRow key={`em${i}`} icon="mail-outline" title={titleCase(e.label)} subtitle={e.value} onPress={() => mail(e.value)} />
          ))}
          {n.addresses.map((a, i) => (
            <ListRow key={`ad${i}`} icon="location-outline" title={titleCase(a.label)} subtitle={a.value} onPress={() => map(a.value)} />
          ))}
          {/* Birthday is the first occasion date (its own `birthday` field),
              rendered inline with the labeled dates as one group. */}
          {[
            ...(contact.birthday
              ? [{ label: 'Birthday', value: String(contact.birthday).slice(0, 10), icon: 'gift-outline' as const }]
              : []),
            ...n.dates.map((d) => ({ ...d, icon: 'calendar-outline' as const })),
          ].map((d, i) => (
            <ListRow key={`dt${i}`} icon={d.icon} title={titleCase(d.label)} subtitle={formatCalendarDate(d.value)} />
          ))}
          {n.urls.map((u, i) => (
            <ListRow key={`ur${i}`} icon="globe-outline" title={titleCase(u.label)} subtitle={u.value} onPress={() => Linking.openURL(withScheme(u.value))} />
          ))}
          {n.relatedNames.map((r, i) => (
            <ListRow
              key={`rn${i}`}
              icon="people-outline"
              title={titleCase(r.label)}
              subtitle={r.value}
              // push (not navigate): we're already on ContactDetail, so navigate
              // would swap params in place and leave nothing to go Back to — push
              // stacks a fresh instance so Back returns to this contact.
              onPress={r.contactId && contacts?.some((p) => p._id === r.contactId)
                ? () => nav.push('ContactDetail', { id: r.contactId! })
                : undefined}
            />
          ))}
        </Card>
      ) : null}

      {contact.notes ? (
        <Card style={styles.textCard}>
          <Text style={styles.overline}>Notes</Text>
          <Text style={styles.body}>{contact.notes}</Text>
        </Card>
      ) : null}

      <View style={styles.exportRow}>
        <Button
          title="Add to iPhone Contacts"
          variant="ghost"
          onPress={exportToDevice}
          loading={exporting}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
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
  exportRow: { marginBottom: spacing.md },
  overline: { fontSize: 12, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.5, marginBottom: spacing.xs },
  body: { fontSize: 15, color: colors.text, lineHeight: 21 },
});
