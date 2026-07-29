// The household's saved home address, decrypting the E2EE-sealed settings blob
// client-side (the address never reaches our server in plaintext for a post-drop
// household). Falls back to the plaintext column for pre-drop households. Never
// throws; returns null when unset, locked, or unreachable.

import { settingsApi } from '../api';
import { getHDK, openRecord } from './e2ee';

export async function resolveHomeAddress(): Promise<string | null> {
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
    return address.trim() || null;
  } catch {
    return null;
  }
}
