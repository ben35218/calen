import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Text } from '../../components/Text';
import CalenGlyph from '../../components/CalenGlyph';
import { Badge, Button, Card, CardRow, IconAvatar, Screen, SectionHeader } from '../../components/ui';
import { ADDON_CALENDAR_IDS, ADDON_ICONS, isFreeAddon, useOwnedAddons, type AddonId } from '../../lib/addons';
import { CALENDARS, useCalendarColors } from '../../lib/calendarPrefs';
import { ASSISTANT_NAME } from '../../config';
import { colors, spacing } from '../../theme';
import type { RootStackParamList } from '../../navigation/types';

// The full-screen Discover modal (spec: features/billing-plans.md — Discovery;
// cadence owned by notifications.md "Discovery nudge"): what the discovery
// nudge presents from the third app open. One card per UNOWNED add-on routing
// at the Add-Ons store (the purchase/claim CTAs stay there, beside the
// restore button and legal links App Review requires), plus the Calen
// brainstorm pitch routing at the assistant. With every add-on owned the
// add-on section disappears and the modal is purely the brainstorm pitch —
// the render reads the LIVE owned set, so it can never promote an owned
// add-on even if the nudge decided off a stale mirror.

// Store-facing one-liners; the store's own cards keep the server catalog copy.
const PITCHES: Record<AddonId, string> = {
  recipes: 'Plan meals, import recipes, and build grocery lists automatically.',
  maintenance: 'Stay ahead of home upkeep with schedules and reminders.',
  trips: 'Plan trips with itineraries, travel times, and destination weather.',
  birthdays: 'Birthdays and occasions, with e-cards Calen can send for you.',
  chores: 'Shared chore schedules the whole household can see.',
};

export default function DiscoverScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { owned, loaded } = useOwnedAddons();
  const { colors: calColors } = useCalendarColors();

  // Unloaded reads as owned (render nothing) rather than promoting blindly.
  const unowned = loaded ? ADDON_CALENDAR_IDS.filter((id) => !owned.has(id)) : [];

  // The modal is a discovery surface, not a destination — acting on it closes
  // it first, so the target screen's back gesture returns to the calendar,
  // not to a stale promotion.
  const go = <R extends keyof RootStackParamList>(route: R, params?: RootStackParamList[R]) => {
    navigation.goBack();
    navigation.navigate(route as any, params as any);
  };

  return (
    <Screen>
      <View style={styles.hero}>
        <CalenGlyph size={44} />
        <Text style={styles.heroTitle}>Do more with {ASSISTANT_NAME}</Text>
        <Text style={styles.heroSub}>
          {unowned.length
            ? 'Your calendar can plan meals, chores, trips and more — here’s what you haven’t tried yet.'
            : 'You’ve unlocked everything — let Calen help you put it to work.'}
        </Text>
      </View>

      {unowned.length ? (
        <>
          <SectionHeader style={styles.section}>Add-ons</SectionHeader>
          {unowned.map((key) => {
            const def = CALENDARS.find((c) => c.id === key);
            const accent = calColors[key] ?? colors.primary;
            return (
              <CardRow
                key={key}
                leading={<IconAvatar mdiIcon={ADDON_ICONS[key]} bg={accent} />}
                title={def?.name ?? key}
                titleRight={isFreeAddon(key) ? <Badge label="Free" color={colors.success} /> : undefined}
                subtitle={<Text style={styles.pitch}>{PITCHES[key]}</Text>}
                onPress={() => go('AddOns', { focus: key })}
              />
            );
          })}
          <Button
            title="See all add-ons"
            variant="ghost"
            onPress={() => go('AddOns')}
            style={styles.seeAll}
          />
        </>
      ) : null}

      <SectionHeader style={styles.section}>Brainstorm with {ASSISTANT_NAME}</SectionHeader>
      <Card style={styles.brainstormCard}>
        <Text style={styles.brainstormText}>
          Not sure what to put on the calendar? Ask {ASSISTANT_NAME} to brainstorm — dinner ideas
          for the week, a chore rotation that’s actually fair, what to pack for a trip, or how to
          plan the weekend.
        </Text>
        <Button title={`Chat with ${ASSISTANT_NAME}`} onPress={() => go('Assistant')} />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: {
    alignItems: 'center',
    paddingTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  heroTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
  },
  heroSub: {
    fontSize: 15,
    color: colors.textMuted,
    textAlign: 'center',
  },
  section: {
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
  },
  seeAll: {
    marginTop: spacing.xs,
  },
  // CardRow's string subtitle clips to one line; the pitch needs to wrap.
  pitch: {
    fontSize: 13,
    color: colors.textMuted,
  },
  brainstormCard: {
    gap: spacing.md,
  },
  brainstormText: {
    fontSize: 15,
    color: colors.text,
  },
});
