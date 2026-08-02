import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQuery } from '@tanstack/react-query';
import { householdApi, ecardsApi, invitationsApi, HouseholdMember, CalendarAccess } from '../../api';
import { useAuth } from '../../store/auth';
import {
  CALENDARS,
  COLOR_PRESETS,
  DELETABLE_DEFAULT_IDS,
  useCustomCalendars,
  useCalendarColors,
  useDeletedDefaultCalendars,
  useDefaultCalendarAlerts,
  holidayCalendarSeed,
} from '../../lib/calendarPrefs';
import type { CountryCode } from '../../lib/holidays';
import { detectHomeRegion } from '../../lib/homeRegion';
import { refreshFeed, getFeedMeta, dropFeedCache, FeedError } from '../../lib/calendarFeeds';
import { Screen, Input, RevealWrap, SectionTitle, Button, SwitchRow, useHeaderCheckButton, ColorPicker } from '../../components/ui';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import { useRosterSuggestions } from '../../hooks/useRosterSuggestions';
import { form as fs, GroupCard, CardDivider } from '../../components/formStyles';
import { colors, spacing } from '../../theme';
import type { CalendarStackParamList } from '../../navigation/CalendarNavigator';
import { classifyRecipient, composeShareSms, Recipient } from '../../lib/shareInvite';
import { useEmailComposer } from '../../components/EmailAppSheet';

function memberName(m: HouseholdMember): string {
  const full = [m.firstName, m.lastName].filter(Boolean).join(' ');
  return full || m.email || 'Member';
}

// An outside-share entry, addressed by email or phone, at a given access level.
type OutsideEntry = { email?: string; phone?: string; access: CalendarAccess };
const outsideKey = (o: { email?: string; phone?: string }) => o.email || o.phone || '';

// Tappable "View Only / Full Access" pill next to a shared person. Tapping
// toggles the level; tinted with the calendar colour when Full Access.
function AccessPill({
  access,
  color,
  onToggle,
  disabled,
}: {
  access: CalendarAccess;
  color: string;
  onToggle: () => void;
  disabled?: boolean;
}) {
  const full = access === 'full';
  return (
    <TouchableOpacity
      style={[styles.accessPill, full && { borderColor: color }]}
      onPress={onToggle}
      disabled={disabled}
      activeOpacity={0.7}
      hitSlop={{ top: 8, bottom: 8 }}
    >
      <Text style={[styles.accessPillText, full && { color }]}>{full ? 'Full Access' : 'View Only'}</Text>
      <Ionicons name="chevron-expand" size={12} color={full ? color : colors.textMuted} />
    </TouchableOpacity>
  );
}

const flip = (a: CalendarAccess): CalendarAccess => (a === 'full' ? 'view' : 'full');

