import React, { useState } from 'react';
import { View, Text, StyleSheet, Alert, Image } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useAuth } from '../../store/auth';
import { passkeysSupported } from '../../lib/passkeys';
import { Button, Input } from '../../components/ui';
import { spacing } from '../../theme';
import { authStyles, authInputProps, AUTH_PRIMARY_BTN_COLOR } from './authStyles';
import { AuthScaffold } from './AuthScaffold';
import type { AuthStackParamList } from '../../navigation/AuthNavigator';

// Registration establishes the account's primary unlock factor. A passkey is the
// preferred path (no password to remember, and it silently unlocks E2EE after a
// relaunch/logout); a password is the alternative for people who want one or on
// devices without a passkey. Either way the recovery code (shown right after) is
// the backstop. See docs/PASSWORDLESS-E2EE-PLAN.md.
export default function RegisterScreen() {
  const nav = useNavigation<NativeStackNavigationProp<AuthStackParamList>>();
  const { register, registerWithPasskey } = useAuth();
  const supportsPasskey = passkeysSupported();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  // 'passkey' when the device supports it (preferred); otherwise the password
  // path is the only option.
  const [mode, setMode] = useState<'passkey' | 'password'>(supportsPasskey ? 'passkey' : 'password');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  function validName(): boolean {
    if (!firstName.trim() || !email.trim()) {
      setError('Enter your first name and email.');
      return false;
    }
    return true;
  }

  async function createWithPasskey() {
    setError('');
    if (!validName()) return;
    setLoading(true);
    try {
      await registerWithPasskey({
        email: email.trim(), firstName: firstName.trim(), lastName: lastName.trim(),
      });
    } catch (e: any) {
      // registerWithPasskey rolls the account back and throws a friendly message
      // when the passkey ceremony doesn't complete. Surface it as a popup with a
      // clear next step — the inline error is too easy to miss below the fold.
      const serverError = e?.response?.data?.error;
      Alert.alert(
        'Couldn’t finish Face ID setup',
        (serverError || e?.message || 'Face ID / passkey setup didn’t complete on this device.') +
          // TestFlight / beta builds don't ship the associated-domains entitlement
          // that passkeys need, so Face ID setup fails here every time. Say so, so
          // testers reach for the password path instead of assuming a bug.
          '\n\nOn TestFlight and beta builds, passkeys aren’t available yet — use a password for now.',
        [
          { text: 'Try again', onPress: createWithPasskey },
          { text: 'Use a password', style: 'cancel', onPress: () => { setMode('password'); setError(''); } },
        ],
      );
    } finally {
      setLoading(false);
    }
  }

  async function createWithPassword() {
    setError('');
    if (!validName()) return;
    if (password.length < 8) {
      setError('Use a password of at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      await register({ email: email.trim(), firstName: firstName.trim(), lastName: lastName.trim(), password });
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Registration failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthScaffold>
        <View style={authStyles.header}>
          <Image
            source={require('../../../assets/calen-wordmark.png')}
            style={styles.wordmark}
            resizeMode="contain"
          />
          <Text style={authStyles.subtitle}>Create your account</Text>
        </View>
        <Input label="First name" value={firstName} onChangeText={setFirstName} {...authInputProps} />
        <Input label="Last name (optional)" value={lastName} onChangeText={setLastName} {...authInputProps} />
        <Input label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" {...authInputProps} />

        {mode === 'passkey' ? (
          // ── Passkey path (preferred) ──────────────────────────────────────
          <>
            <Text style={styles.methodHint}>
              Use a passkey (Face ID / Touch ID) — no password to remember.
            </Text>
            {error ? <Text style={authStyles.error}>{error}</Text> : null}
            <Button title="Create account with a passkey" onPress={createWithPasskey} loading={loading} color={AUTH_PRIMARY_BTN_COLOR} />
            <Text
              style={[authStyles.link, styles.altLink]}
              onPress={() => { setMode('password'); setError(''); }}
            >
              Prefer a password? Use one instead
            </Text>
          </>
        ) : (
          // ── Password path ─────────────────────────────────────────────────
          <>
            <Input
              label="Password (min 8 chars)"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="new-password"
              {...authInputProps}
            />
            <Input
              label="Confirm password"
              value={confirm}
              onChangeText={setConfirm}
              secureTextEntry
              autoComplete="new-password"
              {...authInputProps}
            />
            {error ? <Text style={authStyles.error}>{error}</Text> : null}
            <Button title="Create account" onPress={createWithPassword} loading={loading} color={AUTH_PRIMARY_BTN_COLOR} />
            {supportsPasskey ? (
              <Text
                style={[authStyles.link, styles.altLink]}
                onPress={() => { setMode('passkey'); setError(''); }}
              >
                Use a passkey instead (recommended)
              </Text>
            ) : (
              <Text style={styles.methodHint}>Passkey sign-in isn’t available on this device.</Text>
            )}
          </>
        )}

        {/* Heads-up for the mandatory recovery-code gate that appears the moment
            the account is created — so it reads as expected, not an ambush. */}
        <Text style={styles.recoveryHeads}>
          Next, we’ll show a one-time recovery code. Save it — it’s the only way back
          into your encrypted data if you lose your sign-in.
        </Text>

        <View style={authStyles.footer}>
          <Text style={authStyles.footerText}>Already have an account? </Text>
          <Text style={authStyles.link} onPress={() => nav.navigate('Login')}>
            Sign in
          </Text>
        </View>
    </AuthScaffold>
  );
}

const styles = StyleSheet.create({
  wordmark: { width: 240, height: 95, marginBottom: spacing.sm },
  // White on the brand-blue auth background (matches authStyles.subtitle) — a
  // gray hint here is unreadable against the blue.
  methodHint: { color: 'rgba(255,255,255,0.8)', fontSize: 13, textAlign: 'center', marginBottom: spacing.md, lineHeight: 18 },
  altLink: { textAlign: 'center', marginTop: spacing.md },
  // Quieter than methodHint — a footnote about the recovery-code step, on the
  // brand-blue auth background.
  recoveryHeads: { color: 'rgba(255,255,255,0.7)', fontSize: 12, textAlign: 'center', marginTop: spacing.lg, lineHeight: 17 },
});
