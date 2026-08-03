// Best-effort coarse "home area" label (city + region/country, e.g. "Ottawa,
// Ontario, Canada") resolved from the saved home address through the keyless
// geocoders in shared/weather — the address never touches our server. This is
// the one geographic value the calendar assistant sees; it grounds local
// suggestions in the household's actual area instead of the timezone, without
// exposing the street address. Mirrors lib/homeRegion. Never throws.

import { cityForAddress } from '@household/weather';

// Detect the coarse home-area label for an address. Pass `address` (the caller
// already holds it — e.g. it was just picked). Returns null on any failure.
export async function detectHomeCity(address?: string | null): Promise<string | null> {
  const addr = (address ?? '').trim();
  if (!addr) return null;
  try {
    return await cityForAddress(addr);
  } catch {
    return null;
  }
}

// Whether setting the home address should auto-derive the home area. Setting an
// address (picking a suggestion, filling from GPS, or typing one and leaving the
// field) fills the area exactly as the "Fill from home address" button would —
// but only when the address really changed from the one the current area came
// from, so an idle focus/blur or re-picking the same place never re-geocodes or
// clobbers a hand-set area.
export function shouldDeriveHomeCity(
  address?: string | null,
  derivedFrom?: string | null,
): boolean {
  const addr = (address ?? '').trim();
  return !!addr && addr !== (derivedFrom ?? '').trim();
}
