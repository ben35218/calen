import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Linking,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { useNavigation, useIsFocused } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../store/auth';
import { householdApi } from '../api';
import { TERMS_URL, PRIVACY_URL } from '../config';
import { useBilling } from '../hooks/useBilling';
import { humanCredits } from './plan/shared';
import { Badge, Button, Card, ListRow, SectionHeader } from '../components/ui';
import { useE2eeLocked } from '../hooks/useE2eeLocked';
import { useInvitationsCount } from '../hooks/useInvitationsCount';
import { colors, spacing } from '../theme';
import type { ProfileStackParamList } from '../navigation/ProfileNavigator';

type Section = {
  route: keyof ProfileStackParamList;
  label: string;
  icon: React.ComponentProps<typeof ListRow>['icon'];
};

// Mirrors client/src/views/ProfileMenu.vue — an iOS-style drill-in hub. Plan &
// billing is no longer a drill-in row: its status/usage cards live inline below
// the identity card (see the plan cards in the render).
//
// The menu is grouped by SCOPE so the shared/pooled nature is obvious at a
// glance: "Personal" holds per-user/device settings; "Shared with your
// household" holds the collaborative layer — the household itself and the
// contacts roster (family, friends & pros) that every member sees and adds to.
// Scope is signalled structurally (the section header) rather than in a
// per-row subtitle, so Contacts never reads as a private address book. The rows
// are label-only (iOS Settings style) — the labels are self-explanatory, so a
// subtitle would only restate them and cost a line of scannability.
const GROUPS: { header: string; items: Section[] }[] = [
  {
    header: 'Personal',
    items: [
      { route: 'Account', label: 'Account', icon: 'person-outline' },
      // YOUR inbox (event/calendar/trip/household invites, membership notices,
      // call outcomes) — every feed behind it is per-user, so it's Personal
      // scope, not the shared layer (the household-scoped part, join requests
      // to approve, also surfaces on HouseholdScreen). Its entry point lives
      // here — not in the calendar's floating chrome — with a count badge; the
      // calendar avatar carries the same count so the badge trail leads through
      // Profile to this row. Second, after the conventional identity lead, and
      // beside Reminders — the "things that arrive for you" cluster.
      { route: 'Invitations', label: 'Invitations', icon: 'mail-outline' },
      { route: 'Reminders', label: 'Reminders', icon: 'notifications-outline' },
      { route: 'PrivacyData', label: 'Privacy & security', icon: 'lock-closed-outline' },
    ],
  },
  {
    header: 'Shared with your household',
    items: [
      { route: 'Household', label: 'Household', icon: 'home-outline' },
      { route: 'Contacts', label: 'Contacts', icon: 'people-outline' },
    ],
  },
  {
    header: 'Help & support',
    items: [
      { route: 'HelpFeedback', label: 'Help & feedback', icon: 'chatbubble-ellipses-outline' },
    ],
  },
];

