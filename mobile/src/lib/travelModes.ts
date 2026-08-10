import type { TravelMode } from '../api';

// The transportation methods an event's travel time can be computed for.
// Values are the server/Google Routes API mode names; icons are
// MaterialCommunityIcons (matching the trip timeline's travel pills).
export const TRAVEL_MODES: { value: TravelMode; icon: string; label: string }[] = [
  { value: 'DRIVE', icon: 'car', label: 'Drive' },
  { value: 'WALK', icon: 'walk', label: 'Walk' },
  { value: 'TRANSIT', icon: 'train', label: 'Transit' },
  { value: 'BICYCLE', icon: 'bike', label: 'Bike' },
];

// Older events (and manual durations) carry no mode — they read as drive times.
export function normalizeTravelMode(mode: string | null | undefined): TravelMode {
  return (TRAVEL_MODES.some((m) => m.value === mode) ? mode : 'DRIVE') as TravelMode;
}

export function travelModeLabel(mode: TravelMode): string {
  return TRAVEL_MODES.find((m) => m.value === mode)?.label ?? 'Drive';
}
