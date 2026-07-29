import React, { useState } from 'react';
import { View, Text, StyleSheet, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { authApi } from '../../api';
import { useAuth } from '../../store/auth';
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

// Two-step reset: request an emailed 6-digit code, then set a new password.
// A successful reset signs the user straight in (the auth store swaps to the
// app navigator), so this screen only needs to handle the E2EE caveat: the
// reset can't unlock data that was wrapped under the old password.
export default function ForgotPasswordScreen() {
  const nav = useNavigation<NativeStackNavigationProp<AuthStackParamList>>();
  const { resetPassword } = useAuth();
  const [email, setEmail] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSendCode() {
    if (!email.trim()) {
      setError('Enter your account email.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await authApi.forgotPassword({ email: email.trim() });
      setCodeSent(true);
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Could not send the reset code');
    } finally {
      setLoading(false);
    }
  }

  async function handleReset() {
    setLoading(true);
    setError('');
    try {
      const e2ee = await resetPassword({ email: email.trim(), code: code.trim(), newPassword });
      if (typeof e2ee === 'object' && 'held' in e2ee) {
        // F1 hold: unknown device — the reset completes after the security
        // window (the account's devices + email were notified and can cancel).
        Alert.alert(
          'One more step',
          `Because this device hasn't signed in to that account before, the reset takes effect ${new Date(e2ee.held).toLocaleString()}. ` +
          'Come back then and request a fresh code to finish. If you have your usual device, you can reset instantly from it instead.',
          [{ text: 'OK', onPress: () => nav.goBack() }],
        );
        return;
      }
      if (e2ee === 'locked') {
        // Signed in, but the encrypted data is still wrapped under the old
        // password — point at the existing unlock paths rather than blocking.
        Alert.alert(
          'Password reset',
          'You are signed in, but your encrypted data is still locked. Unlock it with Face ID or your recovery code in Profile → Privacy & security.'
        );
      }
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Reset failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthScaffold>
        <View style={authStyles.header}>
          <Ionicons name="key" size={56} color="#fff" />
          <Text style={authStyles.title}>Reset password</Text>
          <Text style={authStyles.subtitle}>
            {codeSent
              ? `Enter the 6-digit code we emailed to ${email.trim()}`
              : "We'll email you a 6-digit reset code"}
          </Text>
        </View>

        <Input
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
          editable={!codeSent}
          {...authInputProps}
        />

        {codeSent ? (
          <>
            <Input
              label="Reset code"
              value={code}
              onChangeText={setCode}
              keyboardType="number-pad"
              autoComplete="one-time-code"
              maxLength={6}
              {...authInputProps}
            />
            <Input
              label="New password"
              value={newPassword}
              onChangeText={setNewPassword}
              secureTextEntry
              autoComplete="new-password"
              {...authInputProps}
            />
          </>
        ) : null}

        {error ? <Text style={authStyles.error}>{error}</Text> : null}

        {codeSent ? (
          <>
            <Button title="Set New Password" onPress={handleReset} loading={loading} color={AUTH_PRIMARY_BTN_COLOR} />
            <View style={styles.resend}>
              <Button title="Resend code" variant="ghost" onPress={handleSendCode} color={AUTH_GHOST_BTN_COLOR} />
            </View>
          </>
        ) : (
          <Button title="Email Me a Code" onPress={handleSendCode} loading={loading} color={AUTH_PRIMARY_BTN_COLOR} />
        )}

        <Text style={[authStyles.link, styles.link]} onPress={() => nav.goBack()}>
          Back to sign in
        </Text>
    </AuthScaffold>
  );
}

const styles = StyleSheet.create({
  resend: { marginTop: spacing.sm },
  link: { textAlign: 'center', marginTop: spacing.lg },
});
