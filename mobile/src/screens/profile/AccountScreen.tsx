import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Alert, ActivityIndicator, TouchableOpacity, Linking,
} from 'react-native';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { locationTimezone } from '@household/weather';
import { settingsApi, authApi, householdApi } from '../../api';
import { useAuth } from '../../store/auth';
import { useBilling } from '../../hooks/useBilling';
import { isPurchasesConfigured, showManageSubscriptions, APPLE_SUBSCRIPTIONS_URL } from '../../lib/purchases';
import { getHDK, sealUpdate, openRecord, reauthWithBiometric } from '../../lib/e2ee';
import { isDeviceKeyEnabled } from '../../lib/deviceKey';
import { invalidatePlaceBias } from '../../lib/placeBias';
import { detectHomeRegion } from '../../lib/homeRegion';
import { detectHomeCity, shouldDeriveHomeCity } from '../../lib/homeCity';
import { autoSelectHolidayRegion } from '../../lib/calendarPrefs';
import { HOUSEHOLD_ENC } from '../../lib/encSubsets';
import { resolveCurrentAddress } from '../../lib/currentLocation';
import {
  Input, DateField, Screen, useHeaderCheckButton, Card, Button,
  SectionTitle, SectionHeader, PhoneField, InfoCard, ListRow, SetupCallout, Skeleton,
} from '../../components/ui';
import { MailAppPickerSheet } from '../../components/EmailAppSheet';
import {
  MailApp, MailAppId, MAIL_APPS, detectMailApps, getPreferredMailApp, setPreferredMailApp,
} from '../../lib/shareInvite';
import { form as fs, GroupCard, CardDivider } from '../../components/formStyles';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import PlacesAutocomplete from '../../components/PlacesAutocomplete';
import { colors, spacing } from '../../theme';