export default function ProfileScreen() {
  const nav = useNavigation<NativeStackNavigationProp<ProfileStackParamList>>();
  const { user, logout } = useAuth();

  const { data: household } = useQuery({
    queryKey: ['household'],
    queryFn: async () => (await householdApi.get()).data,
  });
  const { data } = useBilling();

  const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || '—';
  const initial = user?.firstName?.charAt(0).toUpperCase() || '?';

  // Landing on Profile while encrypted data is locked on this device (e.g. after
  // an email-code sign-in with no passkey): prompt the user to resolve it, and
  // deep-link straight to Privacy & security where the unlock UI lives. Prompt once
  // per visit — re-armed each time the screen is left.
  const dataLocked = useE2eeLocked();
  const isFocused = useIsFocused();
  const promptedRef = useRef(false);
  useEffect(() => {
    if (!isFocused) {
      promptedRef.current = false;
      return;
    }
    if (dataLocked && !promptedRef.current) {
      promptedRef.current = true;
      Alert.alert(
        'Your data is locked on this device',
        "You're signed in, but your encrypted data can't be read here until you unlock it — with your recovery code, or Face ID / your password if you've set them up.",
        [
          { text: 'Later', style: 'cancel' },
          { text: 'Unlock now', onPress: () => nav.navigate('PrivacyData', { focus: 'unlock' }) },
        ],
      );
    }
  }, [isFocused, dataLocked, nav]);

  // Credits card state: balance + the low/out tint (exempt admins read
  // "Unlimited"; a refund can drive the raw balance negative — display floors
  // at 0, matching the Credits screen).
  const out = data ? !data.unlimited && data.creditBalance <= 0 : false;
  const low = data ? !data.unlimited && !out && data.lowBalance : false;

  // Pending-inbox count on the Invitations row — the continuation of the badge
  // trail that starts on the calendar's avatar.
  const invCount = useInvitationsCount();

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Card style={styles.identity}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initial}</Text>
        </View>
        <View style={styles.identityText}>
          <Text style={styles.name}>{name}</Text>
          <Text style={styles.email}>{user?.email}</Text>
          {household?.name ? <Text style={styles.householdChip}>{household.name}</Text> : null}
        </View>
        {user?.role === 'admin' ? <Text style={styles.badge}>Admin</Text> : null}
      </Card>

      {/* AI credits at a glance — drills into the Credits screen (balance,
          pack store, history, AI preferences). */}
      {data ? (
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={() => nav.navigate('Credits')}
          accessibilityRole="button"
          accessibilityLabel="AI credits"
        >
          <Card style={styles.card}>
            <View style={styles.usageHeaderRow}>
              <Text style={styles.usageHeading}>AI credits</Text>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </View>
            <View style={styles.creditRow}>
              <Text style={[styles.creditBalance, out && { color: colors.error }]}>
                {data.unlimited ? 'Unlimited' : humanCredits(data.creditBalance)}
              </Text>
              {!data.unlimited ? <Text style={styles.creditCaption}>credits</Text> : null}
              {low ? <Badge label="Running low" color={colors.warning} /> : null}
              {out ? <Badge label="Out of credits" color={colors.error} /> : null}
            </View>
            <Text style={styles.creditNote}>
              Pays for AI features and assistant phone calls. Tap to buy more.
            </Text>
          </Card>
        </TouchableOpacity>
      ) : null}

      {GROUPS.map((g) => (
        <View key={g.header}>
          <SectionHeader>{g.header}</SectionHeader>
          <Card style={styles.menu}>
            {g.items.map((s) => (
              <ListRow
                key={s.route}
                icon={s.icon}
                iconColor={colors.primary}
                title={s.label}
                onPress={() => nav.navigate(s.route as any)}
                right={
                  s.route === 'Invitations' && invCount > 0 ? (
                    <View style={styles.invBadgeRow}>
                      <View style={styles.invBadge}>
                        <Text style={styles.invBadgeText}>{invCount > 9 ? '9+' : invCount}</Text>
                      </View>
                      <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
                    </View>
                  ) : undefined
                }
              />
            ))}
          </Card>
        </View>
      ))}

      <View style={styles.signOut}>
        <Button title="Sign out" variant="danger" onPress={() => logout()} />
      </View>

      <View style={styles.legalRow}>
        <Text style={styles.legalLink} onPress={() => Linking.openURL(TERMS_URL)}>
          Terms of Use
        </Text>
        <Text style={styles.legalDot}>·</Text>
        <Text style={styles.legalLink} onPress={() => Linking.openURL(PRIVACY_URL)}>
          Privacy Policy
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  identity: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md },
  avatar: {
    width: 48, height: 48, borderRadius: 24, backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center', marginRight: spacing.md,
  },
  avatarText: { color: '#fff', fontSize: 20, fontWeight: '700' },
  identityText: { flex: 1, minWidth: 0 },
  name: { fontSize: 18, fontWeight: '700', color: colors.text },
  email: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  householdChip: {
    alignSelf: 'flex-start', marginTop: 6, fontSize: 12, fontWeight: '600',
    color: colors.primary, backgroundColor: colors.primary + '18',
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, overflow: 'hidden',
  },
  badge: {
    backgroundColor: colors.primary, color: '#fff', fontSize: 11, fontWeight: '600',
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, overflow: 'hidden',
  },
  menu: { padding: 0, marginBottom: spacing.md },
  signOut: { marginTop: spacing.md },

  // iOS-Settings-style red count on the Invitations row (badge + chevron —
  // ListRow's `right` replaces its default chevron, so re-add it).
  invBadgeRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  invBadge: {
    minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5,
    backgroundColor: colors.error, alignItems: 'center', justifyContent: 'center',
  },
  invBadgeText: { color: '#fff', fontSize: 12, fontWeight: '700' },

  // AI-credits card.
  card: { marginBottom: spacing.md },
  usageHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  usageHeading: { fontSize: 13, fontWeight: '600', color: colors.textMuted },
  creditRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, marginTop: 4 },
  creditBalance: { fontSize: 26, fontWeight: '700', color: colors.text },
  creditCaption: { fontSize: 13, color: colors.textMuted },
  creditNote: { fontSize: 12, color: colors.textMuted, marginTop: 6 },

  legalRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  legalLink: { color: colors.primary, fontSize: 12, textDecorationLine: 'underline' },
  legalDot: { color: colors.textMuted, fontSize: 12 },
});
