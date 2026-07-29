// Best-effort country + province/state of the household's home, resolved from
// the saved home address (decrypted client-side for an E2EE household) through
// the keyless geocoders in shared/weather — the address never touches our
// server. Powers preselecting regional holidays; a wrong guess is one tap to
// fix on the Holidays screen, so this stays silent on any failure.

import { regionForAddress } from '@household/weather';
import { settingsApi } from '../api';
import { getHDK, openRecord } from './e2ee';
import { COUNTRIES, REGIONS, CountryCode } from './holidays';

export interface HomeRegion {
  country: CountryCode;
  // A REGIONS[country] name (e.g. "Ontario"), when the geocoder's subdivision
  // matched one; undefined otherwise.
  region?: string;
}

// Match a geocoder subdivision to the holiday REGIONS entry, tolerating the
// "&" / "and" split ("Newfoundland and Labrador" → "Newfoundland & Labrador").
const norm = (s: string) => s.toLowerCase().replace(/\s*&\s*/g, ' and ').replace(/\s+/g, ' ').trim();
export function matchRegionName(country: CountryCode, state?: string | null): string | undefined {
  if (!state) return undefined;
  return (REGIONS[country] ?? []).find((r) => norm(r.name) === norm(state))?.name;
}

// The saved home address: the sealed blob when decryptable, else the plaintext
// column (pre-drop households). Null when unset/unreachable.
async function resolveHomeAddress(): Promise<string | null> {
  try {
    const { data: s } = await settingsApi.get();
    let address = s.homeAddress || '';
    if (s.enc && s.householdId && getHDK()) {
      try {
        const dec: any = await openRecord('Household', {
          _id: String(s.householdId), keyVersion: s.keyVersion, enc: s.enc,
        } as any);
        if (dec.homeAddress) address = dec.homeAddress;
      } catch { /* locked / wrong key */ }
    }
    return address || null;
  } catch {
    return null;
  }
}

// Detect the home country + region. Pass `address` when the caller already
// holds it (e.g. it was just saved) to skip the settings fetch. Never throws.
export async function detectHomeRegion(address?: string): Promise<HomeRegion | null> {
  try {
    const addr = address ?? (await resolveHomeAddress());
    if (!addr) return null;
    const geo = await regionForAddress(addr);
    if (!geo?.countryCode || !COUNTRIES.some((c) => c.code === geo.countryCode)) return null;
    const country = geo.countryCode as CountryCode;
    return { country, region: matchRegionName(country, geo.state) };
  } catch {
    return null;
  }
}
