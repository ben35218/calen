import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Button, EmptyState } from '../../components/ui';
import { useBilling } from '../../hooks/useBilling';
import { useCalendarColors } from '../../lib/calendarPrefs';
import type { AddonId } from '../../lib/addons';
import { colors, spacing } from '../../theme';
import type { RootStackParamList } from '../../navigation/types';

// The locked interstitial a feature home screen renders when its add-on isn't
// owned. Full-screen (it replaces the feature's content entirely) so every
// entry path — Calendars row, deep link, AI-assistant navigation, restored nav
// state — lands on the same purchase prompt. Not UpsellSheet: that sheet is
// hardwired to subscription-tier/token copy.
const COPY: Record<AddonId, { name: string; message: string; free?: true }> = {
  recipes: {
    name: 'Meals',
    message: 'Meal planning, recipes and your grocery schedule are a one-time add-on.',
  },
  maintenance: {
    name: 'Maintenance',
    message: 'Your home maintenance schedule is a one-time add-on.',
  },
  trips: {
    name: 'Trips',
    message: 'Trip planning with calendar overlays is a one-time add-on.',
  },
  birthdays: {
    name: 'Occasions',
    message: 'Birthdays, anniversaries, and other dates from your people — on the calendar every year, with e-cards. Included free with the app.',
    free: true,
  },
  chores: {
    name: 'Chores',
    message: 'Recurring household chores the family shares — included free with the app.',
    free: true,
  },
};

export default function AddonLockedView({ addon }: { addon: AddonId }) {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const billing = useBilling();
  const { colors: calColors } = useCalendarColors();
  const accent = calColors[addon] ?? colors.primary;
  const { name, message, free } = COPY[addon];
  const price = billing.data?.addonCatalog?.items.find((i) => i.key === addon)?.price ?? 2.99;

  return (
    <View style={styles.container}>
      <EmptyState
        icon="lock-closed-outline"
        accent={accent}
        title={free ? `${name} is a free add-on` : `${name} is an add-on`}
        message={`${message} Anything you've already added is kept and comes right back when you ${free ? 'add' : 'unlock'} it — for your whole household.`}
      >
        <View style={styles.actions}>
          <Button
            title={free ? 'Add for free' : `Unlock for $${price.toFixed(2)}`}
            color={accent}
            onPress={() => nav.navigate('AddOns', { focus: addon })}
          />
          <Button title="See all add-ons" variant="ghost" onPress={() => nav.navigate('AddOns')} />
        </View>
      </EmptyState>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  actions: { alignSelf: 'stretch', marginTop: spacing.lg, gap: spacing.sm, paddingHorizontal: spacing.lg },
});
