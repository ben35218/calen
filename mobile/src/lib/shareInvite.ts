import { Linking, Platform } from 'react-native';
import { normalizePhone } from './invitees';
import { WEB_URL } from '../config';

// Shared "invite by email or phone" helpers for the ongoing-access share flows
// (Household, Trips, Calendars). Unlike a one-shot event invite (which carries a
// public .ics link), these grant in-app access: the recipient accepts from their
// Invitations inbox. Both channels are composed on the inviter's own device —
// email via mailto:, phone via sms: — so the server never sends the outreach nor
// handles the invitee's address. The message just nudges the person to open the
// app, where the pending invitation is waiting (resolved by their saved
// email/phone, or claimed when they sign up with it).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type Recipient = { email: string } | { phone: string };

// Classify raw input as an email or a phone number. Returns null when it's
// neither a valid email nor a plausible phone number. An '@' forces the email
// branch so a typo'd address isn't misread as a phone.
export function classifyRecipient(raw: string): Recipient | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.includes('@')) return EMAIL_RE.test(s.toLowerCase()) ? { email: s.toLowerCase() } : null;
  const phone = normalizePhone(s);
  if (phone) return { phone };
  return EMAIL_RE.test(s.toLowerCase()) ? { email: s.toLowerCase() } : null;
}

// Open the device Messages composer prefilled with an invite to `what` (e.g.
// "the Polk household", "our trip to Rome", "the School calendar") and a link to
// the app. The inviter sends it themselves, from their own number. Resolves when
// the composer closes so callers can sequence multiple texts.
export async function composeShareSms(phone: string, what: string): Promise<void> {
  const body = `I invited you to ${what} on Calen. Get the app and open your invitations to accept: ${WEB_URL}`;
  // Keep only digits and a leading + so the recipient parses cleanly (spaces,
  // dashes and parens can stop iOS from prefilling the number).
  const number = phone.replace(/[^\d+]/g, '');

  // Open the system Messages app via the sms: scheme — iOS separates the body
  // with '&', Android with '?'. This uses no native module, so it works on every
  // build (unlike expo-sms, whose native half must be compiled in).
  const url = `sms:${number}${Platform.OS === 'ios' ? '&' : '?'}body=${encodeURIComponent(body)}`;
  const canOpen = await Linking.canOpenURL(url).catch(() => false);
  if (!canOpen) throw new Error('Text messaging is not available on this device');
  await Linking.openURL(url);
}

// Open the device mail composer prefilled with an invite to `what`, addressed to
// the invitee. The inviter sends it themselves, from their own account — better
// deliverability than transactional mail, and the server never touches the
// address. Uses the mailto: scheme (no native module, works on every build),
// mirroring composeShareSms. Resolves when the composer closes.
export async function composeShareEmail(email: string, what: string): Promise<void> {
  const subject = 'Join me on Calen';
  const body = `I invited you to ${what} on Calen. Get the app and open your invitations to accept: ${WEB_URL}`;
  const url = `mailto:${email.trim()}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const canOpen = await Linking.canOpenURL(url).catch(() => false);
  if (!canOpen) throw new Error('Email is not available on this device');
  await Linking.openURL(url);
}
