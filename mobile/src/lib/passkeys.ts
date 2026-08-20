// WebAuthn passkey ceremonies (Phase 1 follow-through: the biometric unlock
// factor). A passkey's PRF extension gives us 32 authenticator-derived bytes
// that only a successful Face ID / Touch ID assertion can reproduce — that
// output is the secret that wraps the identity private key (see e2ee.ts /
// @household/crypto enrollment.addPasskey). This module is only the platform
// ceremony layer; no key material is handled here beyond the PRF output.
//
// Requirements (why this can silently no-op):
// - native module → dev-client/EAS rebuild; not available in Expo Go
// - PRF: iOS 18+ / Android with a PRF-capable credential provider
// - the RP ID domain must serve the apple-app-site-association /
//   assetlinks.json files that associate it with this app (webcredentials),
//   and app.json must list it under ios.associatedDomains.
import * as passkeys from 'react-native-passkeys';
import { loadHouseholdCrypto } from '@household/crypto/adapters/native';
import { authApi, type PasskeyChallenge } from '../api';
import { PASSKEY_RP_ID } from '../config';
import type { PasskeyPrfHint } from './passkeyHints';

export function passkeysSupported(): boolean {
  try {
    return passkeys.isSupported();
  } catch {
    return false; // Expo Go / module not linked yet
  }
}

export interface CreatedPasskey {
  credentialId: string; // base64url
  prfOutput: string | null; // base64url — null when the platform defers PRF to `get`
}

// Register a new passkey for this account and evaluate the PRF at `prfSalt`.
// The creation options (challenge, rp, user) come from the server so it can
// verify the attestation and keep the credential's public key — that's what
// makes the same passkey usable for SIGN-IN, not just E2EE unlock.
// Returns null if the user cancels the sheet.
export async function createPasskeyWithPrf(opts: {
  prfSalt: string; // base64url
}): Promise<CreatedPasskey | null> {
  const { data: options } = await authApi.passkeyRegisterOptions();
  const res = await passkeys.create({
    ...(options as any),
    extensions: { ...(options as any).extensions, prf: { eval: { first: opts.prfSalt } } },
  });
  if (!res) return null;
  await authApi.passkeyRegister(res);
  const prf = (res.clientExtensionResults as any)?.prf;
  const first = prf?.results?.first;
  return { credentialId: res.id, prfOutput: typeof first === 'string' ? first : null };
}

// Passkey SIGN-IN assertion against a server-issued challenge. Evaluates each
// credential's PRF salt in the same ceremony, so the one Face ID tap yields
// both the assertion (session) and the PRF output (E2EE unlock).
//
// A USERNAMELESS challenge carries no salts (unknown user), and WebAuthn
// forbids `evalByCredential` next to an empty allowCredentials — so pass the
// device's cached last-used hint (passkeyHints.ts) and its salt rides as a
// top-level `prf.eval` instead. That form evaluates against WHICHEVER
// credential the account picker chooses, so the output only opens the factor
// when the choice matches the hint; on any other pick it's discarded here
// (prfOutput null) and the caller falls back to its post-auth unlock path.
// Returns null on cancel.
export async function assertPasskeyForLogin(
  ch: PasskeyChallenge,
  hint?: PasskeyPrfHint | null,
): Promise<{
  response: unknown;
  credentialId: string;
  prfOutput: string | null;
} | null> {
  const withSalts = ch.allowCredentials.filter((c) => c.prfSalt);
  const res = await passkeys.get({
    challenge: ch.challenge,
    rpId: ch.rpId || PASSKEY_RP_ID,
    allowCredentials: ch.allowCredentials.map((c) => ({ id: c.id, type: 'public-key' as const })),
    userVerification: 'required',
    extensions: withSalts.length
      ? { prf: { evalByCredential: Object.fromEntries(withSalts.map((c) => [c.id, { first: c.prfSalt as string }])) } }
      : hint
        ? { prf: { eval: { first: hint.prfSalt } } }
        : undefined,
  });
  if (!res) return null;
  const prf = (res.clientExtensionResults as any)?.prf;
  const first = prf?.results?.first;
  const foreignPick = !withSalts.length && !!hint && res.id !== hint.credentialId;
  return {
    response: res,
    credentialId: res.id,
    prfOutput: typeof first === 'string' && !foreignPick ? first : null,
  };
}

// Assert with one of the given credentials and get the PRF output evaluated at
// that credential's own salt. Returns null on cancel or if PRF is unsupported.
export async function getPrfForCredentials(
  creds: { credentialId: string; prfSalt: string }[],
): Promise<{ credentialId: string; prfOutput: string } | null> {
  if (!creds.length) return null;
  const crypto = await loadHouseholdCrypto();
  const res = await passkeys.get({
    challenge: crypto.b64(crypto.randomBytes(32)),
    rpId: PASSKEY_RP_ID,
    allowCredentials: creds.map((c) => ({ id: c.credentialId, type: 'public-key' as const })),
    userVerification: 'required',
    extensions: {
      prf: { evalByCredential: Object.fromEntries(creds.map((c) => [c.credentialId, { first: c.prfSalt }])) },
    },
  });
  if (!res) return null;
  const prf = (res.clientExtensionResults as any)?.prf;
  const first = prf?.results?.first;
  return typeof first === 'string' ? { credentialId: res.id, prfOutput: first } : null;
}
