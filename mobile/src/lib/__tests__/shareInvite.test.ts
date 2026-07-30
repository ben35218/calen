jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
// shareInvite → invitees → e2ee → the native sodium binding, absent under jest;
// swap in the web adapter like the other lib tests do.
jest.mock('@household/crypto/adapters/native', () => require('@household/crypto/adapters/web'));

import { Linking, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  classifyRecipient,
  MAIL_APPS,
  detectMailApps,
  getPreferredMailApp,
  setPreferredMailApp,
  composeShareEmailWith,
  inviteEmailContent,
} from '../shareInvite';

describe('classifyRecipient', () => {
  it('classifies and lowercases an email', () => {
    expect(classifyRecipient(' Amy@Example.COM ')).toEqual({ email: 'amy@example.com' });
  });

  it('an @ forces the email branch — a typo’d address is rejected, not read as a phone', () => {
    expect(classifyRecipient('amy@@example.com')).toBeNull();
  });

  it('classifies a phone number', () => {
    expect(classifyRecipient('+1 (604) 555-1212')).toEqual({ phone: '+16045551212' });
  });

  it('canonicalizes a locally-typed number (no country code) to E.164 so it matches a saved account phone', () => {
    // Device country (US under jest) supplies the calling code — the same
    // canonicalization the Account PhoneField uses when persisting the number.
    expect(classifyRecipient('(604) 555-1212')).toEqual({ phone: '+16045551212' });
    expect(classifyRecipient('604-555-1212')).toEqual({ phone: '+16045551212' });
  });

  it('rejects junk', () => {
    expect(classifyRecipient('hello')).toBeNull();
    expect(classifyRecipient('')).toBeNull();
  });
});

describe('mail-app compose links', () => {
  const to = 'amy@example.com';
  const { subject, body } = inviteEmailContent('the Polk household');
  const url = (id: string) => MAIL_APPS.find((a) => a.id === id)!.compose(to, subject, body);

  it('every app link carries the raw recipient and the encoded subject + body', () => {
    for (const app of MAIL_APPS) {
      const u = app.compose(to, subject, body);
      expect(u).toContain(to);
      expect(u).toContain(encodeURIComponent(subject));
      expect(u).toContain(encodeURIComponent(body));
    }
  });

  it('uses each app’s own compose scheme', () => {
    expect(url('apple-mail')).toMatch(/^mailto:amy@example\.com\?subject=/);
    expect(url('gmail')).toMatch(/^googlegmail:\/\/co\?to=amy@example\.com&subject=/);
    expect(url('outlook')).toMatch(/^ms-outlook:\/\/compose\?to=/);
    expect(url('spark')).toMatch(/^readdle-spark:\/\/compose\?recipient=/);
    expect(url('yahoo')).toMatch(/^ymail:\/\/mail\/compose\?to=/);
    expect(url('proton')).toMatch(/^protonmail:\/\/mailto:amy@example\.com\?subject=/);
    expect(url('fastmail')).toMatch(/^fastmail:\/\/mail\/compose\?to=/);
  });
});

describe('detectMailApps', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns only the installed apps, in registry order (iOS)', async () => {
    jest
      .spyOn(Linking, 'canOpenURL')
      .mockImplementation(async (u) => u === 'message://' || u === 'googlegmail://');
    const apps = await detectMailApps();
    expect(apps.map((a) => a.id)).toEqual(['apple-mail', 'gmail']);
  });

  it('treats a canOpenURL rejection as not installed', async () => {
    jest.spyOn(Linking, 'canOpenURL').mockRejectedValue(new Error('nope'));
    expect(await detectMailApps()).toEqual([]);
  });

  it('skips detection on Android — mailto: already opens the OS chooser there', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    // canOpenURL is already a jest mock under jest-expo, so clear the call
    // history the earlier tests left on it before asserting no new probes.
    const spy = jest.spyOn(Linking, 'canOpenURL');
    spy.mockClear();
    expect(await detectMailApps()).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('preferred mail app', () => {
  beforeEach(() => AsyncStorage.clear());

  it('defaults to null (ask each time)', async () => {
    expect(await getPreferredMailApp()).toBeNull();
  });

  it('round-trips a pick and clears back to ask-each-time', async () => {
    await setPreferredMailApp('gmail');
    expect(await getPreferredMailApp()).toBe('gmail');
    await setPreferredMailApp(null);
    expect(await getPreferredMailApp()).toBeNull();
  });

  it('ignores a stored id no longer in the registry', async () => {
    await AsyncStorage.setItem('hc_invite_mail_app', 'not-a-mail-app');
    expect(await getPreferredMailApp()).toBeNull();
  });
});

describe('composeShareEmailWith', () => {
  afterEach(() => jest.restoreAllMocks());
  const gmail = MAIL_APPS.find((a) => a.id === 'gmail')!;

  it('opens the app’s compose link when openable', async () => {
    jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as any);
    await composeShareEmailWith(gmail, ' amy@example.com ', 'the Polk household');
    expect(open).toHaveBeenCalledWith(expect.stringMatching(/^googlegmail:\/\/co\?to=amy@example\.com&subject=/));
  });

  it('throws the callers’ surfaced error when the app can’t be opened', async () => {
    jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(false);
    await expect(composeShareEmailWith(gmail, 'amy@example.com', 'x')).rejects.toThrow(
      'Email is not available on this device',
    );
  });

  it('accepts prebuilt EmailContent (event invites) instead of the standard "what" message', async () => {
    jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as any);
    await composeShareEmailWith(gmail, 'amy@example.com', { subject: 'Join me for “Lake day”', body: 'ics: http://x/i.ics' });
    const url = open.mock.calls[open.mock.calls.length - 1][0] as string;
    expect(url).toContain(encodeURIComponent('Join me for “Lake day”'));
    expect(url).toContain(encodeURIComponent('ics: http://x/i.ics'));
  });
});
