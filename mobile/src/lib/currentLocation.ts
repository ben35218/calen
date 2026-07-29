// One-shot device-GPS → postal address, shared by the Account home-address
// field and the event travel-time origin. Lazy-requires expo-location so a dev
// client built before the native module was added degrades to a typed
// `unavailable` result instead of crashing on import. Nothing is sent to our
// server here — the caller stores the returned string like any typed address.

export type CurrentAddressResult =
  | { ok: true; address: string }
  | { ok: false; reason: 'unavailable' | 'denied' | 'notfound' };

export async function resolveCurrentAddress(): Promise<CurrentAddressResult> {
  let ExpoLocation: typeof import('expo-location');
  try {
    ExpoLocation = require('expo-location');
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  const { status } = await ExpoLocation.requestForegroundPermissionsAsync();
  if (status !== 'granted') return { ok: false, reason: 'denied' };
  try {
    const pos = await ExpoLocation.getCurrentPositionAsync({ accuracy: ExpoLocation.Accuracy.Balanced });
    const [g] = await ExpoLocation.reverseGeocodeAsync(pos.coords);
    const street = [g?.streetNumber, g?.street].filter(Boolean).join(' ');
    const address = [street || g?.name, g?.city, g?.region, g?.postalCode, g?.country]
      .filter(Boolean).join(', ');
    if (!address) return { ok: false, reason: 'notfound' };
    return { ok: true, address };
  } catch {
    return { ok: false, reason: 'notfound' };
  }
}
