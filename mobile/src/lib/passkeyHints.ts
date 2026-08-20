import AsyncStorage from '@react-native-async-storage/async-storage';

// Device-local cache of each known passkey credential's E2EE PRF salt, so the
// USERNAMELESS passkey sign-in can evaluate the PRF in the same Face ID gesture
// that signs in — one prompt, not two. A usernameless challenge can't carry
// salts (the server doesn't know who's signing in yet — auth-identity.md
// "Passkey"), and WebAuthn forbids `evalByCredential` next to an empty
// `allowCredentials`, so the assertion instead rides the LAST-USED credential's
// salt as a top-level `prf.eval`; the caller discards the output if the OS
// picker chose some other credential and falls back to the old second prompt.
//
// This cache DELIBERATELY survives sign-out (unlike the biometric device-key
// cache, which logout wipes): both halves are public metadata — the server
// hands the salt to anyone who posts the account's email to
// /auth/passkey/challenge, and neither yields anything without the passkey
// itself (Secure Enclave + Face ID). Wiping it would just re-introduce the
// double prompt on every sign-in after a sign-out.

export interface PasskeyPrfHint {
  credentialId: string; // base64url
  prfSalt: string; // base64url
}

interface HintStore {
  salts: Record<string, string>; // credentialId -> prfSalt, insertion-ordered
  lastUsed: string | null; // credentialId of the most recent unlock
}

const KEY = 'hc_passkey_prf_hints';
// A device realistically sees a handful of accounts; oldest entries fall off.
const MAX_HINTS = 8;

async function load(): Promise<HintStore> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<HintStore>) : null;
    const salts =
      parsed?.salts && typeof parsed.salts === 'object' && !Array.isArray(parsed.salts)
        ? Object.fromEntries(
            Object.entries(parsed.salts).filter(
              ([id, salt]) => typeof id === 'string' && typeof salt === 'string',
            ),
          )
        : {};
    const lastUsed = typeof parsed?.lastUsed === 'string' ? parsed.lastUsed : null;
    return { salts, lastUsed: lastUsed && salts[lastUsed] ? lastUsed : null };
  } catch {
    return { salts: {}, lastUsed: null };
  }
}

// Merge the given credential→salt pairs into the cache; `usedCredentialId`
// marks which passkey just unlocked (or signed in), so the next usernameless
// sign-in evaluates ITS salt. Merge-only on purpose: the caller usually holds
// one account's factor list, and dropping absent entries here would forget the
// device's OTHER accounts.
export async function rememberPasskeyHints(
  hints: PasskeyPrfHint[],
  usedCredentialId?: string,
): Promise<void> {
  if (!hints.length) return;
  try {
    const store = await load();
    for (const h of hints) {
      if (!h.credentialId || !h.prfSalt) continue;
      // Re-insert so recently-seen entries sort newest and survive the cap.
      delete store.salts[h.credentialId];
      store.salts[h.credentialId] = h.prfSalt;
    }
    const ids = Object.keys(store.salts);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_HINTS))) {
      if (id !== store.lastUsed) delete store.salts[id];
    }
    if (usedCredentialId && store.salts[usedCredentialId]) store.lastUsed = usedCredentialId;
    else if (!store.lastUsed || !store.salts[store.lastUsed]) {
      store.lastUsed = hints[hints.length - 1]?.credentialId ?? null;
    }
    await AsyncStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Best-effort: a failed write costs one extra Face ID prompt, not data.
  }
}

// The hint to ride along on a usernameless assertion: the last credential that
// unlocked here, else the most recently seen one. Null on a device that has
// never unlocked this rpId's data (first install) — the two-prompt fallback
// still covers that sign-in, and the unlock it ends in populates this cache.
export async function latestPasskeyHint(): Promise<PasskeyPrfHint | null> {
  const store = await load();
  const id = store.lastUsed ?? Object.keys(store.salts).pop() ?? null;
  return id && store.salts[id] ? { credentialId: id, prfSalt: store.salts[id] } : null;
}
