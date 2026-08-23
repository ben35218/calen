import { TripItemType } from '../api';

// Trip booking type metadata, ported from TripDetailView TYPE_META / TYPES.
// Icons are MaterialCommunityIcons names (no mdi- prefix needed here).
export interface TripTypeMeta {
  value: TripItemType;
  label: string;
  icon: string;
  color: string;
}

export const TRIP_TYPES: TripTypeMeta[] = [
  { value: 'flight', label: 'Flight', icon: 'airplane', color: '#1565C0' },
  { value: 'hotel', label: 'Hotel', icon: 'bed', color: '#6A1B9A' },
  { value: 'car-rental', label: 'Car', icon: 'car', color: '#2E7D32' },
  { value: 'restaurant', label: 'Restaurant', icon: 'silverware-fork-knife', color: '#C62828' },
  { value: 'activity', label: 'Activity', icon: 'ticket-outline', color: '#EF6C00' },
  { value: 'transit', label: 'Transit', icon: 'train-car', color: '#00838F' },
  { value: 'other', label: 'Other', icon: 'map-marker-outline', color: '#546E7A' },
];

export function tripTypeMeta(t?: string): TripTypeMeta {
  return TRIP_TYPES.find((x) => x.value === t) || TRIP_TYPES[TRIP_TYPES.length - 1];
}

// How a booking's cost is shared across the participating households. Shared by
// the booking form (which sets it) and the booking view (which names it), so the
// two surfaces can't disagree about what a mode is called.
export const TRIP_SHARING_OPTIONS = [
  { value: 'private', label: 'Just my family' },
  { value: 'shared_separate', label: 'Shared — separate bookings' },
  { value: 'shared_one_separate', label: 'Shared — one booking, separate bills' },
  { value: 'shared_shared', label: 'Shared — one booking, one shared bill' },
];

export function tripSharingLabel(v?: string): string {
  return TRIP_SHARING_OPTIONS.find((o) => o.value === (v || 'private'))?.label ?? 'Just my family';
}
