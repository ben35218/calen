import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Alert, ActivityIndicator, TouchableOpacity,
  Switch, Platform, Share,
} from 'react-native';
import { useNavigation, useFocusEffect, useRoute, RouteProp } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as DocumentPicker from 'expo-document-picker';
import { Ionicons } from '@expo/vector-icons';
import { authApi, householdApi, keysApi, DeviceSession } from '../../api';
import { useAuth } from '../../store/auth';
import {
  isUnlocked, ensureHouseholdKey, unlockWithPassword, unlockWithPasskey,
  unlockWithRecoveryCode, addPasskeyFactor, hasPasskeyFactor, rewrapForNewPassword,
  reauthWithBiometric, rekeyIdentity, hasSessionPassword,
} from '../../lib/e2ee';
import { isDeviceKeyEnabled } from '../../lib/deviceKey';
import { passkeysSupported } from '../../lib/passkeys';
import { useRecoveryHealth } from '../../hooks/useRecoveryHealth';
import { usePrivacyPrefs } from '../../lib/privacyPrefs';
import { exportEncryptedBackup, importEncryptedBackup } from '../../lib/exportData';
import {
  Input, Screen, Card, Button, SectionTitle, SectionHeader, Badge, ListRow, Chip, Hint, SwitchRow,
  SetupCallout, ScrollToSection,
} from '../../components/ui';
import { GroupCard, CardDivider } from '../../components/formStyles';
import { colors, spacing } from '../../theme';

// Where the screen should land when opened. `unlock` = the locked-data prompt
// (auto-presents Face ID); `recovery` = jump the user's attention to recovery
// methods. Replaces the old AccountScreen `{ section: 'privacy' }` deep-link.
// 'aiPersonalInfo' = a Calen "Turn on personal info" setup chip — scroll to the
// AI card and call out the personal/contact-info toggle.
type Focus = 'unlock' | 'recovery' | 'aiPersonalInfo';
type KeyStatus = 'locked' | 'ready' | 'pending' | null;

