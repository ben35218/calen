import AsyncStorage from '@react-native-async-storage/async-storage';

// The one-time security-posture pop-ups (spec: features/notifications.md —
// Security nudges): a passkey-adoption prompt for password-only accounts and a
// guardian-recovery discovery prompt once the household has a second member.
// This is the pure, testable half — eligibility/priority, the alert wording,
// and the per-user memory (app-open count + which kinds have prompted). The
// fetching/Alert/navigation wiring lives in hooks/useSecurityNudges.
//
// Two rules shape everything here:
// - Never on the device's first app open: that run belongs to the mandatory
//   recovery-code ceremony (and, for an invitee, the join flow); a second
//   security ask stacked there trains reflexive dismissal.
// - Each kind prompts ONCE per device per user — "Not Now" is a real answer,
//   not a snooze. The Recovery-methods badges on Privacy & security stay the
//   durable surface for anything dismissed.

export type SecurityNudgeKind = 'passkey' | 'guardian';

export interface SecurityNudgeMemory {
  // Cold starts counted while the full app shell was up for this user.
  opens: number;
  prompted: SecurityNudgeKind[];
}

const KEY_PREFIX = 'hc_security_nudges:';

export async function loadNudgeMemory(userId: string): Promise<SecurityNudgeMemory> {
  try {
    const raw = await AsyncStorage.getItem(KEY_PREFIX + userId);
    const parsed = raw ? (JSON.parse(raw) as Partial<SecurityNudgeMemory>) : null;
    return {
      opens: typeof parsed?.opens === 'number' ? parsed.opens : 0,
      prompted: Array.isArray(parsed?.prompted) ? (parsed!.prompted as SecurityNudgeKind[]) : [],
    };
  } catch {
    return { opens: 0, prompted: [] };
  }
}

async function saveNudgeMemory(userId: string, mem: SecurityNudgeMemory): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_PREFIX + userId, JSON.stringify(mem));
  } catch {
    // Best-effort: a failed write means one re-count/re-prompt, not a loss.
  }
}

// Count one app open for this user and return the updated memory.
export async function recordAppOpen(userId: string): Promise<SecurityNudgeMemory> {
  const mem = await loadNudgeMemory(userId);
  const next = { ...mem, opens: mem.opens + 1 };
  await saveNudgeMemory(userId, next);
  return next;
}

export async function markNudgePrompted(userId: string, kind: SecurityNudgeKind): Promise<void> {
  const mem = await loadNudgeMemory(userId);
  if (mem.prompted.includes(kind)) return;
  await saveNudgeMemory(userId, { ...mem, prompted: [...mem.prompted, kind] });
}

// Cross-hook coordination: invitations outrank security nudges, so an open
// where the invitation pop-up presented anything skips the nudge (which is NOT
// marked prompted and returns on a later open). useInviteAlerts notes here as
// it presents; module state is enough because both hooks live in one launch.
let interrupted = false;
export function noteInterruption(): void {
  interrupted = true;
}
export function interruptionThisLaunch(): boolean {
  return interrupted;
}
export function resetInterruptionForTest(): void {
  interrupted = false;
}

export interface SecurityNudgeInput {
  opens: number;
  prompted: SecurityNudgeKind[];
  // From the stored key material (mirrors useRecoveryHealth's inputs).
  enrolled: boolean;
  recoveryConfirmed: boolean;
  hasPasskey: boolean;
  passkeySupported: boolean;
  // Guardian eligibility: armed state + other household members.
  guardianArmed: boolean;
  otherMembers: number;
}

// At most one nudge per open; passkey outranks guardian (it's the
// member-independent backstop — guardian is explicitly the convenience one).
// The passkey conditions are useRecoveryHealth's `single_factor` level, so
// passkey-first registrations (level `healthy`) never match, and an account
// whose recovery code isn't confirmed yet is left to the mandatory ceremony.
export function pickSecurityNudge(i: SecurityNudgeInput): SecurityNudgeKind | null {
  if (i.opens < 2 || !i.enrolled) return null;
  if (
    i.passkeySupported && i.recoveryConfirmed && !i.hasPasskey &&
    !i.prompted.includes('passkey')
  ) return 'passkey';
  if (!i.guardianArmed && i.otherMembers > 0 && !i.prompted.includes('guardian')) return 'guardian';
  return null;
}

// The alert copy. The passkey pitch leads with data durability, not sign-in
// convenience — a passkey here also unlocks/recovers E2EE data (PRF). The
// guardian message is a capability and deliberately names no one: the newest
// member may be exactly who the user should NOT hand recovery power to.
export function nudgeAlertContent(kind: SecurityNudgeKind): { title: string; message: string } {
  if (kind === 'passkey') {
    return {
      title: 'Sign In with Face ID',
      message:
        'Add a passkey so Face ID can sign you in and unlock your encrypted data — and you can still get back in if you ever forget your password.',
    };
  }
  return {
    title: 'Add a Recovery Guardian',
    message:
      'Now that your household has another member, you can choose someone you trust to help you get back into your account if you’re ever locked out.',
  };
}
