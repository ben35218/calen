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