// The dedicated Privacy & security screen. Split out of AccountScreen so the "how
// protected am I / how do I get back in" story lives in one place: the
// encryption status hero (+ unlock UI), a Recovery methods roll-up that shows
// every way back into the encrypted data and which ones are set up, devices,
// and the remaining data controls (app lock, screen security, transparency,
// encrypted backup). Account keeps only identity + sign-in credentials.
export default function PrivacyDataScreen() {
  const qc = useQueryClient();
  const navigation = useNavigation();
  const route = useRoute<RouteProp<{ PrivacyData: { focus?: Focus } | undefined }, 'PrivacyData'>>();
  const focus = route.params?.focus;
  const { user, logout } = useAuth();

  const { data: household } = useQuery({
    queryKey: ['household'],
    queryFn: async () => (await householdApi.get()).data,
  });
  const active = !!household?.e2eeActive;

  // ── Unlock factors this account actually has ────────────────────────────────
  // Accounts with a usable password default to the password field (recovery
  // behind a link); passwordless accounts — and accounts whose password was just
  // reset (the E2EE password factor is stale) — lead with the recovery code.
  const hasPassword = user?.hasPassword !== false;
  const passwordStale = !!user?.e2eePasswordStale;
  const canUsePassword = hasPassword && !passwordStale;

  // ── Encryption status + unlock ──────────────────────────────────────────────
  const [keyStatus, setKeyStatus] = useState<KeyStatus>(null);
  const [unlockPw, setUnlockPw] = useState('');
  const [unlockCode, setUnlockCode] = useState('');
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [unlockError, setUnlockError] = useState('');
  const [pwToggle, setPwToggle] = useState<boolean | null>(null); // null = default
  const showPasswordUnlock = canUsePassword && (pwToggle ?? true);

  const loadKeyStatus = useCallback(async () => {
    try {
      setKeyStatus(isUnlocked() ? await ensureHouseholdKey() : 'locked');
    } catch {
      setKeyStatus(isUnlocked() ? 'ready' : 'locked'); // offline — best effort
    }
  }, []);
  useFocusEffect(useCallback(() => { loadKeyStatus(); }, [loadKeyStatus]));

  const recovery = useRecoveryHealth();

  // Guardian recovery (dual-control): the caller's own guardian status (drives a
  // Recovery methods row), plus any pending requests where the caller is someone
  // else's guardian (surfaced as a banner to approve).
  const guardianQ = useQuery({ queryKey: ['guardianStatus'], queryFn: async () => (await keysApi.guardianStatus()).data });
  const guardianReqQ = useQuery({
    queryKey: ['guardianRequests'],
    queryFn: async () => (await keysApi.guardianRequests()).data.requests,
    refetchInterval: 15000,
  });

  async function afterUnlock() {
    setUnlockPw('');
    setUnlockCode('');
    setPwToggle(null);
    setUnlockError('');
    await loadKeyStatus();
    qc.invalidateQueries(); // sealed records can decrypt now — repaint everything
  }

  async function unlockWithFaceId() {
    setUnlockBusy(true);
    setUnlockError('');
    try {
      if (await unlockWithPasskey()) await afterUnlock();
    } catch (e: any) {
      setUnlockError(e?.message || 'Could not unlock.');
    } finally {
      setUnlockBusy(false);
    }
  }

  async function unlockWithPw() {
    if (!unlockPw) return;
    setUnlockBusy(true);
    setUnlockError('');
    try {
      if (await unlockWithPassword(unlockPw)) await afterUnlock();
      else setUnlockError('That password didn’t unlock your key.');
    } catch (e: any) {
      setUnlockError(e?.message || 'Could not unlock.');
    } finally {
      setUnlockBusy(false);
    }
  }

  async function unlockWithCode() {
    const code = unlockCode.trim();
    if (!code) return;
    setUnlockBusy(true);
    setUnlockError('');
    try {
      if (await unlockWithRecoveryCode(code)) await afterUnlock();
      else setUnlockError('That recovery code didn’t unlock your key.');
    } catch (e: any) {
      setUnlockError(e?.message || 'Could not unlock.');
    } finally {
      setUnlockBusy(false);
    }
  }

  // ── Start fresh (every way back in is gone) ─────────────────────────────────
  // The end of the line for an account that reset its password and holds no
  // other factor: mint a NEW identity key (rekeyIdentity → POST /keys/rekey) so
  // the account can encrypt and save again. Server-side, a solo household's
  // now-unopenable records are erased and its key version reset so a fresh HDK
  // mints; with other members the data survives and the next unlocked member's
  // rotation pass re-admits the new key. A fresh one-time recovery code
  // surfaces through the app-root modal, same as registration.
  const [freshBusy, setFreshBusy] = useState(false);

  async function runStartFresh(confirmDataLoss: boolean, typedPassword: string | null) {
    setFreshBusy(true);
    setUnlockError('');
    try {
      const result = await rekeyIdentity(typedPassword, { confirmDataLoss });
      if (!result.ok) {
        // The server counted what's at stake — put the real number in front of
        // the user before the destructive confirm, in items rather than keys.
        setFreshBusy(false);
        Alert.alert(
          'This will erase your saved items',
          result.recoverableByHousehold
            ? `${result.recordCount} item${result.recordCount === 1 ? '' : 's'} saved in Calen can only be opened with the key you lost. Starting fresh won’t erase them — another household member’s device will let you back in automatically instead.`
            : `${result.recordCount} item${result.recordCount === 1 ? '' : 's'} saved in Calen can only be opened with the key you lost, and starting fresh will erase them for good.`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: result.recoverableByHousehold ? 'Continue' : 'Erase and start fresh',
              style: 'destructive',
              onPress: () => { void runStartFresh(true, typedPassword); },
            },
          ],
        );
        return;
      }
      await afterUnlock();
    } catch (e: any) {
      setUnlockError(e?.message || 'Could not start fresh.');
    } finally {
      setFreshBusy(false);
    }
  }

  function startFresh() {
    const begin = (typedPassword: string | null) => { void runStartFresh(false, typedPassword); };
    // The password is the wrapping key for the new identity (see crypto-e2ee
    // spec). The reset flow usually left this session's verified password in
    // memory; only ask when nothing is held.
    const collectPassword = () => Alert.prompt(
      'Confirm your password',
      'Your new encryption key is protected with your account password.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Continue', onPress: (pw?: string) => { if (pw) begin(pw); } },
      ],
      'secure-text',
    );
    Alert.alert(
      'Start fresh?',
      'This replaces your encryption key so you can save new data again. Anything already encrypted stays locked to the old key, and you’ll get a new recovery code to write down.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          style: 'destructive',
          onPress: () => (hasSessionPassword() ? begin(null) : collectPassword()),
        },
      ],
    );
  }

  // ── Change password ─────────────────────────────────────────────────────────
  // The everyday sign-in credential. It lives here (not in Recovery methods)
  // because changing it re-wraps the E2EE key, which needs the key unlocked —
  // exactly what this screen manages.
  const [pwOpen, setPwOpen] = useState(false);
  const [pwForm, setPwForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [pwSaving, setPwSaving] = useState(false);
  const [pwError, setPwError] = useState('');
  // Biometric-first re-auth: when this device has armed the Face ID / Touch ID
  // key cache, a fresh biometric prompt replaces re-typing the current password.
  // Otherwise we fall back to the typed current password (verified server-side).
  const [bioAvailable, setBioAvailable] = useState(false);
  useEffect(() => {
    if (!pwOpen) return;
    let alive = true;
    isDeviceKeyEnabled().then((v) => { if (alive) setBioAvailable(v); });
    return () => { alive = false; };
  }, [pwOpen]);
  const pwReady =
    pwForm.newPassword.length >= 8 &&
    pwForm.confirm.length > 0 &&
    (bioAvailable || pwForm.currentPassword.length > 0);

  async function savePassword() {
    if (pwForm.newPassword !== pwForm.confirm) {
      setPwError('New passwords do not match');
      return;
    }
    // The new password must re-wrap the E2EE key, which needs the key in hand.
    // Changing it while locked would swap the sign-in password but leave the key
    // wrapped under the OLD one — the new password then silently fails to unlock.
    if (!isUnlocked()) {
      setPwError('Unlock your encryption above so your new password can unlock your data too.');
      return;
    }
    setPwSaving(true);
    setPwError('');
    try {
      // Re-authenticate. On a biometric-armed device, a fresh device unlock
      // (fingerprint / Face ID / passcode) proves presence in place of the
      // current password (server accepts the change on the session). Otherwise
      // send the typed current password.
      let currentPassword: string | undefined;
      if (bioAvailable) {
        if (!(await reauthWithBiometric())) {
          setPwError('Confirmation is required to change your password.');
          setPwSaving(false);
          return;
        }
      } else {
        currentPassword = pwForm.currentPassword;
      }
      await authApi.updatePassword({ currentPassword, newPassword: pwForm.newPassword });
      // Re-wrap the E2EE key under the new password so it still unlocks the
      // account. Best-effort — a locked session keeps the old password factor.
      await rewrapForNewPassword(pwForm.newPassword).catch(() => {});
      setPwOpen(false);
      setPwForm({ currentPassword: '', newPassword: '', confirm: '' });
      Alert.alert('Updated', 'Password updated.');
    } catch (e: any) {
      setPwError(e?.response?.data?.error || 'Failed to update password');
    } finally {
      setPwSaving(false);
    }
  }

  // ── Passkey factor ──────────────────────────────────────────────────────────
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const passkeyQ = useQuery({
    queryKey: ['passkeyFactor'],
    queryFn: hasPasskeyFactor,
    enabled: passkeysSupported(),
  });

  async function addPasskey() {
    setPasskeyBusy(true);
    try {
      const ok = await addPasskeyFactor();
      if (ok) {
        qc.invalidateQueries({ queryKey: ['passkeyFactor'] });
        recovery.refresh();
        Alert.alert('Passkey added', 'Face ID / Touch ID can now sign you in and unlock your encrypted data on this device.');
      }
    } catch (e: any) {
      Alert.alert('Could not add passkey', e?.message || 'Please try again.');
    } finally {
      setPasskeyBusy(false);
    }
  }

  // Arriving locked via the "Unlock now" prompt, auto-present Face ID once — but
  // ONLY when a passkey is actually enrolled. (If none is, the recovery code is
  // the way in.)
  const autoFaceIdTried = useRef(false);
  useEffect(() => {
    if (
      focus === 'unlock' && keyStatus === 'locked' &&
      passkeysSupported() && passkeyQ.data && !unlockBusy && !autoFaceIdTried.current
    ) {
      autoFaceIdTried.current = true;
      unlockWithFaceId();
    }
  }, [focus, keyStatus, passkeyQ.data]); // eslint-disable-line react-hooks/exhaustive-deps


  // ── Devices (F2) + pending held reset (F1) ──────────────────────────────────
  const sessionsQ = useQuery({
    queryKey: ['deviceSessions'],
    queryFn: async () => (await authApi.sessions()).data,
  });
  const [cancelingReset, setCancelingReset] = useState(false);

  function revokeDevice(s: DeviceSession) {
    Alert.alert(
      s.current ? 'Sign out this device?' : `Remove ${s.deviceName}?`,
      s.current
        ? 'You will be signed out here.'
        : 'That device will be signed out the next time it talks to the server. Anything already on it stays until its app data is cleared.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: s.current ? 'Sign out' : 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await authApi.revokeSession(s._id);
              if (s.current) await logout();
              else await sessionsQ.refetch();
            } catch (e: any) {
              Alert.alert('Could not remove device', e?.response?.data?.error || 'Please try again.');
            }
          },
        },
      ],
    );
  }

  async function cancelPendingReset() {
    setCancelingReset(true);
    try {
      await authApi.cancelReset();
      await sessionsQ.refetch();
      Alert.alert('Reset canceled', 'The pending password reset has been canceled. Consider reviewing your devices below and your email account’s security.');
    } catch (e: any) {
      Alert.alert('Could not cancel', e?.response?.data?.error || 'Please try again.');
    } finally {
      setCancelingReset(false);
    }
  }

  // ── Data controls (app lock, screen security) ───────────────────────────────
  const { prefs, set: setPref } = usePrivacyPrefs();
  const [transparencyOpen, setTransparencyOpen] = useState(false);

  // ── Encrypted backup ────────────────────────────────────────────────────────
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);

  function exportBackup() {
    if (Platform.OS !== 'ios') {
      Alert.alert('Encrypted backup', 'Exporting a backup is available on iOS for now.');
      return;
    }
    Alert.prompt(
      'Encrypted backup',
      'Choose a passphrase to protect this backup. You’ll need it to restore — we can’t recover it for you.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Export',
          onPress: async (passphrase?: string) => {
            if (!passphrase || passphrase.length < 8) {
              Alert.alert('Passphrase too short', 'Use at least 8 characters.');
              return;
            }
            setExporting(true);
            try {
              const uri = await exportEncryptedBackup(passphrase);
              if (!uri) { Alert.alert('Nothing to export', 'There’s no data on this device yet.'); return; }
              await Share.share({ url: uri });
            } catch (e: any) {
              Alert.alert('Export failed', e?.message || 'Please try again.');
            } finally {
              setExporting(false);
            }
          },
        },
      ],
      'secure-text',
    );
  }

  async function importBackup() {
    if (Platform.OS !== 'ios') {
      Alert.alert('Encrypted backup', 'Restoring a backup is available on iOS for now.');
      return;
    }
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (result.canceled) return;
    const uri = result.assets[0].uri;
    Alert.prompt(
      'Restore backup',
      'Enter the passphrase this backup was protected with.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Restore',
          onPress: async (passphrase?: string) => {
            if (!passphrase) return;
            setImporting(true);
            try {
              const { total } = await importEncryptedBackup(uri, passphrase);
              Alert.alert('Backup restored', `${total} record${total === 1 ? '' : 's'} imported to this device.`);
            } catch (e: any) {
              Alert.alert('Restore failed', e?.message || 'Please try again.');
            } finally {
              setImporting(false);
            }
          },
        },
      ],
      'secure-text',
    );
  }

  // ── Encryption status hero ───────────────────────────────────────────────────
  const hero =
    keyStatus === 'locked'
      ? {
          icon: 'lock-closed' as const,
          color: colors.warning,
          title: 'Locked on this device',
          detail: 'Unlock to read your encrypted data here. It stays protected in the meantime.',
        }
      : keyStatus === 'pending'
        ? {
            icon: 'time-outline' as const,
            color: colors.warning,
            title: 'Waiting for household access',
            detail: 'A household member needs to approve this device before it can read shared data.',
          }
        : {
            icon: 'shield-checkmark' as const,
            color: colors.success,
            title: active ? 'End-to-end encrypted cloud' : 'Encrypted cloud',
            detail: active
              ? 'Only your household can read your data — not even we can. This device is unlocked.'
              : 'Everything you save is encrypted with your household’s key, and this device is unlocked.',
          };

  // ── Recovery-methods roll-up ─────────────────────────────────────────────────
  // The "which ways back in have I set up" summary. These are the NON-password
  // recovery factors — the ways back in if you lose or reset your password (a
  // reset password can no longer decrypt, so it isn't a backstop). The password
  // is excluded (an everyday unlock, not a backstop). Recovery code leads — the
  // default backstop every account gets — then passkey and the household guardian
  // (both durable, member-/device-independent stored factors).
  const passkeyApplies = passkeysSupported();
  const methods: { key: string; on: boolean }[] = [
    { key: 'recovery', on: recovery.recoveryConfirmed },
    ...(passkeyApplies ? [{ key: 'passkey', on: !!passkeyQ.data }] : []),
    { key: 'guardian', on: !!guardianQ.data?.armed },
  ];
  const activeCount = methods.filter((m) => m.on).length;

  const unlocked = keyStatus === 'ready';

  return (
    <Screen>
      {/* Encryption status. When unlocked (the common case) this is a slim trust
          line, not a card — the full "how protected am I" detail lives in the
          Recovery methods intro and the transparency card below. The heavy card
          appears only when it's actionable: locked (holds the unlock UI) or
          pending (household approval). */}
      {keyStatus === 'ready' ? (
        <View style={styles.encLine}>
          <Ionicons name="shield-checkmark" size={16} color={colors.success} />
          <Text style={styles.encLineText}>End-to-end encrypted · unlocked on this device</Text>
        </View>
      ) : (
      <Card style={[styles.hero, { borderColor: hero.color }]}>
        <View style={styles.rowCenter}>
          {keyStatus === null
            ? <ActivityIndicator size="small" color={colors.primary} />
            : <Ionicons name={hero.icon} size={24} color={hero.color} />}
          <Text style={[styles.heroTitle, { color: hero.color }]}>
            {keyStatus === null ? 'Checking…' : hero.title}
          </Text>
        </View>
        {keyStatus !== null ? <Text style={styles.heroDetail}>{hero.detail}</Text> : null}

        {keyStatus === 'locked' ? (
          <View style={styles.unlockBox}>
            {passwordStale ? (
              <Text style={styles.unlockStaleNote}>
                You reset your password, so it can no longer unlock your encrypted data. Enter your recovery code
                to get back in{passkeysSupported() && passkeyQ.data ? ', or use Face ID' : ''}.
              </Text>
            ) : null}
            {passkeysSupported() && passkeyQ.data ? (
              <Button title="Unlock with Face ID" onPress={unlockWithFaceId} loading={unlockBusy} />
            ) : null}
            {showPasswordUnlock ? (
              <>
                <Input
                  label="Password"
                  value={unlockPw}
                  onChangeText={setUnlockPw}
                  secureTextEntry
                  returnKeyType="go"
                  onSubmitEditing={unlockWithPw}
                />
                {unlockError ? <Text style={styles.error}>{unlockError}</Text> : null}
                <Button
                  title="Unlock"
                  onPress={unlockWithPw}
                  loading={unlockBusy}
                  disabled={!unlockPw}
                />
                <Text
                  style={styles.unlockAltLink}
                  onPress={() => { setPwToggle(false); setUnlockError(''); setUnlockPw(''); }}
                >
                  Forgot your password? Use your recovery code
                </Text>
              </>
            ) : (
              <>
                <Input
                  label="Recovery code"
                  value={unlockCode}
                  onChangeText={setUnlockCode}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  returnKeyType="go"
                  onSubmitEditing={unlockWithCode}
                />
                {unlockError ? <Text style={styles.error}>{unlockError}</Text> : null}
                <Button
                  title="Unlock with recovery code"
                  onPress={unlockWithCode}
                  loading={unlockBusy}
                  disabled={!unlockCode.trim()}
                />
                {canUsePassword ? (
                  <Text
                    style={styles.unlockAltLink}
                    onPress={() => { setPwToggle(true); setUnlockError(''); setUnlockCode(''); }}
                  >
                    Use your password instead
                  </Text>
                ) : null}
              </>
            )}
            <Text
              style={styles.unlockAltLink}
              onPress={() => (navigation as any).navigate('LinkDevice', { mode: 'show' })}
            >
              Have another device? Set this one up from it
            </Text>
            {guardianQ.data?.armed ? (
              <Text
                style={styles.unlockAltLink}
                onPress={() => (navigation as any).navigate('GuardianRecovery', { mode: 'recover' })}
              >
                Lost everything? Recover with your household guardian
              </Text>
            ) : null}
            <Text
              style={[styles.unlockAltLink, styles.unlockDangerLink]}
              onPress={freshBusy ? undefined : startFresh}
            >
              {freshBusy ? 'Starting fresh…' : 'No way back in? Start fresh with a new key'}
            </Text>
          </View>
        ) : null}

        {keyStatus === 'pending' ? (
          <View style={styles.unlockBox}>
            <Button title="Check again" onPress={loadKeyStatus} />
          </View>
        ) : null}
      </Card>
      )}

      {/* Guardian approval prompt — shown when a member you're a guardian for has
          asked for help. Only actionable while unlocked (you seal with your key). */}
      {(guardianReqQ.data?.length ?? 0) > 0 ? (
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={() => (navigation as any).navigate('GuardianRecovery', { mode: 'approve' })}
        >
          <Card style={[styles.sectionCard, styles.guardianPrompt]}>
            <View style={styles.rowCenter}>
              <Ionicons name="hand-left-outline" size={20} color={colors.primary} />
              <Text style={styles.guardianPromptText}>
                {guardianReqQ.data!.length === 1
                  ? `${guardianReqQ.data![0].requesterName} asked you to help them recover their account`
                  : `${guardianReqQ.data!.length} household members asked you to help them recover`}
              </Text>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </View>
          </Card>
        </TouchableOpacity>
      ) : null}

      {/* ── Sign-in ── */}
      {/* The everyday unlock, kept ABOVE Recovery methods and deliberately OUT of
          that list: a password is how you get in day to day, not a backstop for
          when you lose it — a reset password can't even decrypt (passwordStale),
          so counting it as "recovery" would give false confidence. */}
      <SectionHeader>Sign-in</SectionHeader>
      <Card style={styles.sectionCard}>
        {hasPassword ? (
          <>
            {/* The whole row is the affordance (tap to reveal the change form) —
                matching the tappable Recovery methods rows below and the
                Transparency card, rather than a separate "Change" button. */}
            <TouchableOpacity onPress={() => { setPwOpen((o) => !o); setPwError(''); }} activeOpacity={0.7}>
              <View style={styles.mainRow}>
                <View style={styles.iconBubble}>
                  <Ionicons name="key-outline" size={18} color="#fff" />
                </View>
                <View style={styles.mainText}>
                  <Text style={styles.mainLabel}>Password</Text>
                  <Text style={styles.mainSubtitle}>
                    {!pwOpen
                      ? 'Change your account password'
                      : bioAvailable
                        ? "Set a new password — confirm it's you to save"
                        : 'Enter your current and new password'}
                  </Text>
                </View>
                <Ionicons name={pwOpen ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textMuted} />
              </View>
            </TouchableOpacity>
            {pwOpen ? (
              <View style={styles.expand}>
                {!unlocked ? (
                  <Text style={styles.unlockStaleNote}>
                    Unlock your encryption above first, so your new password can unlock your data too.
                  </Text>
                ) : null}
                {!bioAvailable ? (
                  <Input
                    label="Current password"
                    value={pwForm.currentPassword}
                    onChangeText={(v) => setPwForm((f) => ({ ...f, currentPassword: v }))}
                    secureTextEntry
                  />
                ) : null}
                <Input
                  label="New password (min 8 chars)"
                  value={pwForm.newPassword}
                  onChangeText={(v) => setPwForm((f) => ({ ...f, newPassword: v }))}
                  secureTextEntry
                />
                <Input
                  label="Confirm new password"
                  value={pwForm.confirm}
                  onChangeText={(v) => setPwForm((f) => ({ ...f, confirm: v }))}
                  secureTextEntry
                />
                {pwError ? <Text style={styles.error}>{pwError}</Text> : null}
                <Button title={bioAvailable ? "Confirm it's you" : 'Save password'} onPress={savePassword} loading={pwSaving} disabled={!pwReady || !unlocked} />
              </View>
            ) : null}
          </>
        ) : (
          <View style={styles.mainRow}>
            <View style={styles.iconBubble}>
              <Ionicons name="key-outline" size={18} color="#fff" />
            </View>
            <View style={styles.mainText}>
              <Text style={styles.mainLabel}>Password</Text>
              <Text style={styles.mainSubtitle}>Passwordless — sign in with Face ID or an email code</Text>
            </View>
          </View>
        )}
      </Card>

      {/* ── Recovery methods ── */}
      <SectionHeader>Recovery methods</SectionHeader>
      <Card style={styles.sectionCard}>
        <Text style={styles.cardNote}>
          Ways back into your encrypted data if you lose a device. Your data is end-to-end encrypted — lose every
          method and no one, including us, can recover it.
        </Text>
        <View style={styles.summaryRow}>
          <Ionicons
            name={activeCount === methods.length ? 'shield-checkmark' : 'shield-half'}
            size={18}
            color={activeCount === methods.length ? colors.success : colors.warning}
          />
          <Text style={styles.summaryText}>
            {activeCount} of {methods.length} set up
          </Text>
        </View>
      </Card>

      <GroupCard>
        <ListRow
          icon="key-outline"
          iconColor={colors.primary}
          title="Recovery code"
          subtitle="One-time code — the backstop everyone gets"
          onPress={() => (navigation as any).navigate('RecoveryCode')}
          right={<Badge label={recovery.recoveryConfirmed ? 'Saved' : 'Set up'} color={recovery.recoveryConfirmed ? colors.success : colors.warning} />}
        />
        {passkeyApplies ? (
          <>
            <CardDivider />
            <ListRow
              icon="finger-print-outline"
              iconColor={colors.primary}
              title="Face ID / passkey"
              subtitle="Unlock with a glance; syncs across your devices"
              onPress={unlocked && !passkeyQ.data ? addPasskey : undefined}
              right={
                passkeyBusy
                  ? <ActivityIndicator size="small" color={colors.primary} />
                  : <Badge label={passkeyQ.data ? 'On' : 'Add'} color={passkeyQ.data ? colors.success : colors.warning} />
              }
            />
          </>
        ) : null}
        {/* Household guardian (dual-control) — a member helps you back in, gated
            by your PIN. An access/setup row: status badge + drill-in. */}
        <CardDivider />
        <ListRow
          icon="people-circle-outline"
          iconColor={colors.primary}
          title="Household guardian"
          subtitle="A member can help you recover — only with your PIN"
          onPress={unlocked ? () => (navigation as any).navigate('GuardianRecovery', { mode: 'setup' }) : undefined}
          right={<Badge label={guardianQ.data?.armed ? 'On' : 'Set up'} color={guardianQ.data?.armed ? colors.success : colors.textMuted} />}
        />
      </GroupCard>
      {!unlocked ? (
        <Hint>Unlock your encryption above to set up or change recovery methods.</Hint>
      ) : passwordStale ? (
        <Hint>Heads up: you reset your password, so it can no longer unlock your data — a recovery method above is now your only way back in.</Hint>
      ) : null}

      {/* ── Devices ── */}
      <SectionHeader>Devices</SectionHeader>
      <Card style={styles.sectionCard}>
        {sessionsQ.data?.pendingResetHoldUntil ? (
          <>
            <View style={styles.resetHoldBanner}>
              <Ionicons name="warning" size={18} color={colors.error} style={{ marginRight: spacing.sm }} />
              <Text style={styles.resetHoldText}>
                A password reset was requested from another device. It takes effect{' '}
                {new Date(sessionsQ.data.pendingResetHoldUntil).toLocaleString()} unless you cancel it.
              </Text>
            </View>
            <Button
              title="Cancel that reset — it wasn't me"
              variant="danger"
              loading={cancelingReset}
              onPress={cancelPendingReset}
            />
          </>
        ) : null}
        {(sessionsQ.data?.sessions ?? []).map((s) => (
          <View key={s._id} style={styles.deviceRow}>
            <Ionicons
              name={s.platform === 'android' ? 'phone-portrait-outline' : 'phone-portrait'}
              size={20}
              color={s.current ? colors.primary : colors.textMuted}
              style={{ marginRight: spacing.md }}
            />
            <View style={styles.deviceText}>
              <Text style={styles.deviceName} numberOfLines={1}>
                {s.deviceName}{s.current ? '  (this device)' : ''}
              </Text>
              <Text style={styles.deviceMeta}>
                Last active {new Date(s.lastSeenAt).toLocaleDateString()}
              </Text>
            </View>
            <Button
              title={s.current ? 'Sign out' : 'Remove'}
              variant="danger"
              compact
              onPress={() => revokeDevice(s)}
            />
          </View>
        ))}
        {/* Link a new device (Signal-parity F4): hand this unlocked device's keys
            to another by scanning its QR — no recovery code needed on the new one.
            A device operation, not a durable recovery factor, so it lives here
            rather than in Recovery methods. Only offered while unlocked. */}
        {unlocked ? (
          <>
            <Hint>Set up a new phone or tablet without typing your recovery code — scan the code it shows.</Hint>
            <Button
              title="Link another device"
              onPress={() => (navigation as any).navigate('LinkDevice', { mode: 'scan' })}
            />
          </>
        ) : null}
      </Card>

      {/* ── Data controls ── */}
      <SectionHeader>Data & privacy controls</SectionHeader>

      {/* Artificial intelligence — the AI consent gate (aiEnabled, mirrored to
          the server) plus the personal/contact-info toggle (aiUsePersonalInfo).
          Lives here with the other data controls, not on the billing/Credits
          screen: these are privacy choices, not purchases. */}
      <ScrollToSection active={focus === 'aiPersonalInfo'}>
      <Card style={styles.sectionCard}>
        <SectionTitle style={styles.cardTitle}>Artificial intelligence</SectionTitle>
        {/* Arrived from a Calen "Turn on personal info" setup chip because a
            request needed it while the toggle below was off. */}
        {focus === 'aiPersonalInfo' && !(prefs.aiEnabled && prefs.aiUsePersonalInfo) ? (
          <SetupCallout icon="sparkles">Turn on “Use personal & contact info” so Calen can see your calendar and household to answer this.</SetupCallout>
        ) : null}
        <SwitchRow
          label="Use AI features"
          value={prefs.aiEnabled}
          onValueChange={(v) => setPref('aiEnabled', v)}
        />
        <Text style={styles.switchHint}>
          Powers the assistants, photo scanning, and smart suggestions. Turning it off blocks
          every AI feature — nothing leaves your device for AI processing.
        </Text>
        <View style={prefs.aiEnabled ? undefined : styles.disabled} pointerEvents={prefs.aiEnabled ? 'auto' : 'none'}>
          <SwitchRow
            label="Use personal & contact info in prompts"
            value={prefs.aiEnabled && prefs.aiUsePersonalInfo}
            onValueChange={(v) => setPref('aiUsePersonalInfo', v)}
          />
          <Text style={styles.switchHint}>
            On, the assistant sees household members and friends by name only (plus a professional’s saved
            business details), and can read your calendar — event titles, details, and trips — to answer and
            act on them. Off, it sees no contacts at all, and it can no longer read your calendar: it sees only
            whether you’re free or busy, never the events themselves, and can’t edit or cancel a specific
            event. Form assist won’t use your contacts and contact-based AI import is unavailable.
          </Text>
        </View>
      </Card>
      </ScrollToSection>

      {/* App lock (Signal-parity A4). */}
      <Card style={styles.sectionCard}>
        <SectionTitle style={styles.cardTitle}>App lock</SectionTitle>
        <Text style={styles.cardNote}>
          Require Face ID again after the app has been in the background. Protects your data if
          you hand your phone to someone while signed in.
        </Text>
        <View style={styles.appLockRow}>
          {([
            { label: 'Never', v: -1 },
            { label: 'Right away', v: 0 },
            { label: '1 min', v: 1 },
            { label: '5 min', v: 5 },
          ] as const).map((opt) => (
            <Chip
              key={opt.v}
              label={opt.label}
              selected={prefs.appLockMinutes === opt.v}
              onPress={() => setPref('appLockMinutes', opt.v)}
            />
          ))}
        </View>
      </Card>

      {/* Screen security (Signal-parity A3). */}
      <Card style={styles.sectionCard}>
        <View style={styles.mainRow}>
          <View style={styles.iconBubble}>
            <Ionicons name="eye-off-outline" size={18} color="#fff" />
          </View>
          <View style={styles.mainText}>
            <Text style={styles.mainLabel}>Screen security</Text>
            <Text style={styles.mainSubtitle}>Block screenshots & hide the app preview</Text>
          </View>
          <Switch
            value={prefs.screenSecurity}
            onValueChange={(v) => setPref('screenSecurity', v)}
            trackColor={{ true: colors.primary }}
          />
        </View>
      </Card>

      {/* Transparency note (Signal-parity E1). Source: docs/TRANSPARENCY.md. */}
      <Card style={styles.sectionCard}>
        <TouchableOpacity onPress={() => setTransparencyOpen((o) => !o)} activeOpacity={0.7}>
          <View style={styles.mainRow}>
            <View style={styles.iconBubble}>
              <Ionicons name="document-lock-outline" size={18} color="#fff" />
            </View>
            <View style={styles.mainText}>
              <Text style={styles.mainLabel}>What we can and can't see</Text>
              <Text style={styles.mainSubtitle}>Exactly what encryption covers</Text>
            </View>
            <Ionicons name={transparencyOpen ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textMuted} />
          </View>
        </TouchableOpacity>
        {transparencyOpen ? (
          <View style={styles.expand}>
            <Text style={styles.cardNote}>
              Your content — events, contacts, tasks, recipes, trips, notes, attachments, your home
              address — is end-to-end encrypted with keys we never have. No staff access, no
              backdoor: lose every unlock method and not even we can recover it.{'\n\n'}
              Our servers do see: your email and name, who is in your household, that encrypted
              records exist (and when they change), task due dates, plan & AI usage counts, and
              your signed-in devices.{'\n\n'}
              Deliberate exceptions — readable on our servers because a feature you chose needs
              it: things you share with contacts outside your household, event invitations to
              contacts without accounts, and the details Calen uses when it phones a business for
              you (never full transcripts).{'\n\n'}
              AI requests are consent-gated and per-request: your device sends only the needed
              content with database identifiers stripped, nothing is stored, and Anthropic
              doesn't train on it.
            </Text>
          </View>
        ) : null}
      </Card>

      {/* ── Your data ── */}
      {/* Encrypted backup — data portability. Its own section (not a privacy
          control): an explicit export/restore action, not a toggle. Needs the
          decrypted data (the key), so it's only shown while unlocked. */}
      {unlocked ? (
        <>
        <SectionHeader>Your data</SectionHeader>
        <Card style={styles.sectionCard}>
          <SectionTitle style={styles.cardTitle}>Encrypted backup</SectionTitle>
          <Text style={styles.cardNote}>
            Save a passphrase-protected copy of your data to a file you control. Keep the passphrase safe; without it the
            backup can’t be opened.
          </Text>
          <TouchableOpacity style={styles.exportRow} disabled={exporting} onPress={exportBackup} activeOpacity={0.7}>
            {exporting
              ? <ActivityIndicator size="small" color={colors.primary} />
              : <Ionicons name="download-outline" size={20} color={colors.primary} />}
            <Text style={styles.exportLabel}>Export encrypted backup…</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.exportRow} disabled={importing} onPress={importBackup} activeOpacity={0.7}>
            {importing
              ? <ActivityIndicator size="small" color={colors.primary} />
              : <Ionicons name="push-outline" size={20} color={colors.primary} />}
            <Text style={styles.exportLabel}>Restore from backup…</Text>
          </TouchableOpacity>
        </Card>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  cardNote: { fontSize: 13, color: colors.textMuted, marginBottom: spacing.sm, lineHeight: 18 },
  // Drop SectionTitle's top margin when it's the first child of a Card — the
  // card's own padding already spaces it, so the default margin double-stacks.
  cardTitle: { marginTop: 0 },
  switchHint: { fontSize: 12, color: colors.textMuted, marginTop: spacing.xs, marginBottom: spacing.sm, lineHeight: 16 },
  disabled: { opacity: 0.4 },
  sectionCard: { marginBottom: spacing.md },
  hero: { borderWidth: 1, marginBottom: spacing.md },
  encLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md, paddingHorizontal: spacing.xs },
  encLineText: { fontSize: 13, fontWeight: '600', color: colors.success },
  rowCenter: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  heroTitle: { flex: 1, fontSize: 16, fontWeight: '700' },
  heroDetail: { fontSize: 13, color: colors.textMuted, marginTop: spacing.sm, lineHeight: 18 },
  unlockBox: { marginTop: spacing.md, gap: spacing.sm },
  unlockStaleNote: { color: colors.warning, fontSize: 13, lineHeight: 18 },
  unlockAltLink: { color: colors.primary, fontSize: 13, fontWeight: '600', textAlign: 'center', paddingTop: spacing.xs },
  unlockDangerLink: { color: colors.error },
  error: { color: colors.error, fontSize: 13, marginBottom: spacing.sm },
  summaryRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  guardianPrompt: { borderWidth: 1, borderColor: colors.primary + '66', backgroundColor: colors.primary + '0D' },
  guardianPromptText: { flex: 1, fontSize: 14, fontWeight: '600', color: colors.text, lineHeight: 19 },
  summaryText: { fontSize: 14, fontWeight: '600', color: colors.text },
  appLockRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  deviceRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  deviceText: { flex: 1, minWidth: 0 },
  deviceName: { fontSize: 14, fontWeight: '600', color: colors.text },
  deviceMeta: { fontSize: 12, color: colors.textMuted },
  resetHoldBanner: {
    flexDirection: 'row', alignItems: 'flex-start', backgroundColor: colors.error + '14',
    borderRadius: 8, padding: spacing.sm, marginBottom: spacing.sm,
  },
  resetHoldText: { flex: 1, fontSize: 13, color: colors.text, lineHeight: 18 },
  mainRow: { flexDirection: 'row', alignItems: 'center' },
  iconBubble: {
    width: 30, height: 30, borderRadius: 8, backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center', marginRight: spacing.md,
  },
  mainText: { flex: 1, minWidth: 0, marginRight: spacing.sm },
  mainLabel: { fontSize: 16, color: colors.text, fontWeight: '600' },
  mainSubtitle: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  expand: { marginTop: spacing.sm },
  exportRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm },
  exportLabel: { fontSize: 15, color: colors.primary, fontWeight: '600' },
});
