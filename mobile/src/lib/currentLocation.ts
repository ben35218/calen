// One-shot device-GPS → postal address, shared by the Account home-address
// field and the event travel-time origin. Lazy-requires expo-location so a dev
// client built before the native module was added degrades to a typed
// `unavailable` result instead of crashing on import. Nothing is sent to our
// server here — the caller stores the returned string like any typed address.

export type CurrentAddressResult =
  | { ok: true; address: string }
  | { ok: false; reason: 'unavailable' | 'denied' | 'notfound' };

function loadExpoLocation(): typeof import('expo-location') | null {
  try {
    return require('expo-location');
  } catch {
    return null;
  }
}

// GPS fix → reverse-geocoded postal string (empty → null). Caller owns permission.
async function currentAddress(ExpoLocation: typeof import('expo-location')): Promise<string | null> {
  const pos = await ExpoLocation.getCurrentPositionAsync({ accuracy: ExpoLocation.Accuracy.Balanced });
  const [g] = await ExpoLocation.reverseGeocodeAsync(pos.coords);
  const street = [g?.streetNumber, g?.street].filter(Boolean).join(' ');
  const address = [street || g?.name, g?.city, g?.region, g?.postalCode, g?.country]
    .filter(Boolean).join(', ');
  return address || null;
}

// Explicit request: prompts for foreground permission when undetermined. For the
// user-initiated "Current location" shortcut.
export async function resolveCurrentAddress(): Promise<CurrentAddressResult> {
  const ExpoLocation = loadExpoLocation();
  if (!ExpoLocation) return { ok: false, reason: 'unavailable' };
  const { status } = await ExpoLocation.requestForegroundPermissionsAsync();
  if (status !== 'granted') return { ok: false, reason: 'denied' };
  try {
    const address = await currentAddress(ExpoLocation);
    return address ? { ok: true, address } : { ok: false, reason: 'notfound' };
  } catch {
    return { ok: false, reason: 'notfound' };
  }
}

// Never prompts: resolves the current address only when foreground location has
// ALREADY been granted (the user has shared their location with the app).
// Returns null otherwise — permission not (yet) granted, module unavailable, or
// lookup failed. Used to seed a travel-time origin by default without triggering
// a permission dialog on form open.
export async function resolveCurrentAddressIfShared(): Promise<string | null> {
  const ExpoLocation = loadExpoLocation();
  if (!ExpoLocation) return null;
  const { status } = await ExpoLocation.getForegroundPermissionsAsync();
  if (status !== 'granted') return null;
  try {
    return await currentAddress(ExpoLocation);
  } catch {
    return null;
  }
}
