import React from 'react';
import { TouchableOpacity, StyleSheet } from 'react-native';
import { Text } from './Text';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { useBilling } from '../hooks/useBilling';
import type { RootStackParamList } from '../navigation/types';
import { colors, radius, spacing } from '../theme';

// A tappable heads-up rendered inside the AI assistants once the prepaid
// credit balance dips to the server's low threshold. Tapping it opens the
// focused BuyCredits sheet. Renders nothing for exempt (unlimited) admins or
// while the balance is healthy, so it's a no-op for most sessions.
//
// Important: this only *informs*. A low balance never blocks a prompt, and even
// the call that spends the last credit runs to completion server-side — the
// block only applies to the NEXT prompt after the balance hits zero. This
// banner makes the remaining credits (and the top-up path) visible before the
// wall.
export default function CreditsBanner() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { data } = useBilling();

  if (!data || data.unlimited || !data.lowBalance) return null;

  const out = data.creditBalance <= 0;
  const message = out
    ? 'You’re out of AI credits. Tap to buy a pack.'
    : `${Math.max(0, data.creditBalance).toLocaleString()} AI credits left. Tap to top up before you run out.`;

  return (
    <TouchableOpacity
      style={[styles.wrap, out ? styles.over : styles.warn]}
      onPress={() => nav.navigate('BuyCredits', { reason: out ? 'out' : 'low' })}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={message}
    >
      <Ionicons
        name={out ? 'alert-circle' : 'warning-outline'}
        size={18}
        color={out ? colors.error : colors.warning}
      />
      <Text style={[styles.text, out ? styles.textOver : styles.textWarn]}>{message}</Text>
      <Ionicons name="chevron-forward" size={16} color={out ? colors.error : colors.warning} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
  },
  warn: { backgroundColor: colors.warning + '1A', borderColor: colors.warning + '55' },
  over: { backgroundColor: colors.error + '1A', borderColor: colors.error + '55' },
  text: { flex: 1, fontSize: 13, fontWeight: '600', lineHeight: 17 },
  textWarn: { color: colors.text },
  textOver: { color: colors.error },
});
