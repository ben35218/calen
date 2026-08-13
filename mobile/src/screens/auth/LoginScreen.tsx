import React, { useState } from 'react';
import { View, StyleSheet, Image } from 'react-native';
import { Text } from '../../components/Text';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useAuth } from '../../store/auth';
import { passkeysSupported } from '../../lib/passkeys';
import { Button, Input } from '../../components/ui';
import { spacing } from '../../theme';
import {
  authStyles,
  authInputProps,
  AUTH_PRIMARY_BTN_COLOR,
  AUTH_GHOST_BTN_COLOR,
} from './authStyles';
import { AuthScaffold } from './AuthScaffold';
import type { AuthStackParamList } from '../../navigation/AuthNavigator';

// Sign-in: a password (for password accounts) or a passkey (Face ID / Touch ID —
// the durable factor for passwordless accounts, and a fast unlock for either).
// Both authenticate AND unlock E2EE in one step; the recovery code is the backstop
// on the Account screen. See docs/PASSWORDLESS-E2EE-PLAN.md.
export default function LoginScreen() {
  const nav = useNavigation<NativeStackNavigationProp<AuthStackParamList>>();
  const { login, loginWithPasskey } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const hasPasskeys = passkeysSupported();

  async function handlePasswordLogin() {
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await login({ email: email.trim(), password });
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  async function handlePasskey() {
    setPasskeyLoading(true);
    setError('');
    try {
      // Usernameless when the email field is empty: the OS account picker
      // chooses the passkey and the server resolves the account. If an email was
      // typed, pass it — that path signs in AND unlocks E2EE in one assertion.
      await loginWithPasskey(email.trim() || undefined); // false = canceled, which needs no message
    } catch (e: any) {
      // A native ceremony failure (e.g. rpId not in the app's associated
      // domains) has no HTTP `.response` — surface its message instead of
      // swallowing it behind the generic string, or passkey issues are
      // undebuggable from the device.
      setError(e?.response?.data?.error || e?.message || 'Passkey sign-in failed');
    } finally {
      setPasskeyLoading(false);
    }
  }

  return (
    <AuthScaffold>
      {/* Wordmark alone — the primary "Sign in with a passkey" button below makes
          a "Sign in to your account" subtitle redundant, and dropping it (plus
          tighter spacing) keeps the Register footer above the fold on small
          screens. */}
      <View style={[authStyles.header, styles.header]}>
        <Image
          source={require('../../../assets/calen-wordmark.png')}
          style={styles.wordmark}
          resizeMode="contain"
        />
      </View>

      {/* Passwordless-first: lead with the passkey. It's usernameless — the OS
          account picker chooses, so no email is needed. The password form below
          is the fallback for accounts without a passkey (or unsupported
          devices). */}
      {hasPasskeys ? (
        <>
          <Button
            title="Sign in with a passkey"
            onPress={handlePasskey}
            loading={passkeyLoading}
            color={AUTH_PRIMARY_BTN_COLOR}
          />
          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>or use your password</Text>
            <View style={styles.dividerLine} />
          </View>
        </>
      ) : null}

      <Input
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
        autoComplete="email"
        {...authInputProps}
      />
      <Input
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="password"
        {...authInputProps}
      />

      {error ? <Text style={authStyles.error}>{error}</Text> : null}

      {/* When a passkey is the hero action above, the password sign-in is the
          secondary (ghost) path; otherwise it's the primary CTA. */}
      <Button
        title="Sign In"
        onPress={handlePasswordLogin}
        loading={loading}
        variant={hasPasskeys ? 'ghost' : 'primary'}
        color={hasPasskeys ? AUTH_GHOST_BTN_COLOR : AUTH_PRIMARY_BTN_COLOR}
      />

      {/* Hand the typed email across so the reset screen starts pre-filled. */}
      <Text
        style={[authStyles.link, styles.forgot]}
        onPress={() => nav.navigate('ForgotPassword', { email: email.trim() || undefined })}
      >
        Forgot password?
      </Text>

      <View style={authStyles.footer}>
        <Text style={authStyles.footerText}>Don't have an account? </Text>
        <Text style={authStyles.link} onPress={() => nav.navigate('Register')}>
          Register
        </Text>
      </View>
    </AuthScaffold>
  );
}

const styles = StyleSheet.create({
  // Tighter than the shared header (xl) — reclaims vertical space so the footer
  // clears the fold on small devices.
  header: { marginBottom: spacing.lg },
  wordmark: { width: 220, height: 80 },
  divider: { flexDirection: 'row', alignItems: 'center', marginVertical: spacing.md },
  dividerLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.3)' },
  dividerText: { color: 'rgba(255,255,255,0.8)', marginHorizontal: spacing.md, fontSize: 13 },
  forgot: { textAlign: 'center', marginTop: spacing.md },
});
