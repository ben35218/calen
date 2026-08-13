import React, { useCallback, useLayoutEffect, useState } from 'react';
import { View } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from '../../navigation/types';
import { ASSISTANT_TABS, type AssistantId } from './assistantTabs';
import { peekResume, requestResume, surfaceToTab, surfaceTripId } from '../../lib/chatHistory';
import { useOwnedAddons, type AddonId } from '../../lib/addons';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { CenteredLoader } from '../../components/ui';
import AssistantSwitcher from '../../components/AssistantSwitcher';
import AddonLockedView from '../plan/AddonLockedView';
import CalendarAssistantScreen from '../calendar/CalendarAssistantScreen';
import ChoresAssistantScreen from '../maintenance/ChoresAssistantScreen';
import AiTaskPlanChatScreen from '../maintenance/AiTaskPlanChatScreen';
import TripPickerScreen from '../trips/TripPickerScreen';
import TripAssistantScreen from '../trips/TripAssistantScreen';
import { colors } from '../../theme';

// Unified assistant view. Calendar, Chores, Task Plan and Trips are no longer
// separate routes — they're bodies swapped in place here, so the switcher hops
// between them without a navigation transition and the header stays "Calen".
// `initial` seeds which body opens (from the surface that launched the chat).
//
// Trips is a two-step body: without a chosen trip it shows the picker; once the
// user selects (or the picker hands back) a trip, it drops into that trip's
// assistant. Switching away from Trips remembers the selection so returning
// resumes it; "Change trip" clears it back to the picker.
export default function AssistantScreen() {
  const route = useRoute<RouteProp<RootStackParamList, 'Assistant'>>();
  const [active, setActive] = useState<AssistantId>(route.params?.initial ?? 'calendar');
  const { isUnlocked, loaded: addonsLoaded } = useOwnedAddons();
  // A cross-tab resume that arrived by navigation (from a standalone surface's
  // sheet) parks a request in chatHistory; if it targets a trip, pre-select that
  // trip here so we drop straight into its assistant instead of the picker.
  const [trip, setTrip] = useState<{ id: string; name?: string } | null>(() => {
    const p = peekResume();
    const tripId = p ? surfaceTripId(p.surfaceKey) : null;
    return tripId ? { id: tripId } : null;
  });

  // Resume a chat from the Recent-chats sheet that belongs to a DIFFERENT
  // assistant than the one showing. Park the id (the target surface's own
  // useChat claims it on mount), select the trip for a trip chat, then switch
  // the active body. Same-tab resume never reaches here — the sheet loads those
  // in place.
  const resumeAcross = useCallback((surfaceKey: string, chatId: string) => {
    const tab = surfaceToTab(surfaceKey);
    if (!tab) return;
    requestResume(surfaceKey, chatId);
    if (tab === 'trips') {
      const tripId = surfaceTripId(surfaceKey);
      if (tripId) setTrip({ id: tripId });
    }
    setActive(tab);
  }, []);

  // Add-on gate: the switcher always shows all four tabs, but a tab whose
  // add-on isn't owned swaps its chat body for the same AddonLockedView the
  // feature home screens render — the switcher stays above it so the user can
  // hop straight back, and the AI can't draft records into a locked feature.
  const lockedAddon = ASSISTANT_TABS.find((t) => t.id === active)?.addon;
  if (lockedAddon && !isUnlocked(lockedAddon))
    return (
      <LockedAssistantBody
        addon={lockedAddon}
        active={active}
        loaded={addonsLoaded}
        onSelectAssistant={setActive}
      />
    );

  if (active === 'chores')
    return <ChoresAssistantScreen onSelectAssistant={setActive} onResumeChat={resumeAcross} />;
  if (active === 'maintenance')
    return <AiTaskPlanChatScreen onSelectAssistant={setActive} onResumeChat={resumeAcross} />;
  if (active === 'trips') {
    return trip ? (
      <TripAssistantScreen
        key={trip.id}
        tripId={trip.id}
        tripName={trip.name}
        onSelectAssistant={setActive}
        onResumeChat={resumeAcross}
        onChangeTrip={() => setTrip(null)}
      />
    ) : (
      <TripPickerScreen onSelectAssistant={setActive} onPickTrip={(id, name) => setTrip({ id, name })} />
    );
  }
  return (
    <CalendarAssistantScreen
      onSelectAssistant={setActive}
      onResumeChat={resumeAcross}
      focusEvent={route.params?.focusEvent}
    />
  );
}

// A locked tab's body: the switcher row (so the user can tab away) over the
// shared locked interstitial. Entitlement-cache-not-loaded spins per the
// loading rule (unknown-shape branch).
function LockedAssistantBody({
  addon,
  active,
  loaded,
  onSelectAssistant,
}: {
  addon: AddonId;
  active: AssistantId;
  loaded: boolean;
  onSelectAssistant: (id: AssistantId) => void;
}) {
  const navigation = useNavigation();
  const accent = useCalendarColors().colors[addon] ?? colors.primary;

  // No conversation here, so clear any header action a chat body left behind.
  useLayoutEffect(() => {
    navigation.setOptions({ headerRight: undefined });
  }, [navigation]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AssistantSwitcher active={active} onSelectAssistant={onSelectAssistant} />
      {loaded ? <AddonLockedView addon={addon} /> : <CenteredLoader color={accent} />}
    </View>
  );
}
