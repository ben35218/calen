// Unverified read of a JWT's payload claims. The device never checks a token's
// signature (only the server can), but it does need to compare two tokens'
// lifetimes — see api/client.ts shouldAdoptRefreshedToken. Dependency-free and
// atob-free: Hermes has not always shipped atob, and a JWT payload is ASCII
// JSON apart from string values we don't read.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64UrlDecode(input: string): string | null {
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const ch of input.replace(/=+$/, '')) {
    const v = B64.indexOf(ch === '+' ? '-' : ch === '/' ? '_' : ch);
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((acc >> bits) & 0xff);
    }
  }
  return out;
}

export function jwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const json = base64UrlDecode(parts[1]);
  if (json === null) return null;
  try {
    const claims = JSON.parse(json);
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// The token's `exp` claim in seconds since the epoch, or null when the token
// doesn't decode or carries no numeric expiry.
export function tokenExpiry(token: string): number | null {
  const exp = jwtClaims(token)?.exp;
  return typeof exp === 'number' && Number.isFinite(exp) ? exp : null;
}
