import { MaterialCommunityIcons } from '@expo/vector-icons';
import type { RootStackParamList } from '../../navigation/types';
import type { AddonId } from '../../lib/addons';

// The unified assistant switcher. Every top-level Calen chat surface renders the
// same icon row so the user can hop between assistants in one view.
//
// `chat` tabs swap the active body in place inside AssistantScreen. Trips is a
// chat too, but it first prompts for which trip to plan (TripPickerScreen) before
// dropping into that trip's assistant. `nav` tabs point at surfaces that aren't a
// standalone chat — Recipes is a form finder — so tapping them navigates away.

export type AssistantId = 'calendar' | 'chores' | 'maintenance' | 'trips' | 'recipes';

type TabAction =
  // `chat` tabs swap the active body in place inside the unified AssistantScreen
  // (no route). `nav` tabs open a different, non-chat surface.
  | { kind: 'chat' }
  | { kind: 'nav'; route: keyof RootStackParamList };

export interface AssistantTab {
  id: AssistantId;
  label: string;
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  // Key into useCalendarColors().colors for the selected tint; 'primary' falls
  // back to the app accent (the calendar area has no per-calendar colour).
  accentKey: 'primary' | 'chores' | 'maintenance' | 'trips' | 'recipes';
  // Add-on that must be owned before this tab's body is usable. The tab always
  // renders in the switcher — a locked tab's body is AddonLockedView, matching
  // the feature home screens (every entry path lands on the same prompt).
  addon?: AddonId;
  action: TabAction;
}

export const ASSISTANT_TABS: AssistantTab[] = [
  { id: 'calendar',    label: 'Calendar',    icon: 'calendar-month',       accentKey: 'primary',     action: { kind: 'chat' } },
  { id: 'chores',      label: 'Chores',      icon: 'broom',                accentKey: 'chores',      addon: 'chores',      action: { kind: 'chat' } },
  { id: 'maintenance', label: 'Maintenance', icon: 'wrench',               accentKey: 'maintenance', addon: 'maintenance', action: { kind: 'chat' } },
  { id: 'trips',       label: 'Trips',       icon: 'airplane',             accentKey: 'trips',       addon: 'trips',       action: { kind: 'chat' } },
];
