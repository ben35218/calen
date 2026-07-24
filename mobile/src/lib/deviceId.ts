import * as SecureStore from 'expo-secure-store';

// Stable per-install device ID (Signal-parity F2/F3). A random UUID minted on
// first launch and kept in the keychain, sent as `X-Device-Id` on every request
// so the server can key session rows by INSTALL rather than by the spoofable,
// non-unique device name ("iPhone") — one Devices row per physical install, and
// the new-device alert keys on an unguessable 128-bit value instead of a name.
// Like the name header it is a label/dedup key only, NEVER an auth factor.
const DEVICE_ID_KEY = 'hc_device_id';

let loadPromise: Promise<string> | null = null;

async function mintUuid(): Promise<string> {
  // Lazy: api/client.ts imports this module, so a static adapter import would
  // drag the native libsodium binding into every consumer (and every Jest
  // suite touching the api). Loaded only when an id is actually minted.
  const { loadHouseholdCrypto } = await import('@household/crypto/adapters/native');
  const crypto = await loadHouseholdCrypto();
  const b = crypto.randomBytes(16);
  // RFC 4122 v4 shape (version/variant bits set) so the value reads as a UUID.
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function loadOrCreate(): Promise<string> {
  try {
    const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);
    if (existing) return existing;
    const id = await mintUuid();
    await SecureStore.setItemAsync(DEVICE_ID_KEY, id);
    return id;
  } catch {
    // Keychain unavailable — fall back to a run-scoped random id (sessions
    // from this run still coalesce with each other; worst case is the legacy
    // one-row-per-sign-in behavior, never a failed request).
    return mintUuid();
  }
}

// Resolves to the same id for the life of the install (memoized; the promise
// is shared so concurrent early requests don't race the keychain).
export function getDeviceId(): Promise<string> {
  if (!loadPromise) {
    loadPromise = loadOrCreate();
    // A rejection (e.g. sodium not loaded yet) shouldn't poison the memo —
    // clear it so the next request retries.
    loadPromise.catch(() => { loadPromise = null; });
  }
  return loadPromise;
}
