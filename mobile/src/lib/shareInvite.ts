import { Linking, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { normalizePhone } from './invitees';
import { toE164FromTyped } from './phone';
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
//
// A phone recipient is emitted in the SAME canonical E.164 the Account screen's
// PhoneField persists (`toE164FromTyped`, device-country calling code applied
// when none is typed) — so a phone invite resolves to the recipient's account
// regardless of how the number was typed. `normalizePhone` (loose: just `+` and
// digits) would leave a locally-typed number without its country code, so a
// stored `+15551234567` never matched a typed `555-123-4567`; canonicalizing
// closes that gap. `normalizePhone` still gates plausibility (length) before we
// canonicalize.
export function classifyRecipient(raw: string): Recipient | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.includes('@')) return EMAIL_RE.test(s.toLowerCase()) ? { email: s.toLowerCase() } : null;
  if (normalizePhone(s)) return { phone: toE164FromTyped(s) };
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

// A composable email: what goes in the subject and body fields, whatever app
// composes it. Callers pass either a prebuilt EmailContent (event invites — the
// body carries the event snapshot + .ics link) or a plain `what` string that
// resolveEmailContent expands into the standard sharing-invite message.
export type EmailContent = { subject: string; body: string };

// The invite email's content, shared by every compose path (any mail app, and
// the copy-to-clipboard fallback), so the message is identical regardless of
// how it leaves the device.
export function inviteEmailContent(what: string): EmailContent {
  return {
    subject: 'Join me on Calen',
    body: `I invited you to ${what} on Calen. Get the app and open your invitations to accept: ${WEB_URL}`,
  };
}

export function resolveEmailContent(content: string | EmailContent): EmailContent {
  return typeof content === 'string' ? inviteEmailContent(content) : content;
}

// The mail apps the invite flow knows how to open with a prefilled composer.
// `detect` is the scheme probed with canOpenURL (each must be listed in
// app.json → ios.infoPlist.LSApplicationQueriesSchemes or iOS reports it
// unavailable); `compose` builds the app's own compose deep link so the
// recipient/subject/body prefill survives, which a generic share sheet can't
// do (share extensions accept no To: address). Apple Mail is detected by its
// message:// scheme but composed via mailto:, the only composer it exposes.
export type MailAppId = 'apple-mail' | 'gmail' | 'outlook' | 'spark' | 'yahoo' | 'proton' | 'fastmail';

export type MailApp = {
  id: MailAppId;
  label: string;
  detect: string;
  // Picker-row glyph: an Ionicons name or an mdi- name (exactly one is set).
  icon?: string;
  mdiIcon?: string;
  compose: (to: string, subject: string, body: string) => string;
};

const enc = encodeURIComponent;

export const MAIL_APPS: MailApp[] = [
  {
    id: 'apple-mail',
    label: 'Mail',
    detect: 'message://',
    icon: 'mail',
    compose: (to, s, b) => `mailto:${to}?subject=${enc(s)}&body=${enc(b)}`,
  },
  {
    id: 'gmail',
    label: 'Gmail',
    detect: 'googlegmail://',
    mdiIcon: 'gmail',
    compose: (to, s, b) => `googlegmail://co?to=${to}&subject=${enc(s)}&body=${enc(b)}`,
  },
  {
    id: 'outlook',
    label: 'Outlook',
    detect: 'ms-outlook://',
    mdiIcon: 'microsoft-outlook',
    compose: (to, s, b) => `ms-outlook://compose?to=${to}&subject=${enc(s)}&body=${enc(b)}`,
  },
  {
    id: 'spark',
    label: 'Spark',
    detect: 'readdle-spark://',
    mdiIcon: 'email-fast-outline',
    compose: (to, s, b) => `readdle-spark://compose?recipient=${to}&subject=${enc(s)}&body=${enc(b)}`,
  },
  {
    id: 'yahoo',
    label: 'Yahoo Mail',
    detect: 'ymail://',
    mdiIcon: 'yahoo',
    compose: (to, s, b) => `ymail://mail/compose?to=${to}&subject=${enc(s)}&body=${enc(b)}`,
  },
  {
    id: 'proton',
    label: 'Proton Mail',
    detect: 'protonmail://',
    mdiIcon: 'email-lock',
    compose: (to, s, b) => `protonmail://mailto:${to}?subject=${enc(s)}&body=${enc(b)}`,
  },
  {
    id: 'fastmail',
    label: 'Fastmail',
    detect: 'fastmail://',
    mdiIcon: 'email-outline',
    compose: (to, s, b) => `fastmail://mail/compose?to=${to}&subject=${enc(s)}&body=${enc(b)}`,
  },
];

// Which of the known mail apps are installed on this device. iOS only: Android
// has no per-app compose schemes worth probing — there, a plain mailto: already
// surfaces the OS app chooser when several mail apps are installed — so an
// empty list sends callers down the mailto: path.
export async function detectMailApps(): Promise<MailApp[]> {
  if (Platform.OS !== 'ios') return [];
  const hits = await Promise.all(
    MAIL_APPS.map(async (a) => ((await Linking.canOpenURL(a.detect).catch(() => false)) ? a : null)),
  );
  return hits.filter((a): a is MailApp => a != null);
}

// The user's remembered invite mail app (device-local, like other prefs).
// Remembered silently on the first pick from the chooser sheet; changed (or
// cleared back to ask-each-time) from Profile → Account.
const MAIL_APP_KEY = 'hc_invite_mail_app';

export async function getPreferredMailApp(): Promise<MailAppId | null> {
  const raw = await AsyncStorage.getItem(MAIL_APP_KEY).catch(() => null);
  return MAIL_APPS.some((a) => a.id === raw) ? (raw as MailAppId) : null;
}

export async function setPreferredMailApp(id: MailAppId | null): Promise<void> {
  if (id) await AsyncStorage.setItem(MAIL_APP_KEY, id).catch(() => {});
  else await AsyncStorage.removeItem(MAIL_APP_KEY).catch(() => {});
}

// Open `app`'s composer prefilled with the invite content, addressed to the
// invitee. Falls back to the error message the callers already surface when
// the app turns out not to be openable after all.
export async function composeShareEmailWith(app: MailApp, email: string, content: string | EmailContent): Promise<void> {
  const { subject, body } = resolveEmailContent(content);
  const url = app.compose(email.trim(), subject, body);
  const canOpen = await Linking.canOpenURL(url).catch(() => false);
  if (!canOpen) throw new Error('Email is not available on this device');
  await Linking.openURL(url);
}

// Open the device mail composer prefilled with an invite to `what`, addressed to
// the invitee. The inviter sends it themselves, from their own account — better
// deliverability than transactional mail, and the server never touches the
// address. Uses the mailto: scheme (no native module, works on every build),
// mirroring composeShareSms — which means it lands in the user's DEFAULT mail
// app (settable in iOS Settings since iOS 14). Screens should prefer
// useEmailComposer (components/EmailAppSheet), which routes through the
// installed-mail-app chooser and only falls back here when there's nothing to
// choose between. Resolves when the composer closes.
export async function composeShareEmail(email: string, content: string | EmailContent): Promise<void> {
  const { subject, body } = resolveEmailContent(content);
  const url = `mailto:${email.trim()}?subject=${enc(subject)}&body=${enc(body)}`;
  const canOpen = await Linking.canOpenURL(url).catch(() => false);
  if (!canOpen) throw new Error('Email is not available on this device');
  await Linking.openURL(url);
}
