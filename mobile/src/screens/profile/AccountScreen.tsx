import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Alert, ActivityIndicator, TouchableOpacity, Linking,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { locationTimezone } from '@household/weather';
import { settingsApi, authApi, householdApi } from '../../api';
import { useAuth } from '../../store/auth';
import { getHDK, sealUpdate, openRecord, reauthWithBiometric } from '../../lib/e2ee';
import { isDeviceKeyEnabled } from '../../lib/deviceKey';
import { invalidatePlaceBias } from '../../lib/placeBias';
import { detectHomeRegion } from '../../lib/homeRegion';
import { autoSelectHolidayRegion } from '../../lib/calendarPrefs';
import { HOUSEHOLD_ENC } from '../../lib/encSubsets';
import { resolveCurrentAddress } from '../../lib/currentLocation';
import {
  Input, DateField, Screen, useHeaderCheckButton, Card, Button,
  SectionTitle, SectionHeader, PhoneField,
} from '../../components/ui';
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
// screen (PrivacyDataScreen) — Account stays focused on "who you are".
export default function AccountScreen() {
  const qc = useQueryClient();
  const navigation = useNavigation();
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
    firstName: '', lastName: '', phone: '', birthday: '', homeAddress: '',
  });
  const [saving, setSaving] = useState(false);
  // Gate for the discard guard's baseline: the identity form seeds from the
  // settings query (and, for E2EE households, an async home-address decrypt), so
  // we only snapshot the clean baseline once that seeding has settled.
  const [seeded, setSeeded] = useState(false);
  // The decrypted household blob (name + homeAddress — C2): spread under the
  // update at seal time so re-sealing the address never drops the sealed name.
  const decryptedHH = useRef<Record<string, unknown>>({});
  // Last-loaded address, to detect a real change at save time (which re-derives
  // the household's default timezone from the new location).
  const loadedAddress = useRef('');

  useEffect(() => {
    if (!settings) return;
    setForm({
      firstName: settings.firstName ?? '',
      lastName: settings.lastName ?? '',
      phone: settings.phone ?? '',
      birthday: settings.birthday ? String(settings.birthday).slice(0, 10) : '',
      homeAddress: settings.homeAddress ?? '',
    });
    loadedAddress.current = settings.homeAddress ?? '';
    // Decrypt the sealed home location over the plaintext (§9.1 P5); dormant
    // without an HDK. Post-drop this is the only source of the address.
    if (settings.enc && getHDK() && settings.householdId) {
      openRecord('Household', { _id: String(settings.householdId), keyVersion: settings.keyVersion, enc: settings.enc } as any)
        .then((dec: any) => {
          decryptedHH.current = { name: dec.name, homeAddress: dec.homeAddress };
          if (dec.homeAddress) {
            loadedAddress.current = dec.homeAddress;
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
        void locationTimezone(newAddress).then((tz) =>
          tz ? settingsApi.update({ householdTimezone: tz }) : null,
        ).catch(() => {});
        void detectHomeRegion(newAddress).then((h) =>
          h?.region ? autoSelectHolidayRegion(h.country, h.region) : null,
        );
      }
      qc.invalidateQueries({ queryKey: ['settings'] });
      invalidatePlaceBias();
      // Saving the identity form completes the task, so dismiss back to the
      // profile hub automatically (matching PersonFormScreen and the iOS
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
      if (res.ok) { setForm((f) => ({ ...f, homeAddress: res.address })); return; }
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

  function confirmDelete() {
    // Password accounts must type their password first; passwordless
    // (passkey/OAuth) accounts have none, so the session token is the proof.
    if (hasPassword && !delPw) return;
    Alert.alert(
      'Delete your account?',
      'This permanently deletes your account and all your data, including anything you added to your household. This cannot be undone.',
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
      <View style={fs.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <Screen>
      {/* ── Account (identity + location) ── */}
      <SectionHeader>Account</SectionHeader>
      <GroupCard>
        <Input
          value={form.firstName}
          onChangeText={set('firstName')}
          placeholder="First name"
          containerStyle={fs.headField}
          style={fs.headInput}
        />
        <CardDivider />
        <Input
          value={form.lastName}
          onChangeText={set('lastName')}
          placeholder="Last name"
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
          placeholder="Home address"
          type="address"
          containerStyle={fs.headField}
          inputStyle={fs.headInput}
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
  dangerCard: { borderColor: colors.error + '55' },
  // Email row text
  secText: { flex: 1, minWidth: 0 },
  secLabel: { fontSize: 12, color: colors.textMuted },
  secValue: { fontSize: 15, color: colors.text, marginTop: 2 },
  expand: { marginTop: spacing.sm },
  error: { color: colors.error, fontSize: 13, marginBottom: spacing.sm },
});
