import React from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import { Text } from './Text';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import type { RootStackParamList } from '../navigation/types';
import { colors, radius, spacing } from '../theme';

// Rendered in place of an error/retry row when a request came back 402
// (CREDITS_EXHAUSTED — the prepaid credit balance is spent). Retrying is futile
// until credits are added, so the only useful action is buying a pack.
// Companion to CreditsBanner, which warns *before* the wall; this is the wall.
export default function QuotaBlockedNotice({ message }: { message?: string }) {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  return (
    <View style={styles.wrap}>
      <Ionicons name="alert-circle" size={18} color={colors.error} />
      <Text style={styles.text}>
        {message || 'You’re out of AI credits.'}
      </Text>
      <TouchableOpacity
        onPress={() => nav.navigate('BuyCredits', { reason: 'out' })}
        accessibilityRole="button"
        accessibilityLabel="Buy credits — open the credit pack sheet"
      >
        <Text style={styles.cta}>Buy credits</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.error + '55',
    backgroundColor: colors.error + '1A',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  text: { flex: 1, fontSize: 13, lineHeight: 17, color: colors.text },
  cta: { color: colors.error, fontSize: 13, fontWeight: '700', textDecorationLine: 'underline' },
});
