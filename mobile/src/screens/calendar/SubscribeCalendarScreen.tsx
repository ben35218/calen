import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQuery } from '@tanstack/react-query';
import { householdApi, HouseholdMember } from '../../api';
import { useAuth } from '../../store/auth';
import { COLOR_PRESETS, useCustomCalendars } from '../../lib/calendarPrefs';
import { previewFeed, refreshFeed, FeedError } from '../../lib/calendarFeeds';
import { Screen, Input, SectionTitle, useHeaderCheckButton, ColorPicker } from '../../components/ui';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import { form as fs, GroupCard, CardDivider } from '../../components/formStyles';
import { colors, spacing } from '../../theme';
import type { CalendarStackParamList } from '../../navigation/CalendarNavigator';

function memberName(m: HouseholdMember): string {
  const full = [m.firstName, m.lastName].filter(Boolean).join(' ');
  return full || m.email || 'Member';
}

const FEED_ERROR_COPY: Record<string, string> = {
  invalid_url: 'That doesn’t look like a calendar link.',
  fetch_failed: 'Couldn’t reach that calendar. Check the link and your connection.',
  not_ics: 'That link isn’t a calendar feed.',
};

// A subscribe link can't be derived from an email — every provider hides it in a
// different settings page and the user has to copy it themselves. So we detect
// the provider from their email domain and deep-link them to the right page with
// step-by-step guidance; they still paste the resulting webcal/https URL above.
type ProviderKey = 'google' | 'icloud' | 'outlook' | 'other';

function detectProvider(email: string): ProviderKey {
  const domain = (email.split('@')[1] || '').trim().toLowerCase();
  if (/(^|\.)(gmail|googlemail)\.com$/.test(domain)) return 'google';
  if (/(^|\.)(icloud|me|mac)\.com$/.test(domain)) return 'icloud';
  if (/(^|\.)(outlook|hotmail|live|msn)\./.test(domain)) return 'outlook';
  return 'other';
}

const PROVIDER_GUIDES: Record<ProviderKey, { name: string; url?: string; steps: string }> = {
  google: {
    name: 'Google Calendar',
    url: 'https://calendar.google.com/calendar/r/settings',
    steps:
      'Open Google Calendar settings, choose your calendar under “Settings for my calendars”, then copy its “Secret address in iCal format”. Paste that link above.',
  },
  icloud: {
    name: 'iCloud Calendar',
    url: 'https://www.icloud.com/calendar/',
    steps:
      'In iCloud Calendar, click the share icon beside a calendar, turn on “Public Calendar”, then copy the webcal link. Paste it above.',
  },
  outlook: {
    name: 'Outlook Calendar',
    url: 'https://outlook.live.com/calendar/0/options/calendar/SharedCalendars',
    steps:
      'In Outlook’s calendar sharing settings, publish a calendar, pick the ICS link, then copy it. Paste that link above.',
  },
  other: {
    name: 'your calendar',
    steps:
      'Open your calendar’s settings and look for an “export”, “subscribe”, “public link”, or “ICS / iCal” option, then copy that link and paste it above.',
  },
};

