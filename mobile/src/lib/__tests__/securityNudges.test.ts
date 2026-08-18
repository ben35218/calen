// The one-time security nudges (spec: features/notifications.md — Security
// nudges; auth-identity.md passkey adoption; guardian-recovery.md discovery).
// These pin the pure half of lib/securityNudges: the second-open floor, the
// passkey-over-guardian priority, each kind's eligibility, the prompted-once
// per-user memory, and the invitation-interruption flag. The fetching/Alert/
// navigation wiring lives in hooks/useSecurityNudges and is not under test.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  SecurityNudgeInput,
  interruptionThisLaunch,
  loadNudgeMemory,
  markNudgePrompted,
  noteInterruption,
  nudgeAlertContent,
  pickSecurityNudge,
  recordAppOpen,
  resetInterruptionForTest,
} from '../securityNudges';

// A second-open, password-only account in a two-person household with no
// guardian armed — both nudges eligible unless a field says otherwise.
const input = (over: Partial<SecurityNudgeInput> = {}): SecurityNudgeInput => ({
  opens: 2,
  prompted: [],
  enrolled: true,
  recoveryConfirmed: true,
  hasPasskey: false,
  passkeySupported: true,
  guardianArmed: false,
  otherMembers: 1,
  ...over,
});

describe('pickSecurityNudge', () => {
  it('never fires on the first app open — that run carries the recovery-code ceremony', () => {
    expect(pickSecurityNudge(input({ opens: 1 }))).toBeNull();
    expect(pickSecurityNudge(input({ opens: 0 }))).toBeNull();
    expect(pickSecurityNudge(input({ opens: 2 }))).not.toBeNull();
  });

  it('never fires for an unenrolled account', () => {
    expect(pickSecurityNudge(input({ enrolled: false }))).toBeNull();
  });

  it('passkey outranks guardian when both are eligible', () => {
    expect(pickSecurityNudge(input())).toBe('passkey');
  });

  it('passkey requires single_factor health: no passkey yet, recovery confirmed, platform support', () => {
    // Passkey-first registration (or one added later) → healthy, never nudged.
    expect(pickSecurityNudge(input({ hasPasskey: true, otherMembers: 0 }))).toBeNull();
    // Unconfirmed recovery code is the mandatory ceremony's job, not a nudge.
    expect(pickSecurityNudge(input({ recoveryConfirmed: false, otherMembers: 0 }))).toBeNull();
    // Expo Go / no PRF-capable platform — nothing to offer.
    expect(pickSecurityNudge(input({ passkeySupported: false, otherMembers: 0 }))).toBeNull();
  });

  it('falls through to guardian once the passkey nudge is satisfied or spent', () => {
    expect(pickSecurityNudge(input({ hasPasskey: true }))).toBe('guardian');
    expect(pickSecurityNudge(input({ prompted: ['passkey'] }))).toBe('guardian');
    expect(pickSecurityNudge(input({ passkeySupported: false }))).toBe('guardian');
  });

  it('guardian requires another household member and no guardian armed', () => {
    expect(pickSecurityNudge(input({ hasPasskey: true, otherMembers: 0 }))).toBeNull();
    expect(pickSecurityNudge(input({ hasPasskey: true, guardianArmed: true }))).toBeNull();
  });

  it('each kind prompts once — a prompted kind never returns', () => {
    expect(pickSecurityNudge(input({ prompted: ['passkey'], hasPasskey: false, guardianArmed: true }))).toBeNull();
    expect(pickSecurityNudge(input({ prompted: ['passkey', 'guardian'] }))).toBeNull();
  });
});

describe('nudge memory', () => {
  beforeEach(() => AsyncStorage.clear());

  it('counts opens per user', async () => {
    expect((await recordAppOpen('u1')).opens).toBe(1);
    expect((await recordAppOpen('u1')).opens).toBe(2);
    // Another account on the same device counts from zero.
    expect((await recordAppOpen('u2')).opens).toBe(1);
  });

  it('remembers prompted kinds per user, idempotently', async () => {
    await markNudgePrompted('u1', 'passkey');
    await markNudgePrompted('u1', 'passkey');
    expect((await loadNudgeMemory('u1')).prompted).toEqual(['passkey']);
    await markNudgePrompted('u1', 'guardian');
    expect((await loadNudgeMemory('u1')).prompted).toEqual(['passkey', 'guardian']);
    expect((await loadNudgeMemory('u2')).prompted).toEqual([]);
  });

  it('marking prompted preserves the open count (and vice versa)', async () => {
    await recordAppOpen('u1');
    await recordAppOpen('u1');
    await markNudgePrompted('u1', 'guardian');
    const mem = await loadNudgeMemory('u1');
    expect(mem).toEqual({ opens: 2, prompted: ['guardian'] });
  });

  it('unreadable stored state falls back to a fresh memory', async () => {
    await AsyncStorage.setItem('hc_security_nudges:u1', 'not json');
    expect(await loadNudgeMemory('u1')).toEqual({ opens: 0, prompted: [] });
    // And the next open writes a clean record over it.
    expect((await recordAppOpen('u1')).opens).toBe(1);
  });
});

describe('interruption flag (invitations outrank the nudge)', () => {
  beforeEach(() => resetInterruptionForTest());

  it('starts clear and latches once an invitation pop-up presents', () => {
    expect(interruptionThisLaunch()).toBe(false);
    noteInterruption();
    expect(interruptionThisLaunch()).toBe(true);
  });
});

describe('alert wording', () => {
  it('the passkey pitch leads with data durability, not just sign-in', () => {
    const { title, message } = nudgeAlertContent('passkey');
    expect(title).toBe('Sign In with Face ID');
    expect(message).toContain('encrypted data');
    expect(message).toContain('forget your password');
  });

  it('the guardian pitch is a capability that names no one', () => {
    const { title, message } = nudgeAlertContent('guardian');
    expect(title).toBe('Add a Recovery Guardian');
    expect(message).toContain('someone you trust');
    // Deliberately no personal name and no "just joined" framing — the newest
    // member may be exactly who the user should not hand recovery power to.
    expect(message).not.toMatch(/joined/i);
  });
});