// The identity screen: name/email/location (saved by the header check) plus
// Delete account. Everything is laid out flat — one grouped Account card, then
// Delete — with no expand/collapse sections. Email is the account's contact
// identity, so it sits directly above the phone number in the Account card
// (changing it re-authenticates — a fresh device unlock, or the password as a
// fallback). Reminders live on
// their own screen (RemindersScreen); password management, encryption, recovery
// methods, devices, and data controls all live on the dedicated Privacy & security
// screen (PrivacyDataScreen) — Account stays focused on "who you are", plus the
// device-local invite mail-app preference (surfaced here because the chooser
// sheet remembers a pick silently and points users here to change it).
export default function AccountScreen() {
  const qc = useQueryClient();
  const navigation = useNavigation();
  // A Calen "setup" deep-link may land here asking for a specific field — see
  // the SetupCallout + highlight below (currently 'homeAddress').
  const promptField = useRoute<RouteProp<{ Account: { promptField?: 'homeAddress' | 'mailApp' } | undefined }, 'Account'>>().params?.promptField;
  const { user, setUser, logout } = useAuth();

  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => (await settingsApi.get()).data,
  });
  const { data: household } = useQuery({
    queryKey: ['household'],
    queryFn: async () => (await householdApi.get()).data,
  });

  // ── Identity + location ─────────────────────────────────────────────────────
  const [form, setForm] = useState({
    firstName: '', lastName: '', phone: '', birthday: '', homeAddress: '', homeCity: '',
  });
  const [saving, setSaving] = useState(false);
  // Gate for the discard guard's baseline: the identity form seeds from the
  // settings query (and, for E2EE households, an async home-address decrypt), so
  // we only snapshot the clean baseline once that seeding has settled.
  const [seeded, setSeeded] = useState(false);

  // ── Invite mail-app preference ──────────────────────────────────────────────
  // The chooser sheet (components/EmailAppSheet) silently remembers the first
  // pick; this row is where the user sees and changes it. Only rendered when
  // there's actually a choice (2+ known mail apps installed) — with one or none
  // the invite flow never asks. Persists instantly (device-local pref), so it
  // deliberately stays outside the form's dirty/save cycle.
  const [mailApps, setMailApps] = useState<MailApp[]>([]);
  const [mailPref, setMailPref] = useState<MailAppId | null>(null);
  const [mailPickerOpen, setMailPickerOpen] = useState(false);
  useEffect(() => {
    (async () => {
      setMailApps(await detectMailApps());
      setMailPref(await getPreferredMailApp());
    })();
  }, []);
  const mailPrefLabel = MAIL_APPS.find((a) => a.id === mailPref)?.label ?? 'Ask each time';
  const pickMailApp = async (id: MailAppId | null) => {
    setMailPickerOpen(false);
    setMailPref(id);
    await setPreferredMailApp(id);
  };
  // The decrypted household blob (name + homeAddress — C2): spread under the
  // update at seal time so re-sealing the address never drops the sealed name.
  const decryptedHH = useRef<Record<string, unknown>>({});
  // Last-loaded address, to detect a real change at save time (which re-derives
  // the household's default timezone from the new location).
  const loadedAddress = useRef('');
  // The address the shown home area corresponds to, so the automatic city
  // derivation below only fires on a real address change (seeded with the loaded
  // address, which the saved area already matches).
  const cityFromAddress = useRef('');

  useEffect(() => {
    if (!settings) return;
    setForm({
      firstName: settings.firstName ?? '',
      lastName: settings.lastName ?? '',
      phone: settings.phone ?? '',
      birthday: settings.birthday ? String(settings.birthday).slice(0, 10) : '',
      homeAddress: settings.homeAddress ?? '',
      homeCity: settings.homeCity ?? '',
    });
    loadedAddress.current = settings.homeAddress ?? '';
    cityFromAddress.current = settings.homeAddress ?? '';
    // Decrypt the sealed home location over the plaintext (§9.1 P5); dormant
    // without an HDK. Post-drop this is the only source of the address.
    if (settings.enc && getHDK() && settings.householdId) {
      openRecord('Household', { _id: String(settings.householdId), keyVersion: settings.keyVersion, enc: settings.enc } as any)
        .then((dec: any) => {
          decryptedHH.current = { name: dec.name, homeAddress: dec.homeAddress };
          if (dec.homeAddress) {
            loadedAddress.current = dec.homeAddress;
            cityFromAddress.current = dec.homeAddress;
            setForm((f) => ({ ...f, homeAddress: dec.homeAddress }));
          }
        })
        .catch(() => { /* locked / wrong key */ })
        // Baseline only after the decrypt resolves, so the async address fill
        // isn't itself mistaken for an unsaved edit.
        .finally(() => setSeeded(true));
    } else {
      setSeeded(true);
    }
  }, [settings]);

  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  // ── Home area (city) ─────────────────────────────────────────────────────────
  // A coarse "city or general area" label the calendar assistant grounds local
  // suggestions in (never the street address). Setting the home address ANY way
  // — picking a suggestion, filling from GPS, or typing one and leaving the
  // field — fills the area automatically, exactly as the "Fill from home
  // address" button would; the field stays editable to override by hand.
  const cityEdited = useRef(false);
  const [derivingCity, setDerivingCity] = useState(false);
  const setCity = (v: string) => { cityEdited.current = true; setForm((f) => ({ ...f, homeCity: v })); };
  async function deriveCity(address: string) {
    const addr = (address || '').trim();
    if (!addr) return;
    cityFromAddress.current = addr;
    setDerivingCity(true);
    try {
      const label = await detectHomeCity(addr);
      if (label) { cityEdited.current = false; setForm((f) => ({ ...f, homeCity: label })); }
    } catch { /* keep whatever's there */ } finally {
      setDerivingCity(false);
    }
  }
  // Automatic path: only when the address actually changed (an idle blur, or
  // re-picking the same place, must not re-geocode). The manual button calls
  // deriveCity directly, so it always re-fills on demand.
  function autoDeriveCity(address: string) {
    if (shouldDeriveHomeCity(address, cityFromAddress.current)) void deriveCity(address);
  }

  async function save() {
    setSaving(true);
    try {
      let body: Record<string, unknown> = {
        firstName: form.firstName,
        lastName: form.lastName,
        phone: form.phone.trim(),
        birthday: form.birthday || undefined,
        // No timezone here: the stored zone follows the device automatically
        // (lib/useSyncTimezone) — the sync is its single writer.
        homeAddress: form.homeAddress,
        // Coarse home area for the calendar assistant (plaintext, never the
        // street address). Auto-derived or hand-set above.
        homeCity: form.homeCity.trim(),
      };
      // Seal the home location alongside the plaintext (§9.1 P5); no-op without
      // an HDK. The blob also carries the household NAME (C2) — merge the
      // decrypted copy (falling back to the served plaintext) so it survives.
      if (getHDK() && settings?.householdId) {
        body = await sealUpdate('Household', String(settings.householdId), body, HOUSEHOLD_ENC({
          name: decryptedHH.current.name ?? household?.name,
          homeAddress: form.homeAddress,
        }));
      }
      await settingsApi.update(body);
      // A changed home address re-derives the household's default timezone and
      // preselects the home province/state on holiday calendars with no
      // regional picks yet — both keyless + client-side, so they work for E2EE
      // households whose address the server can't read.
      const newAddress = form.homeAddress.trim();
      if (newAddress && newAddress !== loadedAddress.current) {
        loadedAddress.current = newAddress;
        // Everything keyed off the address is now stale — including screens
        // still mounted behind this one. Without this, a user who came from
        // the Weather screen's "Where's home?" prompt lands right back on it
        // (its forecast/outlook queries keep their cached "no home address"
        // error), as does the calendar's forecast strip and the travel-time
        // screen's Home shortcut.
        qc.invalidateQueries({ queryKey: ['weather'] });
        qc.invalidateQueries({ queryKey: ['homeAddress'] });
        void locationTimezone(newAddress).then((tz) =>
          tz ? settingsApi.update({ householdTimezone: tz }) : null,
        ).catch(() => {});
        void detectHomeRegion(newAddress).then((h) =>
          h?.region ? autoSelectHolidayRegion(h.country, h.region) : null,
        );
        // A hand-typed address may never have triggered the on-pick city
        // derivation; if the user hasn't set the area by hand, fill it from the
        // new address and persist it (same keyless geocode as the timezone).
        if (!cityEdited.current && !form.homeCity.trim()) {
          void detectHomeCity(newAddress).then((label) =>
            label ? settingsApi.update({ homeCity: label }) : null,
          ).catch(() => {});
        }
      }
      qc.invalidateQueries({ queryKey: ['settings'] });
      invalidatePlaceBias();
      // Saving the identity form completes the task, so dismiss back to the
      // profile hub automatically (matching ContactFormScreen and the iOS
      // edit-and-done convention) — no blocking "Saved" confirmation to tap
      // through only to land back on a screen the user is finished with.
      allowLeave();
      navigation.goBack();
    } catch (e: any) {
      Alert.alert('Error', e?.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  useHeaderCheckButton(navigation, { onPress: save, loading: saving });

  // Discard guard on the identity form (the header-check saves it). The inline
  // email-change and delete-account flows are separate and don't feed this.
  const baselineRef = useRef<string | null>(null);
  const snapshot = JSON.stringify(form);
  useEffect(() => {
    if (seeded && baselineRef.current === null) baselineRef.current = snapshot;
  }, [seeded, snapshot]);
  const dirty = seeded && baselineRef.current !== null && snapshot !== baselineRef.current;
  const allowLeave = useUnsavedChangesGuard(navigation, dirty);

  // ── "Use my current location" (opt-in, foreground one-shot) ────────────────
  // Prefills the home-address field from device GPS + reverse geocoding; the
  // user still reviews and saves. Nothing is sent to our server until save,
  // and E2EE households seal it exactly like a typed address.
  const [locating, setLocating] = useState(false);

  async function useCurrentLocation() {
    setLocating(true);
    try {
      const res = await resolveCurrentAddress();
      if (res.ok) {
        setForm((f) => ({ ...f, homeAddress: res.address }));
        // Same as picking a suggestion: the address is now set, so fill the area.
        autoDeriveCity(res.address);
        return;
      }
      if (res.reason === 'unavailable') {
        Alert.alert('App update needed', 'This build doesn’t include location support yet. Rebuild/reinstall the app to use this — or just type your address.');
      } else if (res.reason === 'denied') {
        Alert.alert(
          'Location is off',
          'Allow location access in Settings to fill your address automatically — or just type it above.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open Settings', onPress: () => Linking.openSettings() },
          ],
        );
      } else {
        Alert.alert('Could not find your location', 'Please type your address instead.');
      }
    } finally {
      setLocating(false);
    }
  }

  const hasPassword = user?.hasPassword !== false;

  // ── Change email ────────────────────────────────────────────────────────────
  const [emailOpen, setEmailOpen] = useState(false);
  const [emailForm, setEmailForm] = useState({ email: '', currentPassword: '' });
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailError, setEmailError] = useState('');
  // Biometric-first re-auth, mirroring the password change on PrivacyDataScreen:
  // when this device has armed the Face ID / Touch ID / passcode key cache, a
  // fresh device unlock replaces re-typing the current password. Otherwise fall
  // back to the typed password (verified server-side).
  const [emailBioAvailable, setEmailBioAvailable] = useState(false);
  useEffect(() => {
    if (!emailOpen) return;
    let alive = true;
    isDeviceKeyEnabled().then((v) => { if (alive) setEmailBioAvailable(v); });
    return () => { alive = false; };
  }, [emailOpen]);

  async function saveEmail() {
    setEmailSaving(true);
    setEmailError('');
    try {
      // Re-authenticate before the change: a fresh device unlock proves presence
      // in place of the current password (server accepts on the session);
      // otherwise send the typed current password for server-side verification.
      let currentPassword: string | undefined;
      if (emailBioAvailable) {
        if (!(await reauthWithBiometric())) {
          setEmailError('Confirmation is required to change your email.');
          setEmailSaving(false);
          return;
        }
      } else {
        currentPassword = emailForm.currentPassword;
      }
      const { data } = await authApi.updateEmail({ email: emailForm.email.trim(), currentPassword });
      if (user) setUser({ ...user, ...(data as object) });
      setEmailOpen(false);
      setEmailForm({ email: '', currentPassword: '' });
      Alert.alert('Updated', 'Email updated.');
    } catch (e: any) {
      setEmailError(e?.response?.data?.error || 'Failed to update email');
    } finally {
      setEmailSaving(false);
    }
  }

  // ── Delete account (Apple 5.1.1(v)) ──────────────────────────────────────────
  const [delOpen, setDelOpen] = useState(false);
  const [delPw, setDelPw] = useState('');
  const [delBusy, setDelBusy] = useState(false);
  const [delError, setDelError] = useState('');

  // Billing-aware deletion (billing-plans.md "Account deletion × billing"):
  // deleting the account can't cancel the Apple-billed Calen AI plan, so an
  // active plan interposes a keep-billing warning — with the same
  // manage-subscriptions affordance as the plan card — before the destructive
  // confirm. Billing status unavailable (offline, fresh cache) degrades to the
  // plain confirm: deletion must never block on a billing read.
  const { data: billing } = useBilling();

  async function openManageSubscriptions() {
    try {
      if (isPurchasesConfigured()) await showManageSubscriptions();
      else await Linking.openURL(APPLE_SUBSCRIPTIONS_URL);
    } catch {
      Linking.openURL(APPLE_SUBSCRIPTIONS_URL).catch(() => {});
    }
  }

  function confirmDelete() {
    // Password accounts must type their password first; passwordless
    // (passkey/OAuth) accounts have none, so the session token is the proof.
    if (hasPassword && !delPw) return;
    if (billing?.aiPlan?.active) {
      Alert.alert(
        'Your Calen AI plan stays active',
        'Deleting your account does not cancel your subscription — Apple will keep billing it. If you don’t want more charges, cancel it in your App Store subscriptions first.',
        [
          { text: 'Manage subscription', onPress: () => { void openManageSubscriptions(); } },
          { text: 'Delete anyway', style: 'destructive', onPress: confirmWipe },
          { text: 'Cancel', style: 'cancel' },
        ],
      );
      return;
    }
    confirmWipe();
  }

  function confirmWipe() {
    // Credits are prepaid value — name what's forfeited, never silently eat it.
    // (Exempt admins render "Unlimited" everywhere; their balance is noise.)
    const creditsLeft = billing?.unlimited ? 0 : Math.max(0, billing?.creditBalance ?? 0);
    const creditNote = creditsLeft > 0
      ? ` Your remaining ${creditsLeft.toLocaleString()} AI credit${creditsLeft === 1 ? '' : 's'} will be forfeited.`
      : '';
    Alert.alert(
      'Delete your account?',
      `This permanently deletes your account and all your data, including anything you added to your household.${creditNote} This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete account', style: 'destructive', onPress: runDelete },
      ],
    );
  }

  async function runDelete() {
    setDelBusy(true);
    setDelError('');
    try {
      await authApi.deleteAccount(hasPassword ? { password: delPw } : {});
      // Account is gone — tear down the session and return to the auth stack.
      await logout();
    } catch (e: any) {
      setDelError(e?.response?.data?.error || 'Could not delete your account. Please try again.');
      setDelBusy(false);
    }
  }

  if (isLoading) {
    return (
      <Screen>
        <SettingsSkeleton />
      </Screen>
    );
  }

  // Highlight the home-address field only until the user has actually filled it.
  const promptHomeAddress = promptField === 'homeAddress' && !form.homeAddress.trim();

  return (
    <Screen>
      {/* Arrived from a Calen "Add your home address" setup chip: say why, then
          highlight the address field so the fix is obvious. */}
      {promptHomeAddress ? (
        <SetupCallout icon="location">Add your home address so Calen can tailor weather and local suggestions to where you are.</SetupCallout>
      ) : null}

      {/* ── Account (identity + location) ── */}
      <SectionHeader>Account</SectionHeader>
      <GroupCard>
        <Input
          value={form.firstName}
          onChangeText={set('firstName')}
          placeholder="First name"
          autoCapitalize="words"
          textContentType="givenName"
          containerStyle={fs.headField}
          style={fs.headInput}
        />
        <CardDivider />
        <Input
          value={form.lastName}
          onChangeText={set('lastName')}
          placeholder="Last name"
          autoCapitalize="words"
          textContentType="familyName"
          containerStyle={fs.headField}
          style={fs.headInput}
        />
        <CardDivider />
        {/* Email — the account's contact identity, so it sits directly above
            the phone number. The whole row is the affordance (tap to reveal the
            change form + chevron), matching the Sign-in → Password card on the
            Privacy & security screen rather than a separate "Change" button.
            Changing email re-authenticates (biometric-first, password fallback).
            Passwordless accounts keep the existing "not available yet" treatment
            here — so the row is inert (no chevron)
            for those, with the hint below explaining why. */}
        <TouchableOpacity
          style={styles.emailRow}
          activeOpacity={0.7}
          disabled={!hasPassword}
          onPress={() => { setEmailOpen((o) => !o); setEmailError(''); }}
        >
          <View style={styles.secText}>
            <Text style={styles.secLabel}>Email</Text>
            <Text style={styles.secValue} numberOfLines={1}>{user?.email}</Text>
          </View>
          {hasPassword ? (
            <Ionicons name={emailOpen ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textMuted} />
          ) : null}
        </TouchableOpacity>
        {!hasPassword ? (
          <Text style={styles.emailHint}>This is a passwordless account. Changing your email isn’t available yet.</Text>
        ) : null}
        {hasPassword && emailOpen ? (
          <View style={styles.emailExpand}>
            <Input
              label="New email"
              value={emailForm.email}
              onChangeText={(v) => setEmailForm((f) => ({ ...f, email: v }))}
              autoCapitalize="none"
              keyboardType="email-address"
            />
            {!emailBioAvailable ? (
              <Input
                label="Current password"
                value={emailForm.currentPassword}
                onChangeText={(v) => setEmailForm((f) => ({ ...f, currentPassword: v }))}
                secureTextEntry
              />
            ) : null}
            {emailError ? <Text style={styles.error}>{emailError}</Text> : null}
            <Button
              title={emailBioAvailable ? "Confirm it's you" : 'Save email'}
              onPress={saveEmail}
              loading={emailSaving}
              disabled={!emailForm.email.trim() || (!emailBioAvailable && !emailForm.currentPassword)}
            />
          </View>
        ) : null}
        <CardDivider />
        <PhoneField
          value={form.phone}
          onChangeText={set('phone')}
          placeholder="Phone number"
          containerStyle={fs.headField}
          fieldStyle={fs.headInput}
        />
        <CardDivider />
        <PlacesAutocomplete
          value={form.homeAddress}
          onChangeText={set('homeAddress')}
          onSelect={(p) => autoDeriveCity(p.description)}
          // A hand-typed address never fires onSelect — leaving the field is the
          // "done entering it" moment, so fill the area from it there too.
          onBlur={autoDeriveCity}
          placeholder="Home address"
          type="address"
          containerStyle={fs.headField}
          inputStyle={fs.headInput}
          highlight={promptHomeAddress}
        />
        {/* Only a prefill shortcut for an empty field — once there's an address
            (typed or picked), it's redundant, so hide it. */}
        {!form.homeAddress.trim() ? (
          <TouchableOpacity style={styles.locateRow} onPress={useCurrentLocation} disabled={locating} activeOpacity={0.7}>
            {locating
              ? <ActivityIndicator size="small" color={colors.primary} />
              : <Ionicons name="locate-outline" size={16} color={colors.primary} />}
            <Text style={styles.locateLabel}>Use my current location</Text>
          </TouchableOpacity>
        ) : null}
        <CardDivider />
        {/* Home area (city) — the coarse location Calen uses to suggest local
            activities. Auto-fills from the address; editable to override. The
            street address is never sent to the assistant, only this. */}
        <Input
          value={form.homeCity}
          onChangeText={setCity}
          placeholder="City or general area"
          containerStyle={fs.headField}
          style={fs.headInput}
        />
        {derivingCity ? (
          <View style={styles.locateRow}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={styles.cityHint}>Finding your area…</Text>
          </View>
        ) : (!form.homeCity.trim() && form.homeAddress.trim()) ? (
          <TouchableOpacity style={styles.locateRow} onPress={() => deriveCity(form.homeAddress)} activeOpacity={0.7}>
            <Ionicons name="locate-outline" size={16} color={colors.primary} />
            <Text style={styles.locateLabel}>Fill from home address</Text>
          </TouchableOpacity>
        ) : (
          <Text style={styles.cityHint}>Calen uses this to suggest local activities — never your street address.</Text>
        )}
        <CardDivider />
        <DateField
          inlineLabel="Your birthday"
          clearable
          placeholder="None"
          value={form.birthday}
          onChange={set('birthday')}
          containerStyle={fs.dtFieldWrap}
          fieldStyle={fs.rowField}
          valueStyle={fs.dtValue}
          hideIcon
        />
      </GroupCard>

      {/* ── Sending invites (only when there's a mail app to choose between) ──
          Labelled by DIRECTION, not just "Invites": Profile → Invitations is the
          inbox of invites you received, and this is the mail app that invites you
          send go out through. Same word for both reads as the same thing. */}
      {mailApps.length >= 2 ? (
        <>
          <SectionHeader>Sending invites</SectionHeader>
          <InfoCard style={styles.sectionCard}>
            <ListRow
              icon="mail-outline"
              title="Email app"
              subtitle={`Invites open in: ${mailPrefLabel}`}
              onPress={() => setMailPickerOpen(true)}
            />
          </InfoCard>
          <MailAppPickerSheet
            visible={mailPickerOpen}
            onClose={() => setMailPickerOpen(false)}
            title="Send invites with"
            apps={mailApps}
            onPick={(a) => pickMailApp(a.id)}
          >
            <ListRow icon="help-circle-outline" title="Ask each time" onPress={() => pickMailApp(null)} />
          </MailAppPickerSheet>
        </>
      ) : null}

      {/* ── Delete account (always visible, Apple 5.1.1(v)) ── */}
      <Card style={[styles.sectionCard, styles.dangerCard]}>
        <SectionTitle>Delete account</SectionTitle>
        <Text style={styles.cardNote}>
          Permanently delete your account and all your data, including anything you added to your household. This can’t be
          undone.
        </Text>
        {delOpen ? (
          <View style={styles.expand}>
            {hasPassword ? (
              <Input
                label="Confirm your password"
                value={delPw}
                onChangeText={setDelPw}
                secureTextEntry
                autoCapitalize="none"
              />
            ) : null}
            {delError ? <Text style={styles.error}>{delError}</Text> : null}
            <Button
              title="Permanently delete account"
              variant="danger"
              onPress={confirmDelete}
              loading={delBusy}
              disabled={(hasPassword && !delPw) || delBusy}
            />
          </View>
        ) : (
          <Button title="Delete account" variant="danger" onPress={() => setDelOpen(true)} />
        )}
      </Card>
    </Screen>
  );
}

// A shimmering placeholder in the shape of the grouped settings form the query
// is about to seed — a section eyebrow over the tall Account card's label/value
// rows, then two shorter grouped cards. Built from the shared Skeleton pulse.
function SettingsSkeleton() {
  return (
    <View>
      <Skeleton width={72} height={12} style={styles.skelEyebrow} />
      <GroupCard style={styles.skelCard}>
        {[0, 1, 2, 3, 4].map((i) => (
          <View key={i} style={[styles.skelRow, i > 0 ? styles.skelGap : null]}>
            <Skeleton width={'32%'} height={14} />
            <Skeleton width={'44%'} height={14} />
          </View>
        ))}
      </GroupCard>
      {[0, 1].map((c) => (
        <GroupCard key={c} style={styles.skelCard}>
          {[0, 1].map((i) => (
            <View key={i} style={[styles.skelRow, i > 0 ? styles.skelGap : null]}>
              <Skeleton width={'38%'} height={14} />
              <Skeleton width={48} height={14} />
            </View>
          ))}
        </GroupCard>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  cardNote: { fontSize: 13, color: colors.textMuted, marginBottom: spacing.sm, lineHeight: 18 },
  sectionCard: { marginBottom: spacing.md },
  // Email value row inside the grouped Account card (sits above the phone
  // field): label/value on the left, Change link on the right, matching the
  // card's 14px inset. The change form reveals inline below it (emailExpand).
  emailRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 7, minHeight: 46 },
  emailHint: { fontSize: 12, color: colors.textMuted, paddingHorizontal: 14, paddingBottom: spacing.sm, lineHeight: 16 },
  emailExpand: { paddingHorizontal: 14, paddingBottom: spacing.sm },
  locateRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingHorizontal: 14, paddingBottom: spacing.sm },
  locateLabel: { fontSize: 13, color: colors.primary, fontWeight: '600' },
  cityHint: { fontSize: 12, color: colors.textMuted, paddingHorizontal: 14, paddingBottom: spacing.sm, lineHeight: 16 },
  dangerCard: { borderColor: colors.error + '55' },
  // Email row text
  secText: { flex: 1, minWidth: 0 },
  secLabel: { fontSize: 12, color: colors.textMuted },
  secValue: { fontSize: 15, color: colors.text, marginTop: 2 },
  expand: { marginTop: spacing.sm },
  error: { color: colors.error, fontSize: 13, marginBottom: spacing.sm },
  // SettingsSkeleton shapes (mirrors the recipe-import skeleton's card rows).
  skelEyebrow: { marginBottom: spacing.sm },
  skelCard: { padding: spacing.md },
  skelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  skelGap: { marginTop: spacing.md },
});