// Subscribe to an external calendar by ICS/webcal URL (an iCloud public link,
// Google's "secret address", a school or sports feed…). Two phases: paste +
// verify the link, then confirm name/colour/sharing. The subscription saves as
// a CustomCalendar with a feedUrl — always read-only; each member's device
// fetches the feed itself (lib/calendarFeeds), so events never touch the
// server. Sharing is the household model minus per-person access levels and
// outside emails (nobody can edit feed events either way).
export default function SubscribeCalendarScreen() {
  const nav = useNavigation<NativeStackNavigationProp<CalendarStackParamList>>();
  const { user } = useAuth();
  const { addCalendar } = useCustomCalendars();

  const [url, setUrl] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewFeed>> | null>(null);

  // The "don't have the link yet?" provider helper (guided, not automated).
  const [helperOpen, setHelperOpen] = useState(false);
  const [helperEmail, setHelperEmail] = useState('');
  const guide = helperEmail.includes('@') ? PROVIDER_GUIDES[detectProvider(helperEmail)] : null;

  const [name, setName] = useState('');
  const [color, setColor] = useState(COLOR_PRESETS[0]);
  const [sharedWithHousehold, setSharedWithHousehold] = useState(false);
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());

  const { data: household } = useQuery({
    queryKey: ['household'],
    queryFn: async () => (await householdApi.get()).data,
  });
  const others = (household?.members ?? []).filter((m) => m._id !== user?._id);

  const verify = async () => {
    if (verifying || !url.trim()) return;
    setVerifying(true);
    setError('');
    try {
      const result = await previewFeed(url);
      setPreview(result);
      if (!name.trim() && result.name) setName(result.name);
    } catch (e: any) {
      setError((e instanceof FeedError && FEED_ERROR_COPY[e.code]) || FEED_ERROR_COPY.fetch_failed);
    } finally {
      setVerifying(false);
    }
  };

  // Editing the URL after a successful verify restarts phase one.
  const onUrlChange = (t: string) => {
    setUrl(t);
    setPreview(null);
    if (error) setError('');
  };

  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!preview || !name.trim() || saving) return;
    setSaving(true);
    try {
      const created = await addCalendar({
        name: name.trim(),
        color,
        alertsEnabled: true,
        sharedWithHousehold,
        householdAccess: 'view',
        sharedWith: sharedWithHousehold
          ? []
          : [...memberIds].map((userId) => ({ userId, access: 'view' as const })),
        sharedWithOutside: [],
        feedUrl: preview.url,
      });
      // Warm the cache so events appear right away; failures self-heal on the
      // next calendar load.
      refreshFeed(created.id).catch(() => {});
      allowLeave();
      // Skip back past the Add Calendar chooser to the calendar list.
      const routes = nav.getState()?.routes ?? [];
      const below = routes[routes.length - 2];
      if (below?.name === 'AddCalendarMenu') nav.pop(2);
      else nav.goBack();
    } catch {
      Alert.alert('Couldn’t subscribe', 'Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  };
  useHeaderCheckButton(nav, {
    onPress: save,
    disabled: !preview || !name.trim(),
    loading: saving,
    enabled: !!preview,
  });

  // Discard guard: this create-only screen is ready on first render, so its
  // baseline is the empty form. Dirty = a pasted link or any confirmed-phase
  // edit (name / colour / sharing) that would be lost on leaving.
  const baselineRef = useRef<string | null>(null);
  const snapshot = JSON.stringify({ url, name, color, sharedWithHousehold, memberIds: [...memberIds] });
  useEffect(() => {
    if (baselineRef.current === null) baselineRef.current = snapshot;
  }, [snapshot]);
  const dirty = baselineRef.current !== null && snapshot !== baselineRef.current;
  const allowLeave = useUnsavedChangesGuard(nav, dirty);

  const toggleMember = (id: string) =>
    setMemberIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const sampleDate = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <Screen>
      <SectionTitle>Calendar Link</SectionTitle>
      <GroupCard>
        <Input
          value={url}
          onChangeText={onUrlChange}
          placeholder="https:// or webcal:// calendar link"
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          onSubmitEditing={verify}
          containerStyle={fs.headField}
          style={fs.headInput}
        />
      </GroupCard>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Text style={styles.hint}>
        Paste a calendar’s public or secret address — an iCloud public calendar link, a Google
        calendar’s “Secret address in iCal format”, or any .ics feed.
      </Text>

      {!preview ? (
        <>
          <TouchableOpacity
            style={[styles.verifyBtn, (!url.trim() || verifying) && styles.verifyBtnDisabled]}
            activeOpacity={0.7}
            disabled={!url.trim() || verifying}
            onPress={verify}
          >
            {verifying ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Ionicons name="link-outline" size={20} color={colors.primary} />
            )}
            <Text style={styles.verifyBtnText}>{verifying ? 'Checking…' : 'Verify Link'}</Text>
          </TouchableOpacity>

          {/* Provider helper: guide the user to where their link lives. */}
          <TouchableOpacity style={styles.helperToggle} activeOpacity={0.7} onPress={() => setHelperOpen((v) => !v)}>
            <Ionicons name="help-circle-outline" size={18} color={colors.primary} />
            <Text style={styles.helperToggleText}>Don’t have the link yet?</Text>
            <Ionicons name={helperOpen ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textMuted} />
          </TouchableOpacity>
          {helperOpen ? (
            <View style={styles.helperBody}>
              <Text style={styles.helperIntro}>
                Enter your email and we’ll point you to where your provider keeps its calendar link.
              </Text>
              <Input
                value={helperEmail}
                onChangeText={setHelperEmail}
                placeholder="you@email.com"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
              />
              {guide ? (
                <>
                  <Text style={styles.helperSteps}>{guide.steps}</Text>
                  {guide.url ? (
                    <TouchableOpacity
                      style={styles.helperOpenBtn}
                      activeOpacity={0.7}
                      onPress={() => Linking.openURL(guide.url!).catch(() => {})}
                    >
                      <Ionicons name="open-outline" size={18} color={colors.primary} />
                      <Text style={styles.helperOpenText}>Open {guide.name}</Text>
                    </TouchableOpacity>
                  ) : null}
                </>
              ) : null}
            </View>
          ) : null}
        </>
      ) : (
        <>
          <SectionTitle>Preview</SectionTitle>
          <GroupCard>
            <View style={styles.previewHead}>
              <View style={[styles.previewAccent, { backgroundColor: color }]} />
              <View style={styles.previewHeadText}>
                <Text style={styles.previewName}>{preview.name || 'Calendar'}</Text>
                <Text style={styles.previewCount}>
                  {preview.eventCount} event{preview.eventCount === 1 ? '' : 's'}
                </Text>
              </View>
              <Ionicons name="checkmark-circle" size={22} color={color} />
            </View>
            {preview.sample.map((s, i) => (
              <React.Fragment key={`${s.date}-${i}`}>
                <CardDivider />
                <View style={styles.sampleRow}>
                  <Text style={styles.sampleTitle} numberOfLines={1}>{s.title}</Text>
                  <Text style={styles.sampleDate}>{sampleDate(s.date)}</Text>
                </View>
              </React.Fragment>
            ))}
          </GroupCard>

          <GroupCard>
            <Input
              value={name}
              onChangeText={setName}
              placeholder="Calendar Name"
              returnKeyType="done"
              containerStyle={fs.headField}
              style={fs.headInput}
            />
          </GroupCard>

          <SectionTitle>Shared With</SectionTitle>
          <GroupCard>
            {others.length === 0 ? (
              <Text style={styles.emptyText}>No one else is in your household yet.</Text>
            ) : (
              <>
                <TouchableOpacity
                  style={styles.memberRow}
                  activeOpacity={0.7}
                  onPress={() => setSharedWithHousehold((v) => !v)}
                >
                  <View style={styles.memberLabel}>
                    <Ionicons name="home-outline" size={18} color={colors.textMuted} />
                    <Text style={styles.memberName}>Everyone in {household?.name || 'my household'}</Text>
                  </View>
                  <Ionicons
                    name={sharedWithHousehold ? 'checkmark-circle' : 'ellipse-outline'}
                    size={24}
                    color={sharedWithHousehold ? color : colors.border}
                  />
                </TouchableOpacity>
                {!sharedWithHousehold &&
                  others.map((m) => {
                    const selected = memberIds.has(m._id);
                    return (
                      <React.Fragment key={m._id}>
                        <CardDivider />
                        <TouchableOpacity
                          style={styles.memberRow}
                          activeOpacity={0.7}
                          onPress={() => toggleMember(m._id)}
                        >
                          <Text style={[styles.memberName, styles.memberNameFlex]}>{memberName(m)}</Text>
                          <Ionicons
                            name={selected ? 'checkmark-circle' : 'ellipse-outline'}
                            size={24}
                            color={selected ? color : colors.border}
                          />
                        </TouchableOpacity>
                      </React.Fragment>
                    );
                  })}
              </>
            )}
          </GroupCard>
          <Text style={styles.hint}>Everyone sees these events; no one can edit them.</Text>

          <SectionTitle>Colour</SectionTitle>
          <GroupCard style={styles.paletteCard}>
            <ColorPicker value={color} onChange={setColor} options={COLOR_PRESETS} />
          </GroupCard>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 13, color: colors.textMuted, marginTop: -4, marginBottom: spacing.lg, paddingHorizontal: 2 },
  error: { fontSize: 13, color: colors.error, marginTop: -4, marginBottom: spacing.sm, paddingHorizontal: 2 },
  verifyBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, paddingVertical: 12, backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border },
  verifyBtnDisabled: { opacity: 0.5 },
  verifyBtnText: { fontSize: 15, fontWeight: '600', color: colors.primary },
  helperToggle: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.md },
  helperToggleText: { flex: 1, fontSize: 14, fontWeight: '600', color: colors.primary },
  helperBody: { backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 14, gap: spacing.sm },
  helperIntro: { fontSize: 13, color: colors.textMuted },
  helperSteps: { fontSize: 14, color: colors.text, lineHeight: 20 },
  helperOpenBtn: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 6 },
  helperOpenText: { fontSize: 15, fontWeight: '600', color: colors.primary },
  previewHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 12, paddingHorizontal: 14 },
  previewAccent: { width: 4, height: 36, borderRadius: 2 },
  previewHeadText: { flex: 1 },
  previewName: { fontSize: 16, fontWeight: '600', color: colors.text },
  previewCount: { fontSize: 13, color: colors.textMuted, marginTop: 1 },
  sampleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, paddingVertical: 10, paddingHorizontal: 14 },
  sampleTitle: { fontSize: 14, color: colors.text, flexShrink: 1 },
  sampleDate: { fontSize: 13, color: colors.textMuted },
  emptyText: { fontSize: 14, color: colors.textMuted, paddingVertical: 10, paddingHorizontal: 14 },
  memberRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, paddingHorizontal: 14, gap: spacing.sm },
  memberLabel: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1, marginRight: spacing.sm },
  memberName: { fontSize: 16, color: colors.text, flexShrink: 1 },
  memberNameFlex: { flex: 1 },
  paletteCard: { padding: 14 },
});
