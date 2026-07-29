// Phone-number formatting helpers, shared by the PhoneField primitive and any
// read-only display of a saved number. Thin wrappers over libphonenumber-js so
// components never touch the library directly.
//
// Storage contract: phone fields persist canonical E.164 ("+15551234567").
// Legacy values (bare digits, or the old normalizePhone output) still parse —
// parseStored() recovers a country + a formatted national string for editing.
import {
  AsYouType,
  parsePhoneNumberFromString,
  getCountries,
  getCountryCallingCode,
  type CountryCode,
} from 'libphonenumber-js';

export type { CountryCode };

// Turn an ISO-3166 alpha-2 code into its flag emoji (regional-indicator pair).
export function flagEmoji(code: string): string {
  return code
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

// Country display names via Intl.DisplayNames when the runtime supports it
// (falls back to the raw ISO code, so the picker still works either way).
const regionNames: { of: (code: string) => string | undefined } | null = (() => {
  try {
    const dn = new (Intl as any).DisplayNames(['en'], { type: 'region' });
    return { of: (code: string) => dn.of(code) };
  } catch {
    return null;
  }
})();

function countryName(code: string): string {
  try {
    return regionNames?.of(code) || code;
  } catch {
    return code;
  }
}

export interface Country {
  code: CountryCode;
  name: string;
  callingCode: string;
}

// All supported countries, sorted by display name. Built once at module load.
export const COUNTRIES: Country[] = getCountries()
  .map((code) => ({ code, name: countryName(code), callingCode: getCountryCallingCode(code) }))
  .sort((a, b) => a.name.localeCompare(b.name));

// Best-effort device region for the default country of a new entry. Derived
// from the resolved locale (e.g. "en-US" → "US"); no native module needed.
let cachedDeviceCountry: CountryCode | null = null;
export function deviceCountry(): CountryCode {
  if (cachedDeviceCountry) return cachedDeviceCountry;
  let region = 'US';
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale || '';
    const m = /[-_]([A-Za-z]{2})\b/.exec(locale);
    const candidate = m?.[1]?.toUpperCase();
    if (candidate && (getCountries() as string[]).includes(candidate)) region = candidate;
  } catch {
    // Fall back to US on any Intl inconsistency.
  }
  cachedDeviceCountry = region as CountryCode;
  return cachedDeviceCountry;
}

// Live "as you type" national formatting (e.g. "5551234567" → "(555) 123-4567").
// Non-digit characters in `input` are ignored, so re-running it on the current
// display string on every keystroke is safe.
export function formatAsYouType(input: string, country: CountryCode): string {
  return new AsYouType(country).input(input);
}

// Canonical E.164 for storage. Falls back to "+<callingCode><digits>" for
// still-partial input so a half-typed number is never silently dropped.
export function toE164(input: string, country: CountryCode): string {
  const digits = input.replace(/\D/g, '');
  if (!digits) return '';
  try {
    const pn = parsePhoneNumberFromString(input, country);
    if (pn?.number) return pn.number;
  } catch {
    // Not yet a complete number — fall through to the manual assembly below.
  }
  try {
    return `+${getCountryCallingCode(country)}${digits}`;
  } catch {
    return digits;
  }
}

// Recover a country + a formatted national string from a stored value, for
// seeding the editor. Handles E.164 ("+1…") and bare-digit legacy values.
export function parseStored(
  value: string | undefined | null,
  fallback: CountryCode,
): { country: CountryCode; national: string } {
  const v = (value || '').trim();
  if (!v) return { country: fallback, national: '' };
  let pn;
  try {
    pn = v.startsWith('+') ? parsePhoneNumberFromString(v) : parsePhoneNumberFromString(v, fallback);
  } catch {
    pn = undefined;
  }
  // A shared calling code (e.g. +1 across the NANP) can't be resolved to a single
  // country from the number alone with the default metadata, so `pn.country` is
  // often undefined. Prefer the fallback when its calling code matches (the usual
  // "editing my own +1 number" case), else pick any country on that code.
  let country = pn?.country as CountryCode | undefined;
  if (!country && pn?.countryCallingCode) {
    const cc = pn.countryCallingCode;
    country =
      COUNTRIES.find((c) => c.code === fallback)?.callingCode === cc
        ? fallback
        : (COUNTRIES.find((c) => c.callingCode === cc)?.code as CountryCode | undefined);
  }
  country = country || fallback;
  const nationalDigits = pn?.nationalNumber || v.replace(/\D/g, '');
  return { country, national: new AsYouType(country).input(String(nationalDigits)) };
}

// --- Picker-free entry (national-default smart input) --------------------------
// For a plain phone <TextInput> with no country selector: the user types a local
// number normally, or types a leading "+<country code>" for an international one.
// Same E.164 storage contract as the picker-based field.

// As-you-type formatting for the picker-free field. A leading "+" means the user
// is entering an international number, so let AsYouType infer the country from the
// digits; otherwise format as a national number for the device's region.
export function formatAsTyped(input: string): string {
  const raw = input ?? '';
  return raw.trimStart().startsWith('+')
    ? new AsYouType().input(raw)
    : new AsYouType(deviceCountry()).input(raw);
}

// Canonical E.164 from picker-free input. "+"-prefixed parses as international;
// otherwise parse against the device country (which supplies the calling code).
// Falls back to best-effort assembly so partial input is never silently dropped.
export function toE164FromTyped(input: string): string {
  const raw = (input ?? '').trim();
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  try {
    const pn = raw.startsWith('+')
      ? parsePhoneNumberFromString(raw)
      : parsePhoneNumberFromString(raw, deviceCountry());
    if (pn?.number) return pn.number;
  } catch {
    // Not yet a complete number — fall through to manual assembly.
  }
  if (raw.startsWith('+')) return `+${digits}`;
  try {
    return `+${getCountryCallingCode(deviceCountry())}${digits}`;
  } catch {
    return digits;
  }
}

// Seed the picker-free editor from a stored value: national form for a local
// number (no visible country code), international "+CC …" for a foreign one — the
// same rule as formatDisplay, produced as an editable string.
export function seedTyped(value: string | undefined | null): string {
  return formatDisplay(value);
}

// Pretty read-only formatting for a saved number. National form when it belongs
// to the device's country, international ("+44 …") otherwise. Returns the raw
// value unchanged if it can't be parsed.
export function formatDisplay(value: string | undefined | null): string {
  const v = (value || '').trim();
  if (!v) return '';
  try {
    const pn = v.startsWith('+') ? parsePhoneNumberFromString(v) : parsePhoneNumberFromString(v, deviceCountry());
    if (pn) return pn.country === deviceCountry() ? pn.formatNational() : pn.formatInternational();
  } catch {
    // Unparseable — show it as stored.
  }
  return v;
}