// Create (or edit, when `calendarId` is passed) a user-defined calendar:
// name, who it's shared with (each person View Only or Full Access), colour,
// and whether its events may display alerts. Also edits the built-in default
// calendars (`calendarId` = a DELETABLE_DEFAULT_IDS entry): fixed name,
// household-only sharing, with colour/alerts/delete backed by device prefs.
export default function AddCalendarScreen() {
  const nav = useNavigation<NativeStackNavigationProp<CalendarStackParamList>>();
  const route = useRoute<RouteProp<CalendarStackParamList, 'AddCalendar'>>();
  const calendarId = route.params?.calendarId;
  // Present when creating a holiday calendar from the country picker.
  const holidayCountry = route.params?.holidayCountry as CountryCode | undefined;
  const holidaySeed = holidayCountry ? holidayCalendarSeed(holidayCountry) : undefined;
  const { user } = useAuth();
  const { calendars, addCalendar, updateCalendar, removeCalendar } = useCustomCalendars();
  const { colors: calColors, setColor: setDefaultColor } = useCalendarColors();
  const { deleteDefault } = useDeletedDefaultCalendars();
  const { mutedIds: defaultMutedIds, setAlertsEnabled: setDefaultAlerts } = useDefaultCalendarAlerts();
  const defaultDef = calendarId && DELETABLE_DEFAULT_IDS.includes(calendarId)
    ? CALENDARS.find((c) => c.id === calendarId)
    : undefined;
  const isDefault = !!defaultDef;
  const existing = calendarId && !isDefault ? calendars.find((c) => c.id === calendarId) : undefined;

  // A holiday calendar: creating one (holidayCountry) or editing an existing
  // one. Read-only events, so it shares custom calendars' sharing/colour but
  // skips the Outside section (like subscriptions).
  const isHoliday = !!holidayCountry || !!existing?.holiday;

  // Creating a holiday calendar for the home country preselects the home
  // province/state (detected from the saved address, client-side). Regions are
  // edited later on HolidaysScreen, so this only seeds the create payload; if
  // detection hasn't resolved by save time the address-save hook fills it in.
  const [homeRegion, setHomeRegion] = useState<string | undefined>();
  useEffect(() => {
    if (!holidayCountry) return;
    detectHomeRegion().then((h) => {
      if (h?.country === holidayCountry && h.region) setHomeRegion(h.region);
    });
  }, [holidayCountry]);

  // Selected members as id → access (presence = selected).
  const toMemberMap = (entries?: { userId: string; access: CalendarAccess }[]) =>
    Object.fromEntries((entries ?? []).map((m) => [m.userId, m.access]));

  const [name, setName] = useState(defaultDef?.name ?? existing?.name ?? holidaySeed?.name ?? '');
  const [sharedWithHousehold, setSharedWithHousehold] = useState(existing?.sharedWithHousehold ?? false);
  const [householdAccess, setHouseholdAccess] = useState<CalendarAccess>(existing?.householdAccess ?? 'full');
  const [memberAccess, setMemberAccess] = useState<Record<string, CalendarAccess>>(toMemberMap(existing?.sharedWith));
  const [outside, setOutside] = useState<OutsideEntry[]>(existing?.sharedWithOutside ?? []);
  const [color, setColor] = useState(
    defaultDef ? (calColors[defaultDef.id] ?? defaultDef.color) : (existing?.color ?? holidaySeed?.color ?? COLOR_PRESETS[0])
  );
  const [alertsEnabled, setAlertsEnabled] = useState(
    defaultDef ? !defaultMutedIds.includes(defaultDef.id) : (existing?.alertsEnabled ?? true)
  );
  const [emailDraft, setEmailDraft] = useState('');
  const [emailError, setEmailError] = useState('');
  const [emailNote, setEmailNote] = useState('');
  const [suggestOpen, setSuggestOpen] = useState(false);
  // The account-existence lookup on add is awaited (it decides whether the
  // composer opens) — surface it on the add button so the tap isn't silent.
  const [addingOutside, setAddingOutside] = useState(false);
  const { composeEmail, emailSheet } = useEmailComposer();
  // Editing state loads async from AsyncStorage; seed the form once it arrives.
  const [seeded, setSeeded] = useState(!calendarId);
  useEffect(() => {
    if (seeded || !existing) return;
    setName(existing.name);
    setSharedWithHousehold(existing.sharedWithHousehold);
    setHouseholdAccess(existing.householdAccess);
    setMemberAccess(toMemberMap(existing.sharedWith));
    setOutside(existing.sharedWithOutside);
    setColor(existing.color);
    setAlertsEnabled(existing.alertsEnabled);
    setSeeded(true);
  }, [seeded, existing]);

  // Housemates get read access to calendars shared with them; only the
  // creator edits (the server enforces this too).
  const readOnly = !!existing && !existing.mine;

  // A subscribed (feed-backed) calendar: URL is immutable, events are always
  // read-only, and Outside/Alerts sections don't apply.
  const isSubscription = !!existing?.feedUrl;
  const [feedMeta, setFeedMeta] = useState<{ lastFetched: number | null; error?: string }>({ lastFetched: null });
  const [refreshingFeed, setRefreshingFeed] = useState(false);
  useEffect(() => {
    if (isSubscription && calendarId) getFeedMeta(calendarId).then(setFeedMeta);
  }, [isSubscription, calendarId]);

  useEffect(() => {
    if (calendarId) {
      nav.setOptions({
        title: isSubscription
          ? 'Edit Subscription'
          : isHoliday
          ? 'Edit Holiday Calendar'
          : readOnly
          ? 'Calendar'
          : 'Edit Calendar',
      });
    } else if (isHoliday) {
      nav.setOptions({ title: 'New Holiday Calendar' });
    }
  }, [calendarId, readOnly, isSubscription, isHoliday, nav]);

  const { data: household } = useQuery({
    queryKey: ['household'],
    queryFn: async () => (await householdApi.get()).data,
  });
  const others = (household?.members ?? []).filter((m) => m._id !== user?._id);

  // Deleting the Occasions calendar is a local, reversible hide — it does NOT
  // cancel the household's scheduled e-cards, which keep sending server-side.
  // Warn about that on delete and offer a path to manage them. Only the
  // Occasions calendar (id 'birthdays') schedules e-cards, so scope the query.
  const isOccasions = defaultDef?.id === 'birthdays';
  const { data: ecards } = useQuery({
    queryKey: ['ecards'],
    queryFn: () => ecardsApi.list().then((r) => r.data),
    enabled: isOccasions,
  });
  const activeECardCount = (ecards ?? []).filter((c) => c.active !== false).length;

  const [saving, setSaving] = useState(false);
  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    // Default calendars save to device prefs (colour override + alerts mute).
    if (isDefault && defaultDef) {
      if (color.toLowerCase() !== (calColors[defaultDef.id] ?? defaultDef.color).toLowerCase()) {
        setDefaultColor(defaultDef.id, color);
      }
      setDefaultAlerts(defaultDef.id, alertsEnabled);
      allowLeave();
      nav.goBack();
      return;
    }
    const payload = {
      name: trimmed,
      sharedWithHousehold,
      householdAccess,
      // Household-wide sharing supersedes individual picks — don't persist both.
      sharedWith: sharedWithHousehold
        ? []
        : Object.entries(memberAccess).map(([userId, access]) => ({ userId, access })),
      // Holiday calendars never share outside the household.
      sharedWithOutside: isHoliday ? [] : outside,
      color,
      alertsEnabled,
      // Seed a new holiday calendar's config (regions/holidays edited later on
      // HolidaysScreen); the detected home province/state starts selected.
      // Editing a holiday calendar leaves `holiday` untouched.
      ...(holidayCountry ? { holiday: { country: holidayCountry, selectedRegions: homeRegion ? [homeRegion] : [], disabledIds: [] } } : {}),
    };
    setSaving(true);
    try {
      if (calendarId) await updateCalendar(calendarId, payload);
      else await addCalendar(payload);
      allowLeave();
      dismissAfterSave();
    } catch (e: any) {
      // Outside sharing on an E2EE-active household needs the (unbuilt)
      // decrypt-on-share step — the server fails safe (§9.5).
      if (e?.response?.data?.error === 'decrypt_required') {
        Alert.alert(
          'Sharing outside isn’t available yet',
          'Calendars can’t be shared with people outside your household yet. Remove the outside emails to save.',
        );
      } else {
        Alert.alert('Couldn’t save calendar', 'Check your connection and try again.');
      }
    } finally {
      setSaving(false);
    }
  };
  useHeaderCheckButton(nav, { onPress: save, disabled: !name.trim(), loading: saving, enabled: !readOnly });

  // Discard guard. Create + default calendars are ready on first render (their
  // fields seed synchronously); a custom-calendar edit loads async, gated by the
  // existing `seeded` flag. Read-only (shared-with-me) calendars can't be edited.
  const formReady = isDefault || seeded;
  const baselineRef = useRef<string | null>(null);
  const snapshot = JSON.stringify({ name, sharedWithHousehold, householdAccess, memberAccess, outside, color, alertsEnabled });
  useEffect(() => {
    if (formReady && baselineRef.current === null) baselineRef.current = snapshot;
  }, [formReady, snapshot]);
  const dirty = !readOnly && formReady && baselineRef.current !== null && snapshot !== baselineRef.current;
  const allowLeave = useUnsavedChangesGuard(nav, dirty);

  const toggleMember = (id: string) =>
    setMemberAccess((prev) => {
      if (id in prev) {
        const { [id]: _gone, ...rest } = prev;
        return rest;
      }
      return { ...prev, [id]: 'full' };
    });
  const flipMemberAccess = (id: string) =>
    setMemberAccess((prev) => ({ ...prev, [id]: flip(prev[id]) }));
  const flipOutsideAccess = (key: string) =>
    setOutside((prev) => prev.map((o) => (outsideKey(o) === key ? { ...o, access: flip(o.access) } : o)));

  // Already staged outside entries, household member emails, and the owner's
  // own email — hidden from suggestions, and (for the typed path) rejected with
  // a pointed message before staging.
  const takenOutside = useMemo(() => {
    const set = new Set<string>();
    for (const o of outside) set.add(outsideKey(o).toLowerCase());
    for (const m of household?.members ?? []) if (m.email) set.add(m.email.toLowerCase());
    if (user?.email) set.add(user.email.toLowerCase());
    return set;
  }, [outside, household?.members, user?.email]);

  // Roster contacts matching what's typed, resolved to the recipient a tap
  // would stage — the shared autocomplete behind every share/invite field.
  // Only live while the Outside section renders (default/subscription/holiday
  // calendars never share outside).
  const suggestions = useRosterSuggestions(
    emailDraft,
    takenOutside,
    !readOnly && !isDefault && !isSubscription && !isHoliday,
  );

  // Stage a recipient (typed or tapped suggestion) in the outside list at View
  // Only. Unlike the household invite, nothing is sent here — the share grants
  // on save. The outreach IS composed from this device on add — texted (phone)
  // or emailed (email) from the owner's own apps; the server sends no invite
  // mail/text.
  const stageOutside = async (recipient: Recipient) => {
    const key = outsideKey(recipient);
    if (outside.some((o) => outsideKey(o) === key)) return;
    setOutside((prev) => [...prev, { ...recipient, access: 'view' }]);
    // A recipient already on Calen needs no outreach from this device: when
    // the share saves, the server pushes their registered devices and the
    // invite lands in their in-app inbox (households-sharing.md). The composer
    // only opens for someone not on Calen yet; the row's Remind button
    // re-opens it on demand. Lookup failures fail open (compose anyway).
    setAddingOutside(true);
    let exists = false;
    try {
      exists = (await invitationsApi.lookup(recipient)).data.userExists;
    } catch { /* fail open */ } finally {
      setAddingOutside(false);
    }
    if (exists) {
      setEmailNote('They’re on Calen — they’ll be notified in-app when you save.');
      return;
    }
    await composeOutreach(recipient);
  };

  // Add whatever's typed by email or phone; household members belong above.
  const addOutsideRecipient = async () => {
    if (!emailDraft.trim()) return;
    const recipient = classifyRecipient(emailDraft);
    if (!recipient) return setEmailError('Enter a valid email or phone number.');
    if ('email' in recipient) {
      if (recipient.email === user?.email?.toLowerCase()) return setEmailError('That’s you — no need to share.');
      const member = (household?.members ?? []).find((m) => m.email?.toLowerCase() === recipient.email);
      if (member) return setEmailError(`${memberName(member)} is in your household — select them above.`);
    }
    setEmailError('');
    setEmailNote('');
    setEmailDraft('');
    setSuggestOpen(false);
    await stageOutside(recipient);
  };

  // A tapped suggestion skips the typed-path checks — `takenOutside` already
  // filtered members, the owner, and staged duplicates out of the dropdown.
  const addFromSuggestion = async (entry: Recipient) => {
    setEmailError('');
    setEmailNote('');
    setEmailDraft('');
    setSuggestOpen(false);
    await stageOutside(entry);
  };

  // Raw outreach — always opens the composer (Messages or the mail-app
  // chooser). Used on add for non-account recipients and by the row Remind.
  const composeOutreach = async (recipient: { email?: string; phone?: string }) => {
    const what = name.trim() ? `the “${name.trim()}” calendar` : 'a shared calendar';
    if (recipient.phone) {
      try {
        await composeShareSms(recipient.phone, what);
      } catch (e: any) {
        setEmailError(e?.message || 'Added, but the text couldn’t be started.');
      }
    } else if (recipient.email) {
      try {
        await composeEmail(recipient.email, what);
      } catch (e: any) {
        setEmailError(e?.message || 'Added, but the email couldn’t be started.');
      }
    }
  };

  const refreshNow = async () => {
    if (!calendarId || refreshingFeed) return;
    setRefreshingFeed(true);
    try {
      await refreshFeed(calendarId);
      setFeedMeta(await getFeedMeta(calendarId));
    } catch (e: any) {
      setFeedMeta(await getFeedMeta(calendarId));
      Alert.alert(
        'Couldn’t refresh',
        e instanceof FeedError && e.code === 'not_ics'
          ? 'That link no longer returns a calendar feed.'
          : 'Check the link and your connection, then try again.'
      );
    } finally {
      setRefreshingFeed(false);
    }
  };

  // "Last refreshed" line for a subscription (relative, coarse).
  const lastRefreshedLabel = () => {
    if (feedMeta.error && !feedMeta.lastFetched) return 'Never refreshed';
    if (!feedMeta.lastFetched) return 'Not refreshed yet';
    const mins = Math.floor((Date.now() - feedMeta.lastFetched) / 60000);
    const when =
      mins < 1 ? 'just now'
      : mins < 60 ? `${mins} min ago`
      : mins < 1440 ? `${Math.floor(mins / 60)} hr ago`
      : `${Math.floor(mins / 1440)} day${Math.floor(mins / 1440) === 1 ? '' : 's'} ago`;
    return `Last refreshed ${when}`;
  };

  // The feature view each default calendar's header pencil lives on. After
  // deleting that calendar, going back would land on the view of the calendar
  // that no longer exists — pop past it instead.
  const FEATURE_HOME: Record<string, string> = {
    chores: 'ChoresHome',
    recipes: 'KitchenHome',
    maintenance: 'MaintenanceHome',
    trips: 'Trips',
    birthdays: 'Birthdays',
    weather: 'Weather',
  };
  const dismissAfterDefaultDelete = (id: string) => {
    const routes = nav.getState()?.routes ?? [];
    const below = routes[routes.length - 2];
    if (below?.name === FEATURE_HOME[id]) nav.pop(2);
    else nav.goBack();
  };

  // After creating a calendar through the Add Calendar chooser, skip back past
  // that chooser so we land on the calendar list rather than reopening it.
  const dismissAfterSave = () => {
    const routes = nav.getState()?.routes ?? [];
    const below = routes[routes.length - 2];
    if (below?.name === 'AddCalendarMenu') nav.pop(2);
    else nav.goBack();
  };

  const confirmDelete = () => {
    if (isDefault && defaultDef) {
      const remove = () => {
        deleteDefault(defaultDef.id);
        allowLeave();
        dismissAfterDefaultDelete(defaultDef.id);
      };
      // Deleting the Occasions calendar only hides it here; any scheduled
      // e-cards still send on their dates. Surface that and offer to manage
      // them before deleting (they're managed on the Occasions home screen).
      if (isOccasions && activeECardCount > 0) {
        Alert.alert(
          'Delete Occasions calendar?',
          `It'll be hidden here (you can add it back any time), but your ${activeECardCount} scheduled e-card${activeECardCount === 1 ? '' : 's'} will still send. Manage them first?`,
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Manage e-cards', onPress: () => nav.navigate('Birthdays') },
            { text: 'Delete anyway', style: 'destructive', onPress: remove },
          ]
        );
        return;
      }
      Alert.alert(
        `Delete ${defaultDef.name} calendar?`,
        'Its events will be hidden. You can add it back any time with Add Calendar.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: remove },
        ]
      );
      return;
    }
    const title = isSubscription ? 'Unsubscribe?' : 'Delete calendar?';
    const body = isSubscription
      ? `"${existing?.name}" and its events will disappear for everyone it's shared with.`
      : `"${existing?.name}" will be removed for everyone it's shared with.`;
    Alert.alert(title, body, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: isSubscription ? 'Unsubscribe' : 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await removeCalendar(calendarId!);
            if (isSubscription) await dropFeedCache(calendarId!);
            allowLeave();
            nav.goBack();
          } catch {
            Alert.alert(
              isSubscription ? 'Couldn’t unsubscribe' : 'Couldn’t delete calendar',
              'Check your connection and try again.'
            );
          }
        },
      },
    ]);
  };

  return (
    <Screen>
      {readOnly ? (
        <Text style={styles.readOnlyNote}>
          Shared with you by a housemate — only the calendar's owner can make changes.
        </Text>
      ) : null}

      <GroupCard>
        <Input
          value={name}
          onChangeText={setName}
          placeholder={isHoliday ? 'Holiday Calendar Name' : 'Calendar Name (e.g. School, Soccer)'}
          autoFocus={!calendarId}
          returnKeyType="done"
          editable={!readOnly && !isDefault}
          containerStyle={fs.headField}
          style={fs.headInput}
        />
      </GroupCard>

      {isSubscription ? (
        <>
          <SectionTitle>Subscription</SectionTitle>
          <GroupCard>
            <View style={styles.feedUrlRow}>
              <Ionicons name="globe-outline" size={18} color={colors.textMuted} />
              <Text style={styles.feedUrl} numberOfLines={1}>{existing?.feedUrl}</Text>
            </View>
            <CardDivider />
            <TouchableOpacity
              style={styles.memberRow}
              activeOpacity={0.7}
              disabled={refreshingFeed || readOnly}
              onPress={refreshNow}
            >
              <View style={styles.memberLabel}>
                <Ionicons name="refresh-outline" size={18} color={colors.textMuted} />
                <Text style={styles.memberName}>Refresh now</Text>
              </View>
              {refreshingFeed ? (
                <ActivityIndicator size="small" color={color} />
              ) : (
                <Text style={[styles.feedMetaText, feedMeta.error ? styles.feedMetaError : null]}>
                  {feedMeta.error && !feedMeta.lastFetched ? 'Couldn’t refresh' : lastRefreshedLabel()}
                </Text>
              )}
            </TouchableOpacity>
          </GroupCard>
          {feedMeta.error && feedMeta.lastFetched ? (
            <Text style={styles.hint}>Last refresh failed; showing the most recent events.</Text>
          ) : null}
        </>
      ) : null}

      <SectionTitle>Shared With</SectionTitle>
      <GroupCard>
        {isDefault ? (
          <View style={styles.memberRow}>
            <View style={styles.memberLabel}>
              <Ionicons name="home-outline" size={18} color={colors.textMuted} />
              <Text style={styles.memberName}>Everyone in {household?.name || 'my household'}</Text>
            </View>
            <Ionicons name="checkmark-circle" size={24} color={color} />
          </View>
        ) : others.length === 0 ? (
          <Text style={styles.emptyText}>No one else is in your household yet.</Text>
        ) : (
          <>
            <TouchableOpacity
              style={styles.memberRow}
              activeOpacity={0.7}
              disabled={readOnly}
              onPress={() => setSharedWithHousehold((v) => !v)}
            >
              <View style={styles.memberLabel}>
                <Ionicons name="home-outline" size={18} color={colors.textMuted} />
                <Text style={styles.memberName}>Everyone in {household?.name || 'my household'}</Text>
              </View>
              {sharedWithHousehold ? (
                <AccessPill
                  access={householdAccess}
                  color={color}
                  disabled={readOnly}
                  onToggle={() => setHouseholdAccess(flip)}
                />
              ) : null}
              <Ionicons
                name={sharedWithHousehold ? 'checkmark-circle' : 'ellipse-outline'}
                size={24}
                color={sharedWithHousehold ? color : colors.border}
              />
            </TouchableOpacity>
            {/* Individual picks are implied while the whole household is selected. */}
            {!sharedWithHousehold &&
              others.map((m) => {
                const access = memberAccess[m._id];
                const selected = m._id in memberAccess;
                return (
                  <React.Fragment key={m._id}>
                    <CardDivider />
                    <TouchableOpacity
                      style={styles.memberRow}
                      activeOpacity={0.7}
                      disabled={readOnly}
                      onPress={() => toggleMember(m._id)}
                    >
                      <Text style={[styles.memberName, styles.memberNameFlex]}>{memberName(m)}</Text>
                      {selected ? (
                        <AccessPill
                          access={access}
                          color={color}
                          disabled={readOnly}
                          onToggle={() => flipMemberAccess(m._id)}
                        />
                      ) : null}
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

      {isDefault ? (
        <Text style={styles.hint}>
          Default calendars are shared with your whole household and can’t be shared outside it.
        </Text>
      ) : isSubscription || isHoliday ? (
        <Text style={styles.hint}>Everyone it’s shared with sees these events; no one can edit them.</Text>
      ) : (
        <>
      <SectionTitle>Outside My Household</SectionTitle>
      <GroupCard>
        {readOnly && outside.length === 0 ? (
          <Text style={styles.emptyText}>Not shared outside the household.</Text>
        ) : null}
        {outside.map((o, i) => (
          <React.Fragment key={outsideKey(o)}>
            {i > 0 ? <CardDivider /> : null}
            <View style={styles.memberRow}>
              <View style={styles.memberLabel}>
                <Ionicons name="person-outline" size={18} color={colors.textMuted} />
                <Text style={styles.memberName} numberOfLines={1}>{outsideKey(o)}</Text>
              </View>
              <AccessPill
                access={o.access}
                color={color}
                disabled={readOnly}
                onToggle={() => flipOutsideAccess(outsideKey(o))}
              />
              {!readOnly ? (
                <>
                  {/* Remind — re-open the composer for this recipient (the
                      escape hatch when an account holder's push wasn't
                      noticed). */}
                  <TouchableOpacity
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    onPress={() => composeOutreach(o)}
                    style={styles.remindBtn}
                  >
                    <Ionicons name="paper-plane-outline" size={20} color={color} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    onPress={() => setOutside((prev) => prev.filter((e) => outsideKey(e) !== outsideKey(o)))}
                  >
                    <Ionicons name="close-circle-outline" size={22} color={colors.textMuted} />
                  </TouchableOpacity>
                </>
              ) : null}
            </View>
          </React.Fragment>
        ))}
        {!readOnly ? (
          <>
            {outside.length > 0 ? <CardDivider /> : null}
            <RevealWrap open={suggestOpen} count={suggestions.length}>
              <View style={styles.emailAddRow}>
                <Input
                  value={emailDraft}
                  onChangeText={(t) => {
                    setEmailDraft(t);
                    if (emailError) setEmailError('');
                    if (emailNote) setEmailNote('');
                    setSuggestOpen(true);
                  }}
                  placeholder="Add name, email, or phone…"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  returnKeyType="done"
                  onSubmitEditing={addOutsideRecipient}
                  blurOnSubmit={false}
                  containerStyle={styles.emailInput}
                  style={fs.headInput}
                />
                {addingOutside ? (
                  <ActivityIndicator size="small" color={color} />
                ) : (
                  <TouchableOpacity onPress={addOutsideRecipient} disabled={!emailDraft.trim()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="add-circle" size={28} color={emailDraft.trim() ? color : colors.border} />
                  </TouchableOpacity>
                )}
              </View>
              {suggestOpen && suggestions.length > 0 ? (
                <View style={styles.dropdown}>
                  {suggestions.map(({ p, entry }) => (
                    <TouchableOpacity key={p._id} style={styles.suggestRow} onPress={() => addFromSuggestion(entry)}>
                      <Ionicons
                        name={'phone' in entry ? 'chatbubble-outline' : 'mail-outline'}
                        size={16}
                        color={colors.textMuted}
                      />
                      <View style={styles.suggestText}>
                        <Text style={styles.suggestName} numberOfLines={1}>{p.name}</Text>
                        <Text style={styles.suggestEmail} numberOfLines={1}>
                          {'email' in entry ? entry.email : entry.phone}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : null}
            </RevealWrap>
          </>
        ) : null}
        {emailError ? <Text style={styles.emailError}>{emailError}</Text> : null}
        {emailNote ? <Text style={styles.emailNote}>{emailNote}</Text> : null}
      </GroupCard>
      <Text style={styles.hint}>Full Access lets someone add and edit this calendar’s events; View Only just shows them.</Text>
        </>
      )}

      <SectionTitle>Colour</SectionTitle>
      <GroupCard style={styles.paletteCard}>
        <ColorPicker value={color} onChange={setColor} options={COLOR_PRESETS} disabled={readOnly} />
      </GroupCard>

      {!isSubscription ? (
        <>
          <SectionTitle>Alerts</SectionTitle>
          <GroupCard>
            <View style={fs.groupPad}>
              <SwitchRow
                label="Event Alerts"
                value={alertsEnabled}
                onValueChange={readOnly ? () => {} : setAlertsEnabled}
                color={color}
              />
            </View>
          </GroupCard>
          <Text style={styles.hint}>Allow events on this calendar to display alerts.</Text>
        </>
      ) : null}

      {calendarId && (existing || isDefault) && !readOnly ? (
        <View style={fs.footer}>
          <Button
            title={isSubscription ? 'Unsubscribe' : 'Delete Calendar'}
            variant="danger"
            onPress={confirmDelete}
          />
        </View>
      ) : null}
      {emailSheet}
    </Screen>
  );
}

const styles = StyleSheet.create({
  readOnlyNote: { fontSize: 13, color: colors.textMuted, marginBottom: spacing.md },
  emptyText: { fontSize: 14, color: colors.textMuted, paddingVertical: 10, paddingHorizontal: 14 },
  memberRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, paddingHorizontal: 14, gap: spacing.sm },
  memberLabel: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1, marginRight: spacing.sm },
  memberName: { fontSize: 16, color: colors.text, flexShrink: 1 },
  restoreAccent: { width: 4, height: 24, borderRadius: 2 },
  memberNameFlex: { flex: 1 },
  accessPill: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12, borderWidth: 1, borderColor: colors.border },
  accessPillText: { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  emailAddRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingRight: 14 },
  emailInput: { flex: 1, marginBottom: 0 },
  // Contact autocomplete under the add field (mirrors EventInviteesScreen),
  // inset to sit inside the GroupCard.
  dropdown: {
    borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface,
    marginHorizontal: 14, marginBottom: spacing.sm, overflow: 'hidden',
  },
  suggestRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  suggestText: { flex: 1 },
  suggestName: { fontSize: 14, color: colors.text },
  suggestEmail: { fontSize: 12, color: colors.textMuted },
  emailError: { fontSize: 13, color: colors.error, paddingBottom: 8, paddingHorizontal: 14 },
  emailNote: { fontSize: 13, color: colors.success, paddingBottom: 8, paddingHorizontal: 14 },
  remindBtn: { marginRight: spacing.sm },
  paletteCard: { padding: 14 },
  hint: { fontSize: 13, color: colors.textMuted, marginTop: -4, marginBottom: spacing.lg, paddingHorizontal: 2 },
  subscribeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 12, paddingHorizontal: 14, backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border, marginBottom: spacing.lg },
  subscribeText: { fontSize: 15, fontWeight: '600', color: colors.primary },
  subscribeHint: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
  feedUrlRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 12, paddingHorizontal: 14 },
  feedUrl: { fontSize: 14, color: colors.text, flex: 1 },
  feedMetaText: { fontSize: 13, color: colors.textMuted },
  feedMetaError: { color: colors.error },
});
