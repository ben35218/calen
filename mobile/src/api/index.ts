import api from './client';
import type { Diagnostics } from '../lib/diagnostics';

// Signal-parity C3b: the per-collection content groups (tasks/chores/items/…)
// route their CRUD through the unified opaque store instead of a per-collection
// route (whose request line leaked the type). `store()` is the client chokepoint
// (lib/recordStore) — lazily required so api/index has no import cycle with the
// lib layer. The screens keep calling `tasksApi.create(await sealNew(...))` etc.
// unchanged; the group method just re-points the sealed payload at /records +
// the replica. Non-content methods (templates, complete, AI generate) keep their
// own routes.
import type * as RecordStore from '../lib/recordStore'; // type-only: no runtime cycle
const store = (): typeof RecordStore => require('../lib/recordStore');

// C3b: flip a sealed boolean/field on a content record by re-sealing it (the
// server can't set a field inside `enc`). Used by pause/resume, which toggle the
// sealed `active` column. Reads the decrypted record from the replica, merges the
// change, re-seals the full subset, and routes the update through the store.
async function reseal(
  collection: string,
  subset: (p: Record<string, unknown>) => Record<string, unknown>,
  id: string,
  changes: Record<string, unknown>,
) {
  const { sealUpdate } = require('../lib/e2ee');
  const rep = require('../lib/replica') as typeof import('../lib/replica');
  const existing = (await rep.getAll<Record<string, unknown>>(collection)).find((r) => r._id === id) ?? {};
  const merged = { ...existing, ...changes };
  return store().update(collection, id, await sealUpdate(collection, id, merged, subset(merged)));
}

// The same re-seal, but honouring the key the record already lives under.
//
// `reseal` above always seals with the household key. That is wrong for a record
// on an outside-shared calendar (`enc.ks === 'cal'`), which is sealed with that
// calendar's own key so collaborators can read it: re-sealing under the HDK
// silently flips it out of the shared lane and locks them out. Every
// occurrence-scoped edit to an event goes through here for that reason — the
// alternative was to withhold occurrence scoping on shared calendars entirely,
// which cost the capability rather than fixing the write.
//
// Falls back to the household lane whenever the calendar key isn't held, which
// is also what `EventFormScreen.writeEvent` does for a full save.
async function resealInLane(
  collection: string,
  subset: (p: Record<string, unknown>) => Record<string, unknown>,
  id: string,
  changes: Record<string, unknown>,
) {
  const { sealUpdate, sealForCalendar, loadCalendarKeys, currentCalendarKeyVersion } =
    require('../lib/e2ee') as typeof import('../lib/e2ee');
  const rep = require('../lib/replica') as typeof import('../lib/replica');
  const existing = (await rep.getAll<Record<string, unknown>>(collection)).find((r) => r._id === id) ?? {};
  const merged = { ...existing, ...changes };
  const enc = existing.enc as { ks?: string } | undefined;
  const calType = String(merged.calendarType ?? '');

  if (enc?.ks === 'cal' && calType) {
    await loadCalendarKeys(calType).catch(() => {});
    if (currentCalendarKeyVersion(calType) > 0) {
      const sealed = await sealForCalendar(collection, id, calType, subset(merged));
      if (sealed) return store().update(collection, id, { ...merged, ...sealed });
    }
  }
  return store().update(collection, id, await sealUpdate(collection, id, merged, subset(merged)));
}

// ── Per-occurrence scoping for repeating chores / maintenance tasks ──────────
// The chore+task equivalents of calendarApi.excludeOccurrence / truncateSeries.
// `skipDates` and `until` live INSIDE the recurrence object, which CHORE_ENC and
// TASK_ENC already seal whole, so both write through the same reseal path as
// pause/resume. HDK lane only — chores and tasks are never calendar-key sealed.
const dayEnd = (day: string) => new Date(`${day}T23:59:59`).toISOString();
function previousDay(day: string): string {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() - 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// "Delete/Save This Occurrence Only": strike the day out of the series.
//
// An interval series also walks forward from `nextDueDate`, so skipping the day
// the record is currently anchored on has to move the anchor too — otherwise the
// detail screen and the due-in label keep reporting a due date the calendar no
// longer shows.
async function skipItemOccurrence(
  collection: string,
  subset: (p: Record<string, unknown>) => Record<string, unknown>,
  id: string,
  occurrenceDate: string,
) {
  const rep = require('../lib/replica') as typeof import('../lib/replica');
  const { computeNextDueDate } = require('@household/calendar');
  const existing = (await rep.getAll<Record<string, unknown>>(collection)).find((r) => r._id === id) ?? {};
  const rec = (existing.recurrence as Record<string, unknown>) ?? {};
  const skipDates = Array.from(
    new Set([...((rec.skipDates as string[]) ?? []), occurrenceDate]),
  ).sort();
  const changes: Record<string, unknown> = { recurrence: { ...rec, skipDates } };
  const due = existing.nextDueDate ? new Date(existing.nextDueDate as string) : null;
  if (due && !Number.isNaN(due.getTime())) {
    const pad = (n: number) => String(n).padStart(2, '0');
    const dueDay = `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())}`;
    if (dueDay === occurrenceDate) {
      const next = computeNextDueDate({ ...existing, recurrence: rec }, due);
      if (next) changes.nextDueDate = next;
    }
  }
  return reseal(collection, subset, id, changes);
}

// "Resume schedule": put a scoped-down series back to work from today, without
// disturbing the past. The caller computes the new recurrence
// (lib/repeatingItemScope.buildResumedRecurrence) because it needs the decrypted
// record plus the series' detached copies; this just seals and writes it.
async function resumeItemSeries(
  collection: string,
  subset: (p: Record<string, unknown>) => Record<string, unknown>,
  id: string,
  recurrence: Record<string, unknown>,
) {
  return reseal(collection, subset, id, { recurrence });
}

// Every standalone copy made from a given series, so a resume can tell which
// upcoming days are already covered. Reads the decrypted replica — the server
// can't index a sealed `detachedFrom`.
async function detachedCopiesOf(collection: string, seriesId: string): Promise<string[]> {
  const rep = require('../lib/replica') as typeof import('../lib/replica');
  const rows = await rep.getAll<Record<string, unknown>>(collection);
  return rows
    .filter((r) => String(r.detachedFrom ?? '') === String(seriesId) && !!r.detachedDate)
    .map((r) => String(r.detachedDate));
}

// "Delete/Save All Future": end the series the day before this occurrence, so
// everything already past stays put.
async function truncateItemSeries(
  collection: string,
  subset: (p: Record<string, unknown>) => Record<string, unknown>,
  id: string,
  occurrenceDate: string,
) {
  const rep = require('../lib/replica') as typeof import('../lib/replica');
  const existing = (await rep.getAll<Record<string, unknown>>(collection)).find((r) => r._id === id) ?? {};
  const rec = (existing.recurrence as Record<string, unknown>) ?? {};
  return reseal(collection, subset, id, {
    recurrence: { ...rec, until: dayEnd(previousDay(occurrenceDate)) },
  });
}

// Typed endpoint groups ported from client/src/services/api.js. Wave 1 (Tasks &
// Chores) fills out the maintenance surface: tasks, chores, their templates,
// plus the supporting groups their screens need (categories, items, history,
// settings, odometer, contacts). Remaining groups (recipes, trips, …) follow the
// same one-line-per-endpoint pattern and land with their waves.

export interface User {
  _id: string;
  email: string;
  firstName: string;
  lastName?: string;
  role?: 'user' | 'admin';
  householdId?: string;
  // The per-user $4.99 one-time app unlock — the hard paywall keys off this
  // (mirrored into lib/unlock on every login/refresh). The USER id is the
  // RevenueCat app_user_id.
  appUnlocked?: boolean;
  // Whether the account knows a real password. false for passwordless signups —
  // the unlock UI then offers recovery/passkey instead of a password field.
  hasPassword?: boolean;
  // True after a forgot-password reset until the E2EE password factor is re-wrapped
  // under the new password: the old-password envelope can't decrypt, so the unlock
  // UI hides the password field and steers to the recovery code / passkey.
  e2eePasswordStale?: boolean;
}

export interface AuthResponse {
  token: string;
  user: User;
}

// Passkey sign-in ceremony payloads (WebAuthn JSON, verified server-side).
export interface PasskeyChallenge {
  challengeId: string;
  challenge: string; // b64url
  rpId: string;
  // Username-first: each registered credential with its E2EE PRF salt (when that
  // credential is also an unlock factor) so one assertion signs in AND unlocks.
  // Usernameless (no email sent): empty — the account and PRF salt aren't known
  // until the platform picker returns a credential, so E2EE unlocks post-auth.
  allowCredentials: { id: string; prfSalt: string | null }[];
}

export const authApi = {
  login: (data: { email: string; password: string }) =>
    api.post<AuthResponse>('/auth/login', data),
  register: (data: { email: string; password: string; firstName: string; lastName?: string; passwordless?: boolean }) =>
    api.post<AuthResponse>('/auth/register', data),
  me: () => api.get<User>('/auth/me'),
  // `currentPassword` is omitted on the biometric re-auth path (see AccountScreen);
  // sent only as the no-biometric fallback.
  updateEmail: (data: { email: string; currentPassword?: string }) => api.put('/auth/email', data),
  // `currentPassword` is omitted on the biometric re-auth path (see
  // PrivacyDataScreen); sent only as the no-biometric fallback.
  updatePassword: (data: { currentPassword?: string; newPassword: string }) =>
    api.put('/auth/password', data),
  // Forgot password: emailed 6-digit code, then reset signs the user in.
  forgotPassword: (data: { email: string }) => api.post<{ ok: boolean }>('/auth/forgot', data),
  resetPassword: (data: { email: string; code: string; newPassword: string }) =>
    api.post<AuthResponse & { e2eeEnrolled: boolean }>('/auth/reset', data),
  // Passkey sign-in + server-verified registration (see routes/authPasskey.js).
  passkeyRegisterOptions: () => api.post<Record<string, unknown>>('/auth/passkey/register-options'),
  passkeyRegister: (response: unknown) => api.post('/auth/passkey/register', response),
  // Omit `email` for usernameless (discoverable-credential) sign-in — the OS
  // account picker chooses and the server resolves the user from the assertion.
  passkeyChallenge: (data: { email?: string } = {}) => api.post<PasskeyChallenge>('/auth/passkey/challenge', data),
  passkeyLogin: (data: { challengeId: string; response: unknown }) =>
    api.post<AuthResponse>('/auth/passkey/login', data),
  // Permanent account + data deletion (Apple 5.1.1(v)). Accounts with a
  // password re-auth with it; passwordless (passkey/OAuth) accounts rely on the
  // session token. The session token is invalid immediately afterwards.
  deleteAccount: (data: { password?: string }) =>
    api.delete<{ ok: boolean }>('/auth/account', { data }),
  // Device sessions (Signal-parity F2) + the F1 pending-reset hold state.
  sessions: () => api.get<DeviceSessionsResponse>('/auth/sessions'),
  revokeSession: (sid: string) => api.delete<{ ok: boolean }>(`/auth/sessions/${sid}`),
  cancelReset: () => api.post<{ ok: boolean }>('/auth/reset/cancel'),
};

export interface DeviceSession {
  _id: string;
  deviceName: string;
  platform: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}
export interface DeviceSessionsResponse {
  sessions: DeviceSession[];
  // Set while a password reset from an unknown device is being held (F1);
  // any signed-in device can cancel it.
  pendingResetHoldUntil: string | null;
}

// Report objectionable AI-generated content (Apple 1.2).
export const moderationApi = {
  report: (data: { content: string; reason?: string; surface?: string }) =>
    api.post<{ ok: boolean }>('/moderation/report', data),
};

// In-app "Help & Feedback" — a question, bug report, or idea (spec:
// features/feedback.md). Plaintext support content by design (not sealed).
export const feedbackApi = {
  submit: (data: { type: 'question' | 'bug' | 'idea'; message: string; contactEmail?: string; diagnostics?: Diagnostics }) =>
    api.post<{ ok: boolean; id: string }>('/feedback', data),
};

// E2EE key material (Phase 1). The server is a blind store: it only sees the
// identity PUBLIC key and the private key wrapped as opaque factor envelopes.
// All crypto happens on-device in lib/e2ee.ts.
export interface StoredKeyMaterial {
  enrolled: boolean;
  identityPublicKey: string | null;
  wrappedPrivateKey: unknown[];
  keyEnrolledAt: string | null;
  keySchemaVersion: number;
  recoverySetupAt: string | null;
}

export const keysApi = {
  me: () => api.get<StoredKeyMaterial>('/keys/me'),
  enroll: (data: { identityPublicKey: string; factors: unknown[] }) => api.post('/keys/enroll', data),
  // Lost-every-factor recovery: replace the identity keypair outright. Recovers
  // ACCESS (a calendar owner can re-wrap to the new key), never DATA — anything
  // sealed to the old identity stays sealed. 409 `confirm_data_loss` when the
  // account has records of its own; re-send with confirmDataLoss to proceed.
  rekey: (data: { identityPublicKey: string; factors: unknown[]; confirmDataLoss?: boolean }) =>
    api.post<{ enrolled: boolean; keyEnrolledAt: string; envelopesCleared: number }>('/keys/rekey', data),
  putFactor: (envelope: unknown) => api.put('/keys/factors', envelope),
  removeFactor: (factor: string, credentialId?: string) =>
    api.delete(`/keys/factors/${factor}`, { params: credentialId ? { credentialId } : {} }),
  publicKey: (userId: string) => api.get<{ userId: string; identityPublicKey: string }>(`/keys/public/${userId}`),
  // Confirm a non-password recovery factor is in place (recovery code saved
  // and/or passkey enrolled). Idempotent server-side.
  recoveryComplete: () => api.post<{ recoverySetupAt: string | null }>('/keys/recovery-complete'),
  // Signal-parity F4 — QR device linking. A blind relay between two of the
  // account's own devices: the new (locked) device opens a slot, the existing
  // (unlocked) device seals the account secret to the scanned ephemeral key, and
  // the server only ferries the opaque `sealedPayload`.
  linkStart: (data: { ephemeralPublicKey: string; deviceName?: string }) =>
    api.post<{ linkId: string; expiresAt: string }>('/keys/link/start', data),
  linkComplete: (data: { linkId: string; sealedPayload: string }) =>
    api.post<{ ok: boolean }>('/keys/link/complete', data),
  linkPoll: (linkId: string) =>
    api.get<{ status: 'pending' | 'sealed' | 'consumed'; sealedPayload?: string }>(`/keys/link/${linkId}`),

  // Guardian recovery (dual-control). A household member helps the user recover,
  // but neither party alone can open the key: the guardian's sealed box + the
  // user's 4-digit PIN. Server stores the opaque `outer` blind and blind-relays
  // the re-sealed handoff. See specs/features/guardian-recovery.md.
  guardianStatus: () =>
    api.get<{ armed: boolean; guardianUserId?: string; guardianName?: string | null; armedAt?: string }>('/keys/guardian'),
  guardianArm: (data: { guardianUserId: string; guardianFingerprint: string; outer: string }) =>
    api.put<{ armed: boolean }>('/keys/guardian', data),
  guardianDisarm: () => api.delete<{ armed: boolean }>('/keys/guardian'),
  guardianRequest: (data: { ephemeralPublicKey: string; fingerprint: string }) =>
    api.post<{ requestId: string; expiresAt: string }>('/keys/guardian/request', data),
  guardianRequests: () =>
    api.get<{ requests: GuardianRequest[] }>('/keys/guardian/requests'),
  guardianApprove: (data: { requestId: string; sealedPayload: string }) =>
    api.post<{ ok: boolean }>('/keys/guardian/approve', data),
  guardianPoll: (requestId: string) =>
    api.get<{ status: 'pending' | 'sealed'; sealedPayload?: string }>(`/keys/guardian/request/${requestId}`),
};

// A pending recovery request surfaced to the guardian, carrying the requester's
// opaque `outer` blob (which the guardian unseals + re-seals locally).
export interface GuardianRequest {
  requestId: string;
  userId: string;
  requesterName: string;
  fingerprint: string;
  ephemeralPublicKey: string;
  outer: string;
}

// ----- Recurrence (shared by tasks, chores, and their templates) -------------

export type RecurrenceType = 'interval' | 'calendar' | 'one-time';
export type IntervalUnit = 'days' | 'weeks' | 'months' | 'years';

export interface Recurrence {
  type: RecurrenceType;
  intervalValue?: number;
  intervalUnit?: IntervalUnit;
  months?: number[];
  dayOfMonth?: number | null;
  dayOfWeek?: number | null;
  weekOfMonth?: number | null;
  // Per-occurrence scoping, the chore/task counterpart of a CalendarEvent's
  // exceptionDates + recurrence.until. `skipDates` are YYYY-MM-DD occurrences
  // struck out one at a time; `until` ends the series. Both live inside
  // recurrence so CHORE_ENC/TASK_ENC seal them with the rule, and the shared
  // engine honours them on expansion.
  skipDates?: string[];
  until?: string | Date | null;
}

// ----- Tasks (maintenance) ---------------------------------------------------

export interface LinkedRef {
  _id: string;
  name: string;
  // Present when the ref is populated with extra fields (e.g. an item's type,
  // used to show the item's category icon).
  type?: string;
  icon?: string;
  color?: string;
  // Populated refs carry their enc blob so the client can decrypt the (sealed)
  // name post-drop via openRecord on the ref itself.
  keyVersion?: number;
  enc?: { alg: string; nonce: string; ct: string };
}

export interface Task {
  _id: string;
  title: string;
  description?: string;
  instructions?: string;
  active?: boolean;
  categoryId?: LinkedRef | string | null;
  itemId?: LinkedRef | string | null;
  templateId?: string;
  // MaterialCommunityIcons glyph; falls back to the category icon when absent.
  icon?: string;
  priority?: 'low' | 'medium' | 'high';
  estimatedDurationMins?: number;
  estimatedCost?: number;
  nextDueDate?: string;
  lastCompletedAt?: string;
  recurrence?: Recurrence;
  reminderDaysBefore?: number | null;
  alert2DaysBefore?: number | null;
  reminderTime?: string | null;
  alertAudience?: 'everyone' | 'owner';
  // Explicit alert recipients; empty/absent = everyone.
  alertUserIds?: string[];
  // mileage-tracked tasks
  intervalKm?: number;
  lastServiceKm?: number;
  nextDueKm?: number;
  // Occurrence-scoping links (see lib/repeatingItemScope): a detached one-off
  // copy names its series + day; a "Save for Future" fork names the series it
  // truncated. Sealed fields — present after openRecord, never server-visible.
  detachedFrom?: string | null;
  detachedDate?: string | null;
  splitFrom?: string | null;
  updatedAt?: string;
  keyVersion?: number;
  enc?: { alg: string; nonce: string; ct: string };
}

export interface Completion {
  _id: string;
  completedDate: string;
  performedBy?: string;
  cost?: number;
  notes?: string;
}

export const tasksApi = {
  // C3b: CRUD routes through the unified opaque store (lib/recordStore); the
  // screens still call these with a sealNew/sealUpdate payload.
  list: (params?: Record<string, unknown>) => store().list<Task>('MaintenanceTask', params),
  get: (id: string) => store().get<Task>('MaintenanceTask', id),
  create: (data: Record<string, unknown>) => store().create<Task>('MaintenanceTask', data),
  update: (id: string, data: Record<string, unknown>) => store().update<Task>('MaintenanceTask', id, data),
  delete: (id: string) => store().remove('MaintenanceTask', id),
  complete: (id: string, data?: Record<string, unknown>) =>
    api.post<{ task: Task; completion: Completion }>(`/tasks/${id}/complete`, data),
  // C3b: pause/resume flip the sealed `active` field → re-seal client-side.
  pause: (id: string) => reseal('MaintenanceTask', require('../lib/encSubsets').TASK_ENC, id, { active: false }),
  resume: (id: string) => reseal('MaintenanceTask', require('../lib/encSubsets').TASK_ENC, id, { active: true }),
  // Apple-style occurrence scoping on a repeating task (see the helpers above).
  skipOccurrence: (id: string, occurrenceDate: string) =>
    skipItemOccurrence('MaintenanceTask', require('../lib/encSubsets').TASK_ENC, id, occurrenceDate),
  truncateSeries: (id: string, occurrenceDate: string) =>
    truncateItemSeries('MaintenanceTask', require('../lib/encSubsets').TASK_ENC, id, occurrenceDate),
  // Put a scoped-down series back to work from today (see repeatingItemScope).
  resumeSeries: (id: string, recurrence: Record<string, unknown>) =>
    resumeItemSeries('MaintenanceTask', require('../lib/encSubsets').TASK_ENC, id, recurrence),
  detachedCopies: (seriesId: string) => detachedCopiesOf('MaintenanceTask', seriesId),
  // Template instantiation happens client-side now (lib/taskTemplates —
  // Signal-parity D4): the app builds + seals template tasks and POSTs /tasks.
  templates: (params?: Record<string, unknown>) => api.get<TaskTemplate[]>('/task-templates', { params }),
  template: (id: string) => api.get<TaskTemplate>(`/task-templates/${id}`),
  completions: (params?: Record<string, unknown>) => api.get<Completion[]>('/tasks/completions', { params }),
};

// ----- Unified opaque record store (Signal-parity C3) ------------------------
// The server stores every content record in ONE collection with no plaintext
// type; the type + content ride inside the opaque `enc` blob (v2 envelope). Reads
// are a single householdId + updatedAt sync cursor; writes are opaque. This is the
// destination the per-collection routes fold into (C3b). See lib/records.ts.
export interface RecordRow {
  _id: string;
  householdId?: string;
  userId?: string;
  keyVersion?: number;
  enc?: { alg: string; nonce: string; ct: string; ks?: 'cal' | 'trip' };
  scope?: { kind: 'calendar' | 'trip'; resource: string; version: number };
  deleted?: boolean;
  updatedAt?: string;
  createdAt?: string;
}

export interface RecordSyncResponse {
  records: RecordRow[];
  serverTime: string;
}

export const recordsApi = {
  // Incremental LWW pull: every record in scope updated after `since`, tombstones
  // included (a deleted row arrives with deleted:true so replicas converge).
  sync: (since?: string | null) =>
    api.get<RecordSyncResponse>('/records/sync', { params: since ? { since } : {} }),
  create: (data: { _id?: string; enc: unknown; keyVersion?: number; scope?: unknown }) =>
    api.post<RecordRow>('/records', data),
  update: (id: string, data: { enc: unknown; keyVersion?: number; scope?: unknown }) =>
    api.put<RecordRow>(`/records/${id}`, data),
  remove: (id: string) => api.delete(`/records/${id}`),
};

export interface TaskTemplate {
  id: string;
  title: string;
  recurrence?: Recurrence;
  priority?: 'low' | 'medium' | 'high';
  estimatedDurationMins?: number;
  estimatedCost?: number;
  intervalKm?: number;
  defaultCategoryName?: string;
  // MaterialCommunityIcons glyph; falls back to the category icon when absent.
  icon?: string;
  // Who typically does the work: DIY, hire a pro, or depends on setup.
  diy?: 'diy' | 'pro' | 'depends';
}

// A maintenance task Calen staged during the AI plan chat, not yet created.
// Carries everything needed to create the task once an item is linked in the
// TaskTemplateReview flow; shape mirrors the server's normalizeProposedTask.
export interface ProposedTask {
  title: string;
  defaultCategoryName?: string | null;
  recurrence?: Recurrence;
  nextDueDate?: string | null;
  priority?: 'low' | 'medium' | 'high';
  description?: string;
  // Set when Calen sourced this from a curated template, so the created task
  // links back to it (marks the template "in use").
  templateId?: string;
  // Who typically does the work (carried from the source template).
  diy?: 'diy' | 'pro' | 'depends';
}

// ----- Chores ----------------------------------------------------------------

export interface ChoreAssignee {
  _id?: string;
  accountId?: string;
  name?: string;
  keyVersion?: number;
  enc?: { alg: string; nonce: string; ct: string };
}

export interface Chore {
  _id: string;
  title: string;
  instructions?: string;
  description?: string;
  icon?: string;
  active?: boolean;
  assignedTo?: ChoreAssignee | string | null;
  nextDueDate?: string;
  recurrence?: Recurrence;
  reminderDaysBefore?: number | null;
  alert2DaysBefore?: number | null;
  reminderTime?: string | null;
  alertAudience?: 'everyone' | 'owner';
  // Occurrence-scoping links (see lib/repeatingItemScope): a detached one-off
  // copy names its series + day; a "Save for Future" fork names the series it
  // truncated. Sealed fields — present after openRecord, never server-visible.
  detachedFrom?: string | null;
  detachedDate?: string | null;
  splitFrom?: string | null;
  updatedAt?: string;
  keyVersion?: number;
  enc?: { alg: string; nonce: string; ct: string };
}

export interface ChoreTemplate {
  id: string;
  title: string;
  icon?: string;
  recurrence?: Recurrence;
  defaultCategoryName?: string;
}

export const choresApi = {
  list: (params?: Record<string, unknown>) => store().list<Chore>('Chore', params),
  get: (id: string) => store().get<Chore>('Chore', id),
  create: (data: Record<string, unknown>) => store().create<Chore>('Chore', data),
  update: (id: string, data: Record<string, unknown>) => store().update<Chore>('Chore', id, data),
  delete: (id: string) => store().remove('Chore', id),
  pause: (id: string) => reseal('Chore', require('../lib/encSubsets').CHORE_ENC, id, { active: false }),
  resume: (id: string) => reseal('Chore', require('../lib/encSubsets').CHORE_ENC, id, { active: true }),
  // Apple-style occurrence scoping on a repeating chore (see the helpers above).
  skipOccurrence: (id: string, occurrenceDate: string) =>
    skipItemOccurrence('Chore', require('../lib/encSubsets').CHORE_ENC, id, occurrenceDate),
  truncateSeries: (id: string, occurrenceDate: string) =>
    truncateItemSeries('Chore', require('../lib/encSubsets').CHORE_ENC, id, occurrenceDate),
  // Put a scoped-down series back to work from today (see repeatingItemScope).
  resumeSeries: (id: string, recurrence: Record<string, unknown>) =>
    resumeItemSeries('Chore', require('../lib/encSubsets').CHORE_ENC, id, recurrence),
  detachedCopies: (seriesId: string) => detachedCopiesOf('Chore', seriesId),
  // Template instantiation happens client-side now (Signal-parity D4): the app
  // builds + seals template chores and POSTs /chores.
  templates: (params?: Record<string, unknown>) => api.get<ChoreTemplate[]>('/chore-templates', { params }),
  template: (id: string) => api.get<ChoreTemplate>(`/chore-templates/${id}`),
};

// ----- Supporting groups for the maintenance screens -------------------------

export interface Category {
  _id: string;
  // Content (sealed into enc — Signal-parity D5); decrypt via lib/categories.
  name: string;
  color?: string;
  icon?: string;
  parent?: string | null;
  parentId?: string | null;
  sortOrder?: number;
  updatedAt?: string;
  keyVersion?: number;
  enc?: { alg: string; nonce: string; ct: string };
}

export const categoriesApi = {
  list: (params?: Record<string, unknown>) => store().list<Category>('Category', params),
  create: (data: Record<string, unknown>) => store().create<Category>('Category', data),
  update: (id: string, data: Record<string, unknown>) => store().update<Category>('Category', id, data),
  // Reassign-on-delete is client-side now (the server can't read categoryId to
  // rebucket sealed items): the screen re-seals affected items to `reassignTo`
  // before removing the category. The delete itself is a plain tombstone.
  delete: (id: string, _reassignTo?: string) => store().remove('Category', id),
};

export interface Property {
  _id: string;
  name: string;
  icon?: string;
  color?: string;
  sortOrder?: number;
}

export const propertiesApi = {
  list: (params?: Record<string, unknown>) => api.get<Property[]>('/properties', { params }),
  create: (data: Record<string, unknown>) => api.post<Property>('/properties', data),
  update: (id: string, data: Record<string, unknown>) => api.put<Property>(`/properties/${id}`, data),
  delete: (id: string, reassignTo?: string) =>
    api.delete(`/properties/${id}`, { data: { reassignTo } }),
};

export interface CustomField {
  key: string;
  value: string;
}

export interface Manual {
  _id: string;
  title: string;
  source: string;
  fileSizeBytes: number;
  encrypted?: boolean;        // E2EE (Phase 4c): opaque ciphertext, decrypted on-device
  wrappedFileKey?: string;    // HDK-wrapped per-file key (JSON), needed to decrypt
  keyVersion?: number;        // which HDK version wrapped the file key
  fileType?: string;          // original mime type (for opening the decrypted file)
}

export interface Receipt {
  _id: string;
  title: string;
  fileSizeBytes?: number;
  fileType?: string;         // original mime type (for opening the decrypted file)
  createdAt?: string;
  encrypted?: boolean;       // E2EE (Phase 4c): opaque ciphertext, decrypted on-device
  wrappedFileKey?: string;   // HDK-wrapped per-file key (JSON), needed to decrypt
  keyVersion?: number;       // which HDK version wrapped the file key
}

export const receiptsApi = {
  // upload is handled via lib/upload (multipart, field 'file'); endpoint:
  //   POST /receipts/items/:itemId/upload
  // download is a token-query URL / Bearer download built in the screen:
  //   GET /receipts/:id/download
  delete: (id: string) => api.delete(`/receipts/${id}`),
};

export interface Item {
  _id: string;
  name: string;
  type?: string;
  location?: string;
  categoryId?: LinkedRef | string | null;
  propertyId?: LinkedRef | string | null;
  serviceProId?: LinkedRef | string | null;
  manufacturer?: string;
  modelNumber?: string;
  serialNumber?: string;
  notes?: string;
  customFields?: CustomField[];
  manuals?: Manual[];
  receipts?: Receipt[];
  autoLookupManual?: boolean;
}

export const itemsApi = {
  // C3b: item CRUD routes through the unified store. manuals/receipts (which stay
  // their own collections) are fetched separately by the detail screen, not
  // populated here.
  list: (params?: Record<string, unknown>) => store().list<Item>('Item', params),
  get: (id: string) => store().get<Item>('Item', id),
  create: (data: Record<string, unknown>) => store().create<Item>('Item', data),
  update: (id: string, data: Record<string, unknown>) => store().update<Item>('Item', id, data),
  delete: (id: string) => store().remove('Item', id),
  // fromPhoto is handled via lib/upload (multipart); endpoint: POST /items/from-photo
};

export interface ManualCandidate {
  url: string;
  title?: string;
  domain?: string;
  snippet?: string;
  recommended?: boolean;
}

export interface ExtractedTask {
  title: string;
  description?: string;
  notes?: string;
  priority?: 'low' | 'medium' | 'high';
  recurrence?: Recurrence;
  estimatedDurationMins?: number;
  estimatedCost?: number;
  intervalKm?: number;
}

export const manualsApi = {
  fromUrl: (itemId: string, data: { url: string; title?: string }) =>
    api.post(`/manuals/items/${itemId}/from-url`, data),
  autoLookup: (itemId: string) =>
    api.post<{ candidates: ManualCandidate[]; query?: string; isFallback?: boolean }>(
      `/manuals/items/${itemId}/auto-lookup`
    ),
  extractTasks: (id: string) =>
    api.post<{ tasks: ExtractedTask[]; manualTitle?: string }>(`/manuals/${id}/extract-tasks`),
  // Extracted-task creation happens client-side now (lib/taskTemplates —
  // Signal-parity D4): the app builds + seals each reviewed task and POSTs /tasks.
  delete: (id: string) => api.delete(`/manuals/${id}`),
  // upload is handled via lib/upload (multipart, field 'file'); endpoint:
  //   POST /manuals/items/:itemId/upload
  // download is a token-query URL built in the screen via downloadUrl():
  //   GET /manuals/:id/download?token=…
};

export interface Ingredient {
  amount?: string;
  unit?: string;
  name: string;
  // Section this ingredient belongs to ("Base", "For the sauce", or a
  // variation name); undefined = ungrouped. Groups named in the recipe's
  // `variations` list are mutually exclusive flavor choices.
  group?: string;
}

export interface Recipe {
  _id: string;
  title: string;
  description?: string;
  imageUrl?: string;
  sourceUrl?: string;
  source?: 'manual' | 'ai' | 'url' | 'photo';
  servings?: number | null;
  prepTimeMins?: number | null;
  cookTimeMins?: number | null;
  tags?: string[];
  ingredients?: Ingredient[];
  instructions?: string[];
  // Per-step ingredient links: instructionIngredients[stepIdx] = ingredient indices.
  instructionIngredients?: number[][];
  // Per-step timer in minutes (parallel to instructions); null = no timer.
  instructionTimers?: (number | null)[];
  // Ingredient-group names that are mutually exclusive flavor variations
  // (e.g. ["Lemon Blueberry", "Chocolate Peanut Butter"]). A meal schedules
  // one of them; the grocery list buys only the chosen one.
  variations?: string[];
  // Per-step variation tags (parallel to instructions): null/[] = the step is
  // shared by every variation; else the variation names it applies to. Cooking
  // mode shows only the steps that apply to the kit being cooked.
  instructionVariations?: (string[] | null)[];
}

export const recipesApi = {
  // C3b: recipe CRUD routes through the unified store; the AI generate/from-url/
  // from-photo helpers below keep their own routes (they return a draft the client
  // seals + creates).
  list: () => store().list<Recipe>('Recipe'),
  get: (id: string) => store().get<Recipe>('Recipe', id),
  create: (data: Record<string, unknown>) => store().create<Recipe>('Recipe', data),
  update: (id: string, data: Record<string, unknown>) => store().update<Recipe>('Recipe', id, data),
  delete: (id: string) => store().remove('Recipe', id),
  fromUrl: (url: string) => api.post<Partial<Recipe>>('/recipes/from-url', { url }),
  generateFromAi: (description: string) => api.post<Partial<Recipe>>('/recipes/generate', { description }),
  // edit-with-ai responses return with instructionIngredients already
  // recomputed server-side — there is no separate re-tag call.
  editWithAi: (recipe: Record<string, unknown>, instruction: string) =>
    api.post<Partial<Recipe>>('/recipes/edit-with-ai', { recipe, instruction }),
  // Recipe sharing is device-composed (OS share sheet in RecipeDetailScreen);
  // the server-sent styled-email path was retired 2026-08-01.
  suggestRecipes: (params: { query: string }) =>
    api.post<{ recipes: RecipeSuggestion[] }>('/recipes/suggest-recipes', params),
  // fromPhoto handled via lib/upload (repeated field 'photo', up to 5 pages of
  // one recipe in a single request): POST /recipes/from-photo
  // …as is uploadPhoto (a picture OF the dish, no AI): POST /recipes/photo.
  //
  // Bind a saved recipe to the photo it kept (`null` removes it). The URL is
  // sealed inside the record, so the server can only learn which file is still
  // in use by being told — an unclaimed file is swept as an abandoned draft.
  // See lib/recipePhoto.
  setPhoto: (id: string, imageUrl: string | null) =>
    api.put<{ claimed: string | null; removed: number }>(`/recipes/${id}/photo`, { imageUrl }),
};

export interface RecipeSuggestion {
  title: string;
  description?: string;
  time?: string;
  usedIngredients?: string[];
  needsOther?: string[];
}

export interface RecipeSchedule {
  _id: string;
  recipeId: { _id: string; title?: string } | string;
  scheduledDate: string;
  servings?: number;
  notes?: string;
  // The flavor variation this meal is planned as (one of the recipe's
  // `variations`); null/undefined = none chosen (grocery buys everything).
  variation?: string | null;
  updatedAt?: string;
  keyVersion?: number;
  enc?: { alg: string; nonce: string; ct: string };
}

export interface GroceryItem {
  name: string;
  amount?: string;
  // Per-recipe source entries (built client-side by lib/groceryList; the AI
  // organize endpoint consolidates them into a single amount).
  entries?: { recipeTitle?: string; amount?: string; unit?: string; multiplier?: number }[];
}

export const recipeScheduleApi = {
  // C3b: meal-plan entries route through the unified store (callers seal first via
  // sealNew 'RecipeSchedule'); the grocery list + organize/session stay their own.
  list: (params?: Record<string, unknown>) => store().list<RecipeSchedule>('RecipeSchedule', params),
  schedule: (data: Record<string, unknown>) => store().create<RecipeSchedule>('RecipeSchedule', data),
  update: (id: string, data: Record<string, unknown>) => store().update<RecipeSchedule>('RecipeSchedule', id, data),
  remove: (id: string) => store().remove('RecipeSchedule', id),
  forRecipe: (recipeId: string) => store().list<RecipeSchedule>('RecipeSchedule', { recipeId }),
  organizeGroceryList: (items: GroceryItem[], sectionOrder?: string[]) =>
    api.post<OrganizedGroceryList>('/recipe-schedule/organize-grocery-list', {
      items,
      sectionOrder: sectionOrder?.length ? sectionOrder : undefined,
    }),
  sessionGet: (weekStart: string) =>
    api.get<GrocerySessionEnvelope>('/recipe-schedule/session', { params: { weekStart } }),
  // Versioned write: `baseVersion` is the version the client read; the server
  // 409s on mismatch (the caller re-fetches, merges on-device, retries — see
  // lib/grocerySession). A session seals as `enc` when the household key is
  // held, falling back to plaintext `state` (the transition lane old builds
  // still write).
  sessionPut: (
    weekStart: string,
    body: {
      state?: GrocerySessionState;
      enc?: { alg: string; nonce: string; ct: string };
      keyVersion?: number;
      baseVersion?: number;
    },
  ) => api.put<{ ok: boolean; version: number }>('/recipe-schedule/session', { weekStart, ...body }),
};

export interface OrganizedGroceryList {
  store_known?: boolean;
  // `aisle` rides along from the AI when the store's layout is known; the
  // locally-patched "New Items" section has none.
  categories: { name: string; aisle?: string; items: GroceryItem[] }[];
}

// A row the shopper added by hand — something no recipe implies (paper towels,
// coffee). Merged into the derived list on-device (lib/groceryExtras).
export interface GroceryExtra {
  name: string;
  amount?: string;
}

export interface GrocerySessionState {
  checked?: Record<string, boolean>;
  // Hand-added items for this shopping period. Part of the session because
  // that's where everything the shopper (rather than the meal plan) decides
  // already lives, and because it makes the additions household-shared.
  extras?: GroceryExtra[];
  substitutions?: Record<string, string>;
  notFound?: Record<string, boolean>;
  haveHome?: Record<string, boolean>;
  organizedList?: OrganizedGroceryList | null;
  // Fingerprint of the grocery items `organizedList` was built from (cleaned
  // name -> portion signature, lib/groceryOrganize.groceryFingerprint).
  // Flipping to the plain list doesn't discard the organized one, so this is
  // how the client keeps a saved organized list honest as the plan moves: the
  // diff against the current week patches it locally (New Items appended,
  // removed items dropped, re-portioned amounts rewritten) — no AI call.
  organizedFor?: Record<string, string> | null;
}

// What GET /recipe-schedule/session actually returns: legacy plaintext state
// spread at the top level (old builds read the body AS the state), plus the
// sealed envelope and the optimistic-concurrency version for current clients.
// Opened/merged/saved through lib/grocerySession, never read raw by screens.
export interface GrocerySessionEnvelope extends GrocerySessionState {
  enc?: { alg: string; nonce: string; ct: string } | null;
  keyVersion?: number;
  version?: number;
}

export const historyApi = {
  list: (params?: Record<string, unknown>) => api.get<Completion[]>('/history', { params }),
};

// A calendar-level alert config: days before the date (0 = the day of) plus the
// wall-clock `HH:mm` they all fire at. Mirrors lib/calendarPrefs' local shape.
export interface AlertPrefs {
  offsets: number[];
  time: string;
}

// The user's calendar arrangement as it travels on `/settings`. Every field is
// SPARSE — only deviations from the app defaults are carried, so a calendar the
// user never touched (or one added later, on any device) picks up the defaults.
// Mirrors lib/calendarPrefs' local state.
export interface CalendarPrefsPayload {
  // calendar id → hex colour, for calendars the user recoloured.
  colors?: Record<string, string>;
  // Display order as calendar ids; ids not listed sort after these.
  order?: string[];
  // Calendars toggled off in the Calendars view (visible is the default).
  hidden?: string[];
  // Built-in calendars the user deleted (restorable via Add Calendar).
  deletedDefaults?: string[];
  // Calendars whose "Event Alerts" switch is off.
  alertsOff?: string[];
}

export interface Settings {
  householdMemberCount?: number;
  firstName?: string;
  lastName?: string;
  birthday?: string;
  phone?: string;
  timezone?: string;
  // Server-side mirror of the device's AI consent toggle (middleware/aiConsent).
  aiEnabled?: boolean;
  // Personal default time (HH:mm, local) day-based alerts fire at; null/absent =
  // the 9am default. Set on the Account screen; honored by the server cron (hour
  // only) and the on-device scheduler (full HH:mm).
  dayAlertTime?: string | null;
  // Calendar-level alert configs for the two calendars whose items are computed
  // on-device: Occasions, and the holiday calendars (one config for all of
  // them). ACCOUNT settings — lib/calendarPrefs caches them on the device but
  // treats these as the truth, since the cache is wiped at sign-out. null =
  // never configured (the client's own defaults apply); `offsets: []` = the
  // user turned that calendar's alerts off.
  occasionAlerts?: AlertPrefs | null;
  holidayAlerts?: AlertPrefs | null;
  // How the user arranged their calendars. An ACCOUNT setting for the same
  // reason as the alert configs above — the device cache is wiped at sign-out,
  // so without this every colour, reorder, hide and delete was lost on the next
  // sign-in. null = never configured (this device's arrangement stands and
  // seeds the account); a field ABSENT within it means the same for that field,
  // while an empty value means the user cleared it.
  calendarPrefs?: CalendarPrefsPayload | null;
  homeAddress?: string;
  // Coarse home-area label (city + region/country) the calendar assistant grounds
  // local suggestions in — derived client-side from the address, or set by hand.
  // Shared (household-level), plaintext; never the street address.
  homeCity?: string;
  // Household default zone (scheduler fallback) — derived client-side from the
  // home location; write via the `householdTimezone` key on PUT.
  householdTimezone?: string;
  reminderLeadDays?: number;
  // null when the household hasn't configured a shopping day yet.
  groceryShoppingDay?: number | null;
  // Shopping cadence; for 'biweekly', groceryAnchor (YYYY-MM-DD, a known
  // shopping day) fixes which alternating week is the shopping week.
  groceryFrequency?: 'weekly' | 'biweekly';
  groceryAnchor?: string | null;
  grocerySections?: string[];
  // Encrypted home-location blob (§9.1 P5).
  householdId?: string;
  keyVersion?: number;
  enc?: { alg: string; nonce: string; ct: string };
  [key: string]: unknown;
}

export const settingsApi = {
  get: () => api.get<Settings>('/settings'),
  update: (data: Record<string, unknown>) => api.put<Settings>('/settings', data),
};

export interface OdometerLog {
  _id: string;
  // Content (sealed into enc; post-drop the plaintext column is null and the
  // client decrypts) — see lib/odometer.ts.
  reading?: number;
  notes?: string;
  recordedAt: string;
  updatedAt?: string;
  keyVersion?: number;
  enc?: { alg: string; nonce: string; ct: string };
}

// Raw rows only (Signal-parity D5): currentKm / kmPerDay / remaining-km
// enrichment are computed client-side over the decrypted logs (lib/odometer).
export interface OdometerStatus {
  logs?: OdometerLog[];
  mileageTasks?: Task[];
}

export const odometerApi = {
  // C3b: odometer logs live in the unified store; assemble the status client-side
  // from the replica (logs for this vehicle + its mileage-tracked tasks). Callers
  // seal the reading first (sealNew 'OdometerLog') and validate against the prior
  // decrypted reading client-side (lib/odometer).
  get: async (itemId: string): Promise<{ data: OdometerStatus }> => {
    await store().refresh();
    const rep = require('../lib/replica') as typeof import('../lib/replica');
    const logs = (await rep.getAll<OdometerLog>('OdometerLog'))
      .filter((l) => String((l as { itemId?: string }).itemId) === itemId)
      .sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime());
    const mileageTasks = (await rep.getAll<Task>('MaintenanceTask'))
      .filter((t) => String((t as { itemId?: string }).itemId) === itemId && t.intervalKm != null && t.active !== false);
    return { data: { logs, mileageTasks } };
  },
  log: (itemId: string, data: Record<string, unknown>) => store().create<OdometerLog>('OdometerLog', data),
  delete: (_itemId: string, logId: string) => store().remove('OdometerLog', logId),
};

// A labeled contact value (Apple-Contacts-style multi-value field). See
// lib/contactFields for the normalize/migrate helpers.
export interface ContactLabeledValue {
  label: string;
  value: string;
}
export interface ContactRelatedName extends ContactLabeledValue {
  contactId?: string;
}

export interface Contact {
  _id: string;
  // Canonical, composed display name (source of truth for roster/sort/e-cards).
  name: string;
  // Structured components (Apple-Contacts First / Last); `name` is recomposed
  // from them on save. Absent on legacy records — read via contactFields.
  firstName?: string;
  lastName?: string;
  type: 'family' | 'friend' | 'service' | string;
  accountId?: string;
  relationship?: string;
  birthday?: string;
  // Multi-value labeled fields (the current shape). `dates` values are YYYY-MM-DD
  // (anniversary/custom — birthday stays its own single field, driving the
  // calendar). `company`/`jobTitle` apply to all types (company supersedes the
  // old service-only businessName).
  phones?: ContactLabeledValue[];
  emails?: ContactLabeledValue[];
  addresses?: ContactLabeledValue[];
  dates?: ContactLabeledValue[];
  urls?: ContactLabeledValue[];
  relatedNames?: ContactRelatedName[];
  jobTitle?: string;
  company?: string;
  notes?: string;
  // When true, this contact's birthday + dates are excluded from the Occasions
  // calendar (grid, day/list, search, reminders) and the Occasions list. Default
  // false (shown).
  occasionsHidden?: boolean;
  deviceContactId?: string;
  // Legacy single-value fields — read via lib/contactFields.normalizeContact and
  // cleared on the next save. Kept for records not yet re-edited.
  email?: string;
  phone?: string;
  address?: string;
  businessName?: string;
}

// Raw device contact sent to the AI classifier; results echo back the same key.
export interface ImportContact {
  key: string;
  name: string;
  phone?: string;
  email?: string;
  birthday?: string;
  company?: string;
}

export interface ClassifiedContact {
  key: string;
  type: 'family' | 'friend' | 'service';
  name: string;
  relationship?: string;
  businessName?: string;
  address?: string;
  phone?: string;
  email?: string;
  birthday?: string;
  notes?: string;
}

export const contactsApi = {
  // C3b: contact CRUD routes through the unified store. The self-Contact is just a
  // create with accountId set (the client seeds it — the server can no longer
  // create readable content); bulk import creates each sealed contact client-side.
  list: (params?: Record<string, unknown>) => store().list<Contact>('Contact', params),
  create: (data: Record<string, unknown>) => store().create<Contact>('Contact', data),
  createSelf: (data: Record<string, unknown>) => store().create<Contact>('Contact', data),
  update: (id: string, data: Record<string, unknown>) => store().update<Contact>('Contact', id, data),
  delete: (id: string) => store().remove('Contact', id),
  bulk: async (contacts: Record<string, unknown>[]) => {
    const { sealNew } = require('../lib/e2ee');
    const { CONTACT_ENC } = require('../lib/encSubsets');
    const created = await Promise.all(
      contacts.map(async (p) => store().create<Contact>('Contact', await sealNew('Contact', p, CONTACT_ENC(p)))),
    );
    return { data: created.map((r: { data: Contact }) => r.data) };
  },
  // AI-assisted import: categorize + pre-fill. The model sees each contact's
  // name + company only. Web-search enrichment of professionals rides along
  // with the AI-assisted method — choosing it implies `enrich: true`; the
  // import sheet's hint discloses the lookup (spec: ai-assistant.md).
  classify: (contacts: ImportContact[], enrich = false) =>
    api.post<{ results: ClassifiedContact[] }>('/contacts/classify', { contacts, enrich }),
};

// ----- Occasion e-cards ------------------------------------------------------
// PLAINTEXT by design: unlike Contact content, a scheduled e-card's recipient
// emails + message are sent to the server in the clear (a documented E2EE
// exception, like email invites) so it can be delivered on the occasion date
// while the app is closed. See crypto-e2ee.md "Deliberate plaintext exceptions".
export interface ECardRecipient { email: string; name?: string }

// A photo embedded in the card email (stored plaintext server-side, like the
// message). Bytes are fetched via ecardPhotoPath (bearer auth required).
export interface ECardPhoto { _id: string; contentType: string }

export interface ECard {
  _id: string;
  userId: string;
  householdId?: string;
  contactId?: string;
  kind: OccasionKind;
  occasionLabel?: string;
  month: number;
  day: number;
  sendTime: string; // 'HH:mm'
  template?: string;
  font?: string; // 'sans' | 'serif' | 'elegant' | 'script'; empty = template default
  message?: string;
  // Author overrides for the card's framing lines; blank = the server defaults
  // (per-recipient "Dear <name>," / the style's sign-off phrase / author's
  // first name).
  greeting?: string;
  signoff?: string;
  signature?: string;
  photos?: ECardPhoto[];
  recipients: ECardRecipient[];
  // A card sends once, on its next occurrence; `active` clears + `sentAt` stamps
  // after the send (no annual recurrence).
  active: boolean;
  sentAt?: string | null;
}

export interface ECardInput {
  contactId?: string;
  kind: OccasionKind;
  occasionLabel?: string;
  month: number;
  day: number;
  sendTime?: string;
  template?: string;
  font?: string;
  message?: string;
  greeting?: string;
  signoff?: string;
  signature?: string;
  recipients: ECardRecipient[];
}

// Photo upload is multipart (lib/upload's uploadFile, field 'photo') against
// ecardPhotoUploadPath; the paths live here so screens don't hand-roll them.
export const ecardPhotoUploadPath = (id: string) => `/ecards/${id}/photos`;
export const ecardPhotoPath = (id: string, photoId: string) => `/ecards/${id}/photos/${photoId}`;

export const ecardsApi = {
  list: () => api.get<ECard[]>('/ecards'),
  create: (data: ECardInput) => api.post<ECard>('/ecards', data),
  update: (id: string, data: Partial<ECardInput> & { active?: boolean }) => api.patch<ECard>(`/ecards/${id}`, data),
  remove: (id: string) => api.delete<{ ok: true }>(`/ecards/${id}`),
  removePhoto: (id: string, photoId: string) => api.delete<ECard>(ecardPhotoPath(id, photoId)),
};

// ----- Household (sharing) ---------------------------------------------------

export interface HouseholdMember {
  _id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
}

export interface Household {
  _id: string;
  // Content since Signal-parity C2: sealed into the settings blob (`enc`,
  // collection 'Household'); post-drop decrypt via openRecord to display it.
  name: string;
  ownerId: string;
  isOwner?: boolean;
  homeAddress?: string;
  // True once the household's plaintext has been dropped (§9). Gates the
  // client-side encrypted self-Contact seed.
  e2eeActive?: boolean;
  // Signal-parity pass-2: dropped under an older DROP_FIELDS version → the owner
  // device runs the re-seal-all backfill (dropMigration.reencryptForReDrop).
  resealNeeded?: boolean;
  members: HouseholdMember[];
  keyVersion?: number;
  enc?: { alg: string; nonce: string; ct: string };
}

// Approve-on-device join (Phase 2).
export interface JoinRequestMine {
  status: 'none' | 'pending' | 'approved' | 'rejected';
  requestId?: string;
  name?: string | null;
}
export interface JoinRequestForApprover {
  _id: string;
  requesterUserId: string;
  requesterPublicKey: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  createdAt: string;
}
export interface HDKEnvelopePayload {
  wrappedHDK: string;
  keyVersion: number;
}
export interface HouseholdKeyState {
  householdId: string;
  currentKeyVersion: number;
  isOwner: boolean;
  keyRotationPending: boolean;
  envelopes: { keyVersion: number; wrappedHDK: string }[];
}
export interface HouseholdMemberKey {
  userId: string;
  identityPublicKey: string;
}

// A household-membership invitation (replaces the join code). Sent by a member;
// accepting opens a JoinRequest a member then approves on-device.
export interface HouseholdInvitation {
  _id: string;
  householdId: string;
  fromName?: string;
  fromEmail?: string;
  householdName: string;
  toEmail?: string;
  toPhone?: string;
  toUserId?: string;
  status: 'pending' | 'accepted' | 'declined';
  respondedAt?: string;
  createdAt: string;
}
export interface RotationPayload {
  keyVersion: number;
  envelopes: { userId: string; wrappedHDK: string }[];
}

// A one-off membership notice addressed to me (removed from a household, or
// approved into one), shown in the Invitations inbox until dismissed.
export interface HouseholdNotice {
  _id: string;
  kind: 'removed' | 'approved';
  actorName?: string;
  householdId?: string;
  acknowledgedAt?: string;
  createdAt: string;
}

export const householdApi = {
  get: () => api.get<Household>('/household'),
  // Callers seal the name into the settings blob first (C2 — see HouseholdScreen).
  rename: (data: Record<string, unknown>) => api.put<Household>('/household', data),
  // Invite by email or phone (replaces the join code). Phone invites resolve to
  // an account by the invitee's saved phone; the caller texts them separately.
  invite: (target: { email?: string; phone?: string }) =>
    api.post<{ invitation: HouseholdInvitation; userExists: boolean }>('/household/invitations', target),
  sentInvitations: () => api.get<HouseholdInvitation[]>('/household/invitations'),
  revokeInvitation: (id: string) => api.delete(`/household/invitations/${id}`),
  myInvitations: () => api.get<HouseholdInvitation[]>('/household/invitations/mine'),
  acceptInvitation: (id: string) =>
    api.post<{ status: string; requestId?: string; name?: string }>(`/household/invitations/${id}/accept`),
  declineInvitation: (id: string) =>
    api.post<{ invitation: HouseholdInvitation }>(`/household/invitations/${id}/decline`),
  myJoinRequest: () => api.get<JoinRequestMine>('/household/join-requests/mine'),
  cancelJoinRequest: () => api.delete('/household/join-requests/mine'),
  joinRequests: () => api.get<JoinRequestForApprover[]>('/household/join-requests'),
  approveJoin: (id: string, envelope: HDKEnvelopePayload) => api.post(`/household/join-requests/${id}/approve`, envelope),
  rejectJoin: (id: string) => api.post(`/household/join-requests/${id}/reject`),
  // Membership notices (e.g. "you were removed"), shown in the Invitations inbox.
  notices: () => api.get<HouseholdNotice[]>('/household/notices'),
  ackNotice: (id: string) => api.post(`/household/notices/${id}/ack`),
  getKey: () => api.get<HouseholdKeyState>('/household/key'),
  mintKey: (envelope: HDKEnvelopePayload) => api.post('/household/key', envelope),
  leave: () => api.post('/household/leave'),
  // Phase 7 member removal + lazy HDK rotation (§5.2).
  memberKeys: () => api.get<HouseholdMemberKey[]>('/household/member-keys'),
  rotateKey: (payload: RotationPayload) => api.post<{ ok: boolean; keyVersion: number }>('/household/key/rotate', payload),
  removeMember: (userId: string) => api.post(`/household/members/${userId}/remove`),
  // §9 drop readiness gate + client-version report.
  readiness: () => api.get<E2eeReadiness>('/household/e2ee/readiness'),
  reportClientVersion: (version: string, platform: string) =>
    api.post('/household/e2ee/client-version', { version, platform }),
  // §9 straggler re-encrypt pass (owner device seals records lacking ciphertext).
  stragglers: () => api.get<E2eeStragglers>('/household/e2ee/stragglers'),
  seal: (payload: { collection: string; _id: string; enc: unknown; keyVersion?: number }) =>
    api.post('/household/e2ee/seal', payload),
  // B1/B3 (Signal-parity plan): records still sealed under an old HDK version,
  // and old-envelope retirement once they've all been re-sealed.
  oldVersions: () => api.get<E2eeOldVersions>('/household/e2ee/old-versions'),
  retireKey: () => api.post<{ ok: boolean; retired: number }>('/household/key/retire'),
  // Born-encrypted activation: flip a fresh mandated household E2EE-live once its
  // records already carry ciphertext (§9). Idempotent; the server no-ops for
  // exempt/grandfathered households.
  activate: () => api.post<E2eeActivateResult>('/household/e2ee/activate'),
  // Re-seal + re-drop backfill (Signal-parity pass-2): records that still hold a
  // plaintext DROP_FIELDS value the current enc predates, for the decrypt-merge-
  // reseal pass; then a stamp that unblocks the server null script.
  resealAll: () => api.get<E2eeResealAll>('/household/e2ee/reseal-all'),
  resealComplete: () => api.post<{ ok: boolean; dropFieldsVersion: number }>('/household/e2ee/reseal-complete'),
  // Join carry-over: records left stranded in a household this user has left,
  // served with that household's envelopes so the device can decrypt and re-seal
  // them into the household it joined. See lib/joinCarryover.
  carryover: () => api.get<CarryoverPending>('/household/carryover'),
  carryoverMove: (id: string, payload: { enc: unknown; keyVersion?: number }) =>
    api.put<{ ok: boolean; moved: boolean }>(`/household/carryover/${id}`, payload),
  carryoverComplete: () =>
    api.post<{ ok: boolean; reaped: number; remaining: string[] }>('/household/carryover/complete'),
};

// Stranded records grouped by the household they were left behind in.
export interface CarryoverPending {
  total: number;
  households: {
    householdId: string;
    envelopes: { keyVersion: number; wrappedHDK: string }[];
    records: RecordRow[];
  }[];
}

// Re-seal-all pass: per collection, records needing their newer content fields
// folded into `enc`, served with their current plaintext DROP_FIELDS + old enc.
export interface E2eeResealAll {
  total: number;
  dropFieldsVersion: number;
  collections: E2eeStragglerGroup[];
}

export interface E2eeActivateResult {
  status: 'committed' | 'already-active' | 'not-required' | 'not-ready' | 'stragglers' | 'dry-run';
  e2eeActive: boolean;
}

export interface E2eeStragglerGroup {
  collection: string;
  fields: string[];
  records: Record<string, unknown>[];
}
export interface E2eeStragglers {
  total: number;
  collections: E2eeStragglerGroup[];
}

// B1: records still sealed under an old HDK version (enc + keyVersion only —
// the client decrypts via its version→HDK map and re-seals under current).
export interface E2eeOldVersions {
  total: number;
  currentKeyVersion?: number;
  collections: {
    collection: string;
    records: { _id: string; enc: { alg: string; nonce: string; ct: string }; keyVersion: number }[];
  }[];
}

export interface E2eeReadinessMember {
  userId: string;
  email: string;
  enrolled: boolean;
  hasEnvelope: boolean;
  clientVersion: string | null;
  versionOk: boolean;
}
export interface E2eeReadiness {
  e2eeActive: boolean;
  ready: boolean;
  currentKeyVersion: number;
  minAppVersion: string | null;
  perMember: E2eeReadinessMember[];
  reasons: string[];
}

// ----- Places (Google Places proxy; powers address autocomplete) -------------

export interface PlacePrediction {
  place_id: string;
  description: string;
  main_text?: string;
  secondary_text?: string;
}

export const placesApi = {
  autocomplete: (query: string, type?: string, bias?: { lat?: number; lon?: number; country?: string }) =>
    api.get<{ predictions: PlacePrediction[] }>('/places/autocomplete', {
      params: { query, ...(type ? { type } : {}), ...(bias ?? {}) },
    }),
  getDetails: (placeId: string) => api.get(`/places/details/${placeId}`),
  getTimezone: (placeId: string) => api.get<{ timeZoneId?: string }>(`/places/timezone/${placeId}`),
  getTravelTime: (destination: string, origin?: string, mode?: string, departureTime?: string) =>
    api.get<{ minutes: number; distanceKm: string }>('/places/travel-time', {
      params: {
        destination,
        origin: origin || undefined,
        // DRIVE is the server default; only transit reads departureTime.
        mode: mode && mode !== 'DRIVE' ? mode : undefined,
        departureTime: departureTime || undefined,
      },
    }),
  routeLeg: (payload: Record<string, unknown>) => api.post('/places/route-leg', payload),
};

// ----- Trips ------------------------------------------------------------------

export type TripStatus = 'considering' | 'booked' | 'completed';
export type TripItemType =
  | 'flight' | 'hotel' | 'car-rental' | 'restaurant' | 'activity' | 'transit' | 'other';

export interface TripItem {
  _id: string;
  type: TripItemType;
  title: string;
  start: string;
  end?: string;
  location?: string;
  details?: Record<string, unknown>;
  cost?: number | null;
  currency?: string;
  confirmation?: string;
  confirmed?: boolean;
  sharing?: string;
  notes?: string;
  url?: string;
  phone?: string;
  placeId?: string;
  address?: string;
  householdId?: string;
  paidByHouseholdId?: string;
  myData?: { cost?: number | null; currency?: string; confirmation?: string; confirmed?: boolean; partySize?: number };
  shares?: { householdId: string; amount?: number | null }[];
  participants?: string[];
  attachments?: TripItemAttachment[];
  userId?: { firstName?: string };
}

// Booking confirmation file (PDF/image). Encrypted ones (private bookings on an
// E2EE household) are ciphertext on the server; wrappedFileKey + keyVersion let
// the device decrypt after download, and fileType is the plaintext mimetype.
export interface TripItemAttachment {
  _id: string;
  filename?: string;
  fileType?: string;
  fileSizeBytes?: number;
  householdId?: string;
  encrypted?: boolean;
  wrappedFileKey?: string;
  keyVersion?: number;
}

export interface CandidateRange {
  start: string;
  end: string;
  label?: string;
  note?: string;
}

export interface Trip {
  _id: string;
  name: string;
  destination?: string;
  destinationTz?: string;
  status: TripStatus;
  startDate?: string;
  endDate?: string;
  color?: string;
  notes?: string;
  candidateRanges?: CandidateRange[];
  items?: TripItem[];
  collaborators?: { _id: string; firstName?: string; lastName?: string; email?: string }[];
  // Outside-household addresses (email or phone) the owner shared this trip with
  // (owner-only in the response). A non-empty list, or any collaborator, means
  // the trip is shared.
  sharedWithOutside?: { email?: string; phone?: string }[];
}

export interface TripBudget {
  total: number;
  budget?: number | null;
  remaining: number;
  baseCurrency: string;
  costedCount?: number;
  byType: { type: string; amount: number }[];
}

export interface SettlementPayment {
  _id: string;
  fromName: string;
  toName: string;
  amount: number;
  currency?: string;
  note?: string;
  date?: string;
}

export interface SettlementLine {
  kind?: 'booking' | 'payment';
  itemId?: string;
  type?: string;
  title?: string;
  amount: number;
}

export interface SettlementBalance {
  from?: string;
  to?: string;
  fromName: string;
  toName: string;
  amount: number;
  lines?: SettlementLine[];
}

export interface HouseholdOption {
  householdId: string;
  name: string;
}

export interface Settlement {
  baseCurrency: string;
  ratesAvailable?: boolean;
  balances: SettlementBalance[];
  payments?: SettlementPayment[];
  households?: HouseholdOption[];
  myHouseholdId?: string | null;
}

export const tripsApi = {
  list: (params?: Record<string, unknown>) => api.get<Trip[]>('/trips', { params }),
  get: (id: string) => api.get<Trip>(`/trips/${id}`),
  create: (data: Record<string, unknown>) => api.post<Trip>('/trips', data),
  update: (id: string, data: Record<string, unknown>) => api.put<Trip>(`/trips/${id}`, data),
  remove: (id: string) => api.delete(`/trips/${id}`),
  budget: (id: string) => api.get<TripBudget>(`/trips/${id}/budget`),
  families: (id: string) => api.get<{ householdId: string; name: string }[]>(`/trips/${id}/families`),
  settlement: (id: string) => api.get<Settlement>(`/trips/${id}/settlement`),
  addPayment: (id: string, data: Record<string, unknown>) => api.post(`/trips/${id}/settle-payments`, data),
  removePayment: (id: string, payId: string) => api.delete(`/trips/${id}/settle-payments/${payId}`),
  addItem: (id: string, data: Record<string, unknown>) => api.post<TripItem>(`/trips/${id}/items`, data),
  updateItem: (id: string, itemId: string, data: Record<string, unknown>) =>
    api.put<TripItem>(`/trips/${id}/items/${itemId}`, data),
  removeItem: (id: string, itemId: string) => api.delete(`/trips/${id}/items/${itemId}`),
  // Attachment upload is multipart — see lib/upload (field 'file'):
  //   POST /trips/:id/items/:itemId/attachments
  removeAttachment: (id: string, itemId: string, attId: string) =>
    api.delete(`/trips/${id}/items/${itemId}/attachments/${attId}`),
  // Sharing by outside email → invitation → collaborator (mirrors calendars).
  // Signal-parity D2: sharing no longer flips the trip to plaintext (the 409
  // decrypt-on-share lane is retired). The trip stays sealed and migrates onto a
  // TripKey on the owner's next unlock. Because the Trip's name/destination are
  // sealed, the client passes a plaintext { tripName, destination } snapshot for
  // the invitation display rows only. Entries are addressed by email or phone.
  setShareRecipients: (
    id: string,
    recipients: { email?: string; phone?: string }[],
    snapshot?: { tripName?: string; destination?: string },
  ) =>
    api.put<{ sharedWithOutside: { email?: string; phone?: string }[] }>(`/trips/${id}/share`, { recipients, ...snapshot }),
  unshare: (id: string) => api.delete(`/trips/${id}/share`),
  leaveShare: (id: string) => api.post(`/trips/${id}/leave-share`),
  removeCollaborator: (id: string, userId: string) => api.delete(`/trips/${id}/collaborators/${userId}`),
  // Trip-share invitations addressed to me (Invitations inbox).
  invitations: () => api.get<TripInvitation[]>('/trips/invitations'),
  acceptInvitation: (id: string) =>
    api.post<{ invitation: TripInvitation; tripId: string; name: string }>(`/trips/invitations/${id}/accept`),
  declineInvitation: (id: string) =>
    api.post<{ invitation: TripInvitation }>(`/trips/invitations/${id}/decline`),
  // D2 TripKey envelope lifecycle (see lib/tripKeys.ts) — same shape as the D1
  // calendar key routes, keyed by the Trip _id.
  keys: (id: string) => api.get<ResourceKeyEnvelopes>(`/trips/${id}/keys`),
  mintKey: (id: string, payload: { keyVersion: number; household: { hdkVersion: number; wrappedKey: string }; members?: { userId: string; wrappedKey: string }[] }) =>
    api.post<{ ok: boolean; keyVersion: number }>(`/trips/${id}/keys`, payload),
  wrapMembers: (id: string, payload: { keyVersion: number; members: { userId: string; wrappedKey: string }[] }) =>
    api.post<{ ok: boolean; wrapped: number }>(`/trips/${id}/keys/members`, payload),
  pendingKeys: () => api.get<TripKeyPending[]>('/trips/keys/pending'),
};

// ----- TripKeys (Signal-parity D2: per-resource content keys) -----------------
// The TripKey envelopes for one shared trip: the household wrap (I'm in the owning
// household → unwrap via my HDK) and/or my own member wrap (I'm a collaborator).
// Shape-compatible with the D1 CalendarKeyEnvelopes so lib/e2ee reuses one loader.
export interface ResourceKeyEnvelopes {
  currentKeyVersion: number;
  household: { keyVersion: number; hdkVersion: number; wrappedKey: string }[];
  member: { keyVersion: number; wrappedKey: string }[];
}
// The owner's wrap-on-approve work list (one entry per trip needing work).
export interface TripKeyPending {
  tripId: string;
  currentKeyVersion: number;
  needsMint: boolean;
  rotationPending: boolean;
  collaborators: { userId: string; identityPublicKey: string }[];
  missingMembers: { userId: string; identityPublicKey: string }[];
}

// A per-trip sharing invitation addressed to me. Accepting makes me a
// collaborator with live access to the itinerary.
export interface TripInvitation {
  _id: string;
  fromName?: string;
  fromEmail?: string;
  tripId: string;
  tripName: string;
  destination?: string;
  status: 'pending' | 'accepted' | 'declined';
  respondedAt?: string;
  createdAt: string;
}

// ----- Calendar & billing (foundation; expanded in their waves) --------------

// How the user is getting to an event — the mode its travel time was computed
// for. Absent on older records, which were always drive times.
export type TravelMode = 'DRIVE' | 'WALK' | 'TRANSIT' | 'BICYCLE';

export interface CalendarEvent {
  _id: string;
  title: string;
  calendarType: string;
  allDay?: boolean;
  startDate: string;
  endDate?: string;
  description?: string;
  location?: string;
  url?: string;
  phone?: string;
  travelMinutes?: number | null;
  travelDistanceKm?: string | null;
  travelMode?: TravelMode | null;
  reminderMinutes?: number | null;
  alert2Minutes?: number | null;
  // Which instant each alert's lead time was set against: the event's start
  // ('event', the default and what an older record without the field means) or
  // departure ('leave' — "30 min before leaving"). Both are STORED as minutes
  // before the event; the anchor records the framing the user chose, which the
  // number alone cannot express. See lib/calendar.
  alertAnchor?: 'event' | 'leave' | null;
  alert2Anchor?: 'event' | 'leave' | null;
  // Set when Calen's cancellation call got the business to confirm.
  cancelled?: boolean;
  recurrence?: {
    freq: string;
    interval?: number;
    until?: string;
    // Weekly: which weekdays (0=Sun..6=Sat).
    daysOfWeek?: number[];
    // Monthly "each": numbered dates of the month (1..31).
    daysOfMonth?: number[];
    // Yearly: which months (1..12).
    months?: number[];
    // Monthly "on the" / yearly "days of week": ordinal (1..5, -1=last,
    // -2=next to last) + day kind. For yearly it applies within each month.
    weekOfMonth?: number;
    weekdayKind?: 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'day' | 'weekday' | 'weekend';
  };
  // Calendar days (YYYY-MM-DD) removed from the series one at a time ("Delete This
  // Event Only"); the shared expansion engine skips these occurrences.
  exceptionDates?: string[];
  // Whether cross-household invitees may see who else is invited (default true).
  guestListVisible?: boolean;
  // Household members (userIds) asked to accept/decline. Sealed with the event;
  // each member's response is their own EventRsvp record (lib/householdRsvp).
  householdInvitees?: string[];
  // Sealed author userId folded in by lib/e2ee.withAuthor (C4) — readable
  // on-device after decrypt; the server's plaintext userId column is nulled.
  author?: string;
  // Set when this event is a copy accepted from a cross-household invitation —
  // the form shows "Leave event" instead of Delete.
  invitationId?: string;
  // Response-only flag on GET /calendar/events/:id: this user has view-only
  // access to the event's calendar (housemate or outside collaborator) — the
  // form renders read-only.
  readOnly?: boolean;
  // E2EE dual-write (Phase 3a): opaque ciphertext of the content + its key version.
  keyVersion?: number;
  // `ks` names the key the content is sealed under: absent = the household key,
  // 'cal' = the CalendarKey of an outside-shared calendar (D1). The recurrence
  // helpers below re-seal under the HDK only, so `ks === 'cal'` is what the
  // occurrence-scoped edits and deletes check before offering themselves.
  enc?: { alg: string; nonce: string; ct: string; ks?: string };
}

export type OccasionKind = 'birthday' | 'anniversary' | 'marriage' | 'death' | 'custom';

export interface CalendarOccasion {
  id: string;
  kind: OccasionKind;
  name: string;
  // Friendly noun for known kinds; the raw contact date label for custom kinds.
  label: string;
  date: string;
  contactId: string;
  relationship?: string;
  // The original year the occasion happened, when a real year is on file.
  year?: number | null;
}

export interface CalendarRecipeSchedule {
  _id?: string;
  scheduledDate: string;
  recipeId?: { _id: string; title?: string } | string;
}

export interface CalendarTripOverlay {
  id: string;
  name: string;
  color?: string;
  status?: string;
  ranges: { start: string; end: string; label?: string }[];
}

// The assembled calendar view. Built entirely client-side now (C3b:
// lib/calendarData.loadCalendarData decrypts the opaque /records feed over the
// replica and runs the shared @household/calendar engine) — no server aggregate.
export interface CalendarData {
  tasks: Task[];
  chores: Chore[];
  events: CalendarEvent[];
  occasions: CalendarOccasion[];
  recipes: CalendarRecipeSchedule[];
  groceryShopping: { id: string; date: string }[];
  trips: CalendarTripOverlay[];
}

// A file attachment on a calendar event (photo / PDF). Same shape as Receipt,
// scoped to an event instead of an item.
export interface EventAttachment {
  _id: string;
  eventId?: string;
  title: string;
  fileSizeBytes?: number;
  fileType?: string;         // original mime type (for opening the decrypted file)
  createdAt?: string;
  encrypted?: boolean;       // E2EE (Phase 4c): opaque ciphertext, decrypted on-device
  wrappedFileKey?: string;   // HDK-wrapped per-file key (JSON), needed to decrypt
  keyVersion?: number;       // which HDK version wrapped the file key
}

export const eventAttachmentsApi = {
  list: (eventId: string) => api.get<EventAttachment[]>(`/calendar/events/${eventId}/attachments`),
  delete: (id: string) => api.delete(`/calendar/attachments/${id}`),
  // Duplicate an event's attachments onto another event (an occurrence override
  // or a forked series — both are new records, and attachments hang off the id).
  copyFrom: (targetEventId: string, sourceEventId: string) =>
    api.post<EventAttachment[]>(`/calendar/events/${targetEventId}/attachments/copy-from/${sourceEventId}`),
  // upload is handled via lib/upload (multipart, field 'file'); endpoint:
  //   POST /calendar/events/:eventId/attachments/upload
  // download is a Bearer / token-query URL built in the screen:
  //   GET /calendar/attachments/:id/download
};

// C3b: an outside-shared calendar's event seals under its CalendarKey (D1,
// enc.ks==='cal'); the unified store routes it by the plaintext `scope` lane, so
// derive scope from the event's calendarType (the CalendarKey resource) + version.
// An HDK event (no ks) has no scope.
function withCalScope(data: Record<string, unknown>): Record<string, unknown> {
  const enc = data.enc as { ks?: string } | undefined;
  if (enc?.ks === 'cal' && data.calendarType && !data.scope) {
    return { ...data, scope: { kind: 'calendar', resource: data.calendarType, version: data.keyVersion } };
  }
  return data;
}

export const calendarApi = {
  // The calendar view is assembled client-side (lib/calendarData.loadCalendarData
  // over the replica); the server /calendar aggregate + /calendar/events CRUD
  // routes were retired in C3b. Event CRUD routes through the unified opaque store
  // (with the D1 cal scope).
  getEvent: (id: string) => store().get<CalendarEvent>('CalendarEvent', id),
  createEvent: (data: Record<string, unknown>) => store().create<CalendarEvent>('CalendarEvent', withCalScope(data)),
  updateEvent: (id: string, data: Record<string, unknown>) => store().update<CalendarEvent>('CalendarEvent', id, withCalScope(data)),
  deleteEvent: (id: string) => store().remove('CalendarEvent', id),
  // Single-field flips on sealed event content (C3b: `guestListVisible` and
  // `cancelled` live inside `enc`, so a plaintext PUT is rejected by the opaque
  // store). Re-seal via the replica like pause/resume, in whichever key lane the
  // event already lives under (see resealInLane), same as the recurrence
  // helpers below.
  setGuestListVisible: (id: string, v: boolean) =>
    resealInLane('CalendarEvent', require('../lib/encSubsets').EVENT_ENC, id, { guestListVisible: v }),
  // Household members asked to accept/decline (sealed; responses are per-member
  // EventRsvp records — see lib/householdRsvp).
  setHouseholdInvitees: (id: string, userIds: string[]) =>
    resealInLane('CalendarEvent', require('../lib/encSubsets').EVENT_ENC, id,
      { householdInvitees: userIds.length ? userIds : undefined }),
  cancelEvent: (id: string) =>
    resealInLane('CalendarEvent', require('../lib/encSubsets').EVENT_ENC, id, { cancelled: true }),
  // Both alert slots, written together from the event detail view's in-place
  // pickers (calendar.md → Reminders/alerts). The pair travels as one patch
  // because they are set as one: clearing the first PROMOTES the second into
  // its place, so a per-slot write would leave the record in a state the form's
  // own rule forbids. `undefined` clears a slot — a field set to undefined drops
  // out of the sealed blob.
  setAlerts: (
    id: string,
    alerts: {
      reminderMinutes?: number;
      alertAnchor?: string;
      alert2Minutes?: number;
      alert2Anchor?: string;
    },
  ) =>
    resealInLane('CalendarEvent', require('../lib/encSubsets').EVENT_ENC, id, {
      reminderMinutes: alerts.reminderMinutes,
      alertAnchor: alerts.alertAnchor,
      alert2Minutes: alerts.alert2Minutes,
      alert2Anchor: alerts.alert2Anchor,
    }),
  // Turn an accepted cross-household copy back into an ordinary household event
  // by clearing the sealed `invitationId` that marks it read-only and renames its
  // delete action to "Leave event". Used by the merge pass (lib/invitationMerge)
  // when the organizer's original is gone, so this copy is the only survivor and
  // there is nothing left for it to be a copy OF. A field set to undefined drops
  // out of the sealed blob.
  detachInvitationCopy: (id: string) =>
    resealInLane('CalendarEvent', require('../lib/encSubsets').EVENT_ENC, id, { invitationId: undefined }),
  // Recurring-event deletes (Apple-style). The server can't edit sealed content,
  // so each re-seals the whole event (resealInLane reads the decrypted record
  // from the replica, so callers never reconstruct the recurrence), under
  // whichever key the event already lives under — an event on an outside-shared
  // calendar keeps its CalendarKey lane instead of being flipped to the HDK.
  //
  // "Delete This Event Only": add the tapped occurrence's day to exceptionDates;
  // the shared engine skips it.
  excludeOccurrence: async (id: string, occurrenceDate: string) => {
    const rep = require('../lib/replica') as typeof import('../lib/replica');
    const existing = (await rep.getAll<CalendarEvent>('CalendarEvent')).find((r) => r._id === id);
    const exceptionDates = Array.from(
      new Set([...((existing?.exceptionDates as string[]) ?? []), occurrenceDate]),
    ).sort();
    return resealInLane('CalendarEvent', require('../lib/encSubsets').EVENT_ENC, id, { exceptionDates });
  },
  // "Delete All Future Events" for a non-first occurrence: end the series on the
  // day before it (past occurrences stay). `until` is the end of that local day,
  // matching the Repeat form's convention.
  truncateSeries: async (id: string, occurrenceDate: string) => {
    const rep = require('../lib/replica') as typeof import('../lib/replica');
    const existing = (await rep.getAll<CalendarEvent>('CalendarEvent')).find((r) => r._id === id);
    const prev = new Date(`${occurrenceDate}T00:00:00`);
    prev.setDate(prev.getDate() - 1);
    const pad = (n: number) => String(n).padStart(2, '0');
    const untilDay = `${prev.getFullYear()}-${pad(prev.getMonth() + 1)}-${pad(prev.getDate())}`;
    const recurrence = { ...(existing?.recurrence ?? {}), until: new Date(`${untilDay}T23:59:59`).toISOString() };
    return resealInLane('CalendarEvent', require('../lib/encSubsets').EVENT_ENC, id, { recurrence });
  },
};

// ----- Custom calendars (Calendars → Add Calendar) ----------------------------

// Per-contact permission on a shared calendar.
export type CalendarAccess = 'view' | 'full';

// Server record for a user-created calendar. `key` is the client-minted
// `custom-<slug>` id that events reference via calendarType; `mine` = created
// by the requester (creator-only edit/delete); `access` = the requester's
// effective event permission on it.
export interface CustomCalendarRecord {
  _id: string;
  userId: string;
  key: string;
  name: string;
  color: string;
  alertsEnabled: boolean;
  sharedWithHousehold: boolean;
  householdAccess: CalendarAccess;
  sharedWith: { userId: string; access: CalendarAccess }[];
  sharedWithOutside: { email?: string; phone?: string; access: CalendarAccess }[];
  // ICS subscription source. Present => read-only subscribed calendar whose
  // events each device fetches/expands itself (lib/calendarFeeds).
  feedUrl?: string;
  // Present => read-only holiday calendar whose events each device computes
  // itself from this country config (lib/holidays via calendarPrefs).
  holiday?: { country: string; selectedRegions?: string[]; disabledIds?: string[] };
  // D1: > 0 once the calendar has minted a per-resource CalendarKey (it is or
  // was outside-shared) — its events seal under that key, so the client must
  // load it before the replica can decrypt them (lib/calendarKeys).
  calKeyVersion?: number;
  mine: boolean;
  access: CalendarAccess;
  // THIS requester's own collaborator seat after a re-key (never anyone else's;
  // the collaborator list itself is never serialized). `keyChangedAt` = their
  // identity changed, so every automatic CalendarKey wrap is suppressed until
  // the owner approves; `accessRequestedAt` = they have asked. Together they are
  // the durable "waiting on the owner" state the viewer shell shows across
  // sign-outs — see server routes/calendars.js `serialize`.
  keyChangedAt?: string;
  accessRequestedAt?: string;
}

export type CustomCalendarPayload = Omit<CustomCalendarRecord, '_id' | 'userId' | 'mine' | 'access'>;

// An outside-household calendar-sharing invitation addressed to me. Accepting
// grants live access to the calendar and its events at `access` level.
export interface CalendarInvitation {
  _id: string;
  fromName?: string;
  fromEmail?: string;
  calendarKey: string;
  calendarName: string;
  color?: string;
  access: CalendarAccess;
  status: 'pending' | 'accepted' | 'declined';
  respondedAt?: string;
  createdAt: string;
}

// ----- CalendarKeys (Signal-parity D1: per-resource content keys) -------------
// The CalendarKey wrapped to me for one outside-shared calendar: the household
// wrap (I'm in the owning household → unwrap via my HDK) and/or my own member
// wrap (I'm a collaborator → unwrap via my identity key).
export interface CalendarKeyEnvelopes {
  calendarKey: string;
  currentKeyVersion: number;
  household: { keyVersion: number; hdkVersion: number; wrappedKey: string }[];
  member: { keyVersion: number; wrappedKey: string }[];
}
// The owner's wrap-on-approve work list (one entry per calendar needing work).
export interface CalendarKeyPending {
  calendarKey: string;
  calendarName?: string;
  currentKeyVersion: number;
  needsMint: boolean;
  rotationPending: boolean;
  // Collaborators the owner may wrap to automatically. Anyone who re-keyed is
  // held out of this list (and out of `missingMembers`) until approved, so the
  // background pass can never re-grant on its own.
  collaborators: { userId: string; access: CalendarAccess; identityPublicKey: string }[];
  missingMembers: { userId: string; identityPublicKey: string }[];
  // The owner's approval queue: collaborators who lost every unlock factor,
  // re-keyed, and asked for access back. `identityPublicKey` is the NEW key —
  // its safety number is what the owner checks before approving.
  reapprovals?: {
    userId: string;
    name: string | null;
    identityPublicKey: string;
    requestedAt: string;
  }[];
}

export const customCalendarsApi = {
  list: () => api.get<CustomCalendarRecord[]>('/calendars'),
  create: (data: CustomCalendarPayload) => api.post<CustomCalendarRecord>('/calendars', data),
  update: (key: string, data: Partial<Omit<CustomCalendarPayload, 'key'>>) =>
    api.put<CustomCalendarRecord>(`/calendars/${key}`, data),
  remove: (key: string) => api.delete(`/calendars/${key}`),
  invitations: () => api.get<CalendarInvitation[]>('/calendars/invitations'),
  acceptInvitation: (id: string) =>
    api.post<{ invitation: CalendarInvitation; calendar: CustomCalendarRecord }>(`/calendars/invitations/${id}/accept`),
  declineInvitation: (id: string) =>
    api.post<{ invitation: CalendarInvitation }>(`/calendars/invitations/${id}/decline`),
  // D1 CalendarKey envelope lifecycle (see lib/calendarKeys.ts).
  keys: (key: string) => api.get<CalendarKeyEnvelopes>(`/calendars/${key}/keys`),
  mintKey: (key: string, payload: { keyVersion: number; household: { hdkVersion: number; wrappedKey: string }; members?: { userId: string; wrappedKey: string }[] }) =>
    api.post<{ ok: boolean; keyVersion: number }>(`/calendars/${key}/keys`, payload),
  wrapMembers: (key: string, payload: { keyVersion: number; members: { userId: string; wrappedKey: string }[] }) =>
    api.post<{ ok: boolean; wrapped: number }>(`/calendars/${key}/keys/members`, payload),
  pendingKeys: () => api.get<CalendarKeyPending[]>('/calendars/keys/pending'),
  // Re-key recovery. A collaborator who re-keyed asks the owner to restore
  // access; the owner approves by wrapping the CalendarKey to their new key.
  requestAccess: (key: string) =>
    api.post<{ ok: boolean; calendarName: string; requestedAt: string }>(`/calendars/${key}/access-request`),
  approveAccess: (key: string, payload: { userId: string; keyVersion: number; wrappedKey: string }) =>
    api.post<{ ok: boolean; keyVersion: number }>(`/calendars/${key}/keys/approve`, payload),
};

// ----- Event invitations (cross-household sharing by email) -------------------

// Plaintext snapshot of the event carried by an invitation (the client decrypts
// the source event and sends this alongside the eventId).
export interface InvitationEventSnapshot {
  title: string;
  description?: string;
  location?: string;
  url?: string;
  phone?: string;
  startDate: string;
  endDate?: string;
  allDay?: boolean;
  calendarType?: string;
}

export interface EventInvitation {
  _id: string;
  fromUserId: string;
  fromName?: string;
  fromEmail?: string;
  // Exactly one of toEmail/toPhone is set (SMS invites are phone-addressed).
  toEmail?: string;
  toPhone?: string;
  toUserId?: string;
  // Capability secret for the public .ics link carried by an SMS invite.
  shareToken?: string;
  eventId?: string;
  // The plaintext snapshot lane (non-account email/SMS recipients). Absent when
  // the snapshot is sealed to a known account (D3 — sealedEvent below); the
  // recipient's device decrypts sealedEvent back into this shape for display.
  event?: InvitationEventSnapshot;
  // The sealed snapshot lane (D3): an anonymous sealed box of the snapshot to the
  // recipient's identity key. Opaque; only the recipient opens it (lib/e2ee).
  sealedEvent?: string;
  // 'left'   = accepted then later left the event (copy deleted).
  // 'merged' = organizer and recipient have since joined one household, so this
  //            row was reconciled away (lib/invitationMerge). Terminal and inert;
  //            the server hides merged rows from both inboxes, so it is only ever
  //            seen by code that fetches a specific row.
  status: 'pending' | 'accepted' | 'declined' | 'left' | 'merged';
  respondedAt?: string;
  // The recipient's copy created on accept.
  acceptedEventId?: string;
  mergedAt?: string;
  createdAt: string;
}

// One invitation the merge pass has to retire: the organizer is now a housemate,
// so the cross-household copy is a duplicate of a record we already sync.
export interface InvitationToMerge {
  _id: string;
  eventId: string | null;
  acceptedEventId: string | null;
  status: 'pending' | 'accepted' | 'declined' | 'left';
  respondedAt?: string;
  organizerUserId: string;
  // Whether the organizer's original event still exists. False means our copy is
  // the only survivor and gets unlinked into a normal household event instead of
  // being dropped as a duplicate.
  sourceExists: boolean;
}

export const invitationsApi = {
  // Invitations addressed to me (New = pending, Replied = accepted/declined/left).
  list: () => api.get<EventInvitation[]>('/invitations'),
  // The organizer's invitee list for one of their events.
  sentForEvent: (eventId: string) =>
    api.get<EventInvitation[]>('/invitations/sent', { params: { eventId } }),
  // Resolve an invited email or phone so the organizer's device can decide
  // whether to seal the snapshot (D3: a non-null identityPublicKey means "seal
  // to this key") and whether to compose outreach at all (userExists means the
  // recipient gets push + in-app inbox instead — no composer). Phone lookups
  // return existence only.
  lookup: (recipient: { email?: string; phone?: string }) =>
    api.get<{ userExists: boolean; identityPublicKey: string | null }>('/invitations/lookup', { params: recipient }),
  // Address with either email or phone. Phone invites are recorded here but
  // texted from the sender's own device (see EventInviteesScreen). A known
  // account with keys gets `sealedEvent` (client-sealed) instead of `event`.
  // `guestListVisible` is sealed event content the server can't read off the
  // source, so the organizer's device snapshots it onto each invitation here
  // (the guest-list gate reads it there); omitting it means visible.
  send: (data: { eventId: string; email?: string; phone?: string; event?: InvitationEventSnapshot; sealedEvent?: string; guestListVisible?: boolean }) =>
    api.post<{ invitation: EventInvitation; userExists: boolean }>('/invitations', data),
  // Upgrade a claimed plaintext invite to a sealed one (D3): the recipient
  // re-seals the snapshot to its own key; the server drops the plaintext.
  seal: (id: string, sealedEvent: string) =>
    api.post<{ invitation: EventInvitation }>(`/invitations/${id}/seal`, { sealedEvent }),
  // Signal-parity C3b: the server can't read the sealed source, so the recipient's
  // device seals its OWN copy of the event (client-minted `_id` + `enc`, with
  // `invitationId` folded inside the ciphertext) and posts the opaque blob. The
  // server stores it as a Record it can't read, scoped to the recipient's
  // household. See InvitationsScreen for how the copy is built and sealed.
  accept: (id: string, copy: { _id: string; enc: unknown; keyVersion?: number }) =>
    api.post<{ invitation: EventInvitation; event: CalendarEvent }>(`/invitations/${id}/accept`, copy),
  decline: (id: string) => api.post<{ invitation: EventInvitation }>(`/invitations/${id}/decline`),
  // Recipient: leave an accepted event (deletes their copy).
  leave: (id: string) => api.post<{ invitation: EventInvitation }>(`/invitations/${id}/leave`),
  // Organizer: uninvite (deletes the invitation and, if accepted, the copy).
  revoke: (id: string) => api.delete(`/invitations/${id}`),
  // Recipient: who else is invited, if the event's guestListVisible flag allows.
  guests: (id: string) => api.get<InvitationGuestList>(`/invitations/${id}/guests`),
  // Invitations addressed to me whose organizer has since become a housemate —
  // the merge pass's work list (lib/invitationMerge). Recipient-driven: the
  // organizer's device is never handed any of this.
  toMerge: () => api.get<{ invitations: InvitationToMerge[] }>('/invitations/reconcile'),
  // Retire one reconciled invitation once the device has done the sealed half.
  // The server tombstones the now-duplicate copy and marks the row terminal.
  merge: (id: string) =>
    api.post<{ ok: boolean; merged: boolean; tombstoned: boolean }>(`/invitations/${id}/merge`),
};

// GET /invitations/:id/guests — visible:false means the organizer keeps the
// guest list private (or the source event is gone); guests is then empty.
export interface InvitationGuestList {
  visible: boolean;
  organizer?: { name?: string; email?: string };
  guests: { _id: string; toEmail?: string; toPhone?: string; status: EventInvitation['status'] }[];
}

// A purchasable AI-credit pack (consumable IAP). `price` is a USD display
// fallback — the store's localized price wins whenever RevenueCat packages load.
export interface CreditPack {
  productId: string;
  label: string;
  price: number;
  credits: number;
}

export interface CreditLedgerEntry {
  kind: 'purchase' | 'starter' | 'plan' | 'refund' | 'admin' | 'usage';
  // Signed, and may be fractional: usage debits are negative (a prorated call
  // can land between whole credits); refunds/adjustments can be negative too.
  credits: number;
  productId: string | null;
  // For `usage` rows: which action spent the credits ('chat', 'call', 'scan',
  // 'generation', 'manualParse', 'aiHelper'). Null on grants.
  action?: string | null;
  note: string | null;
  createdAt: string;
}

// The optional $4.99/month Calen AI plan (auto-renewable subscription). `price`
// is a USD display fallback — the store's localized price is authoritative.
// Granted credits are ordinary balance: they never expire and survive expiry.
export interface AiPlanStatus {
  active: boolean;
  productId: string;
  price: number;
  monthlyCredits: number;
  expiresAt: string | null;
}

export interface BillingStatus {
  // The per-user $4.99 one-time app unlock (drives the hard paywall).
  unlocked: boolean;
  unlockPrice: number; // USD display fallback
  // Free viewer mode: calendars shared with this user + pending calendar
  // invitations addressed to them. Either count > 0 routes a locked user to
  // the read-only viewer shell instead of the paywall (lib/viewerAccess).
  viewer?: { calendarCollaborations: number; pendingCalendarInvitations: number };
  // Prepaid AI-credit balance (1 credit = $0.01 retail). `creditBalance` is
  // whole credits and may be NEGATIVE after a refund — floor display at 0.
  // `unlimited` = exempt admin account (render "Unlimited", ignore balance).
  creditBalance: number;
  creditBalanceMc: number;
  lowBalance: boolean;
  unlimited: boolean;
  packs: CreditPack[];
  // Flat published credit prices per action (whole credits; `callPerMinute` is
  // per connected minute, prorated per second server-side). What the debits
  // actually charge — drives the "What things cost" card and pre-call hints.
  actionCosts?: Record<string, number>;
  // The optional monthly Calen AI plan (subscribe CTA / active state on the
  // Credits screen).
  aiPlan?: AiPlanStatus;
  // Per-action counts, always this user's own (analytics; enforcement is the
  // credit balance).
  usage: Record<string, number>;
  // Credits SPENT per action this period (drives the "Where your credits go"
  // card — actual debited spend, not counts; may be fractional). Keyed by the
  // same action names as `usage` ('chat', 'call', 'scan', …).
  spend?: Record<string, number>;
  usageScope: 'user';
  resetsAt?: string; // ISO instant of the next weekly ANALYTICS window reset (Wed 5PM ET)
  hasHousehold: boolean;
  // One-time feature-calendar add-ons this household owns (calendar ids:
  // 'recipes' | 'maintenance' | 'trips'). lib/addons caches this set on-device;
  // the feature UIs gate on it (client-side enforcement — the record store is
  // opaque to the server).
  addons?: string[];
  // Display catalog for the Add-ons screen. Prices are USD fallbacks — the
  // store's localized price wins whenever RevenueCat packages load.
  addonCatalog?: {
    items: { key: string; label: string; price: number; description: string }[];
    bundle: { label: string; price: number; description: string };
  };
}

export const billingApi = {
  status: () => api.get<BillingStatus>('/billing/status'),
  // `grants: true` returns purchases & grants only (usage debits excluded) and
  // a larger window — the History surfaces never itemize usage rows.
  ledger: (opts?: { grants?: boolean }) =>
    api.get<{ entries: CreditLedgerEntry[] }>('/billing/credits/ledger', {
      params: opts?.grants ? { grants: 1 } : undefined,
    }),
  // Claim a FREE add-on (catalog price 0 — Birthdays/Chores): included with
  // the app but opt-in, unlocked household-wide without a store purchase.
  claimAddon: (addon: string) => api.post<{ addons: string[] }>('/billing/addons/claim', { addon }),
};

// ----- Weather ---------------------------------------------------------------

export interface WeatherHour {
  time: string;
  hour: number;
  temperature: number;
  precipProbability: number;
  precipitation: number;
  weatherCode: number;
  description?: string;
}

export interface WeatherData {
  current: { temperature: number; weatherCode: number; description: string; humidity: number; windSpeed: number; precipitation: number };
  units: { temperature: string; wind: string; precipitation: string };
  forecast: { date: string; weatherCode: number; tempMax: number; tempMin: number; precipProbability: number; precipSum: number; goodWeather?: boolean; sunrise?: string; sunset?: string; hours?: WeatherHour[] }[];
}

export interface OutlookWeek {
  startDate: string;
  endDate: string;
  avgTempMax: number;
  avgTempMin: number;
  totalPrecip: number;
  rainyDays: number;
  yearsInSample?: number;
}

export const weatherApi = {
  get: () => api.get<WeatherData>('/weather'),
  range: (from: string, to: string) => api.get('/weather/range', { params: { from, to } }),
  outlook: () => api.get<{ weeks: OutlookWeek[] }>('/weather/outlook'),
};

// ----- Assistant phone calls (server: routes/calls.js) -----------------------
// Calls Calen placed via call_business. Listing refreshes pending calls from
// Vapi server-side. Outcomes are resolved on the event view — never surfaced
// on the Calen assistant view.

export interface PhoneCallRecord {
  _id: string;
  callId: string;
  eventId?: string;
  eventTitle?: string;
  eventDate?: string;
  // Local Y-M-D of the recurring-event occurrence this call was placed for;
  // null for non-recurring events (unscoped). Scopes the confirmed-cancel /
  // reschedule dimming to a single instance.
  occurrenceDate?: string | null;
  action: 'cancel' | 'reschedule';
  phone: string | null; // the business number dialed
  status: string; // queued/ringing/in-progress → ended | failed
  endedReason: string | null;
  summary: string | null;
  // Vapi's post-call judgement of the goal ("did the business confirm the
  // cancellation?"). Drives the Invitations outcome notice; a confirmed cancel
  // also sets the event's `cancelled` flag server-side.
  outcome: 'confirmed' | 'unconfirmed' | null;
  // The recipient asked, on this call, not to be called again — their number was
  // added to Calen's do-not-call list. The Interaction view shows an explicit
  // notice so the user knows why no future call will go to this number.
  dncCaptured: boolean;
  durationSeconds: number | null;
  seen: boolean;
  // Whether the outcome notice was dismissed in Invitations → New.
  acknowledged: boolean;
  createdAt: string;
}

export const callsApi = {
  list: () => api.get<PhoneCallRecord[]>('/calls'),
  // The Interaction view payload: the record, refreshed live from Vapi. No
  // transcript or recording exists anywhere — those artifacts are disabled at
  // the voice provider (spec: ai-assistant.md); the summary is the record.
  get: (id: string) => api.get<PhoneCallRecord>(`/calls/${id}`),
  // G1 alias link-back: chat-placed calls store an aliased event id (real ids
  // never reach the model); the assistant screen patches the real one on.
  link: (id: string, eventId: string) => api.patch<{ ok: boolean }>(`/calls/${id}/link`, { eventId }),
  // The event view's "Call to Cancel" card: sends the decrypted event snapshot
  // (E2EE households — the server can't read the stored row).
  cancelEvent: (event: { _id: string; title: string; startDate: string; phone: string }) =>
    api.post<PhoneCallRecord>('/calls/cancel-event', { event }),
  // The Event Action screen: Calen calls the business to cancel or reschedule.
  // `feeAccepted` = proceed even if the business charges a cancellation/
  // reschedule fee; `windows` (reschedule only) = pre-formatted date/time-window
  // labels in preference order. Sends the decrypted event snapshot, like
  // cancelEvent above. `shareContact` (per-call opt-in, spec ai-assistant.md)
  // lets the AI caller give the user's phone/email if the business asks to
  // verify identity — off by default; the caller always has the user's name.
  eventAction: (payload: {
    event: { _id: string; title: string; startDate: string; phone: string };
    action: 'cancel' | 'reschedule';
    feeAccepted: boolean;
    windows?: string[];
    shareContact?: boolean;
    // Recurring event: the local Y-M-D of the occurrence being cancelled/moved.
    occurrenceDate?: string;
  }) => api.post<PhoneCallRecord>('/calls/event-action', payload),
  ack: (id: string) => api.post<PhoneCallRecord>(`/calls/${id}/ack`),
  // Is this business number on the do-not-call list? The Event Action screen
  // checks before enabling its call button so a suppressed number is blocked
  // with a reason rather than failing on tap (spec: ai-assistant.md).
  suppressed: (phone: string) =>
    api.get<{ suppressed: boolean }>('/calls/suppressed', { params: { phone } }),
};

// Native push device registration (server: routes/notifications.js).
export const notificationsApi = {
  registerNative: (expoToken: string, platform: 'ios' | 'android', label?: string) =>
    api.post('/notifications/push/register-native', { expoToken, platform, label }),
  unregisterNative: (expoToken: string) =>
    api.post('/notifications/push/unregister-native', { expoToken }),
  // Tell the server this device schedules reminders on-device, so its push cron
  // skips this user (Phase 5).
  setLocalReminders: (enabled: boolean) =>
    api.post('/notifications/local-reminders', { enabled }),
  // Stateless household-event notify relay: the server verifies membership and
  // pushes the client-chosen strings; it stores nothing and can't read the event.
  eventRequest: (body: { toUserIds: string[]; title: string; body?: string; eventId: string }) =>
    api.post<{ sent: number }>('/notifications/event-request', body),
  eventResponse: (body: { toUserId: string; title: string; body?: string; eventId: string }) =>
    api.post<{ sent: number }>('/notifications/event-response', body),
};

// ----- AI form-fill assistant (server: routes/formAssist.js) -----------------
// A form describes its fields; the server asks Claude to map a plain-language
// request onto them and returns a patch keyed by field name.

export type FormAssistFieldType =
  | 'text'
  | 'number'
  | 'date'
  | 'time'
  | 'boolean'
  | 'select'
  | 'multiselect';

export interface FormAssistField {
  name: string;
  type: FormAssistFieldType;
  label: string;
  description?: string;
  options?: { label: string; value: string | number }[];
}

export interface FormAssistResponse {
  patch: Record<string, unknown>;
  note?: string;
}

export const formAssistApi = {
  fill: (data: {
    formType: string;
    fields: FormAssistField[];
    current: Record<string, unknown>;
    prompt: string;
    // When true, saved PROFESSIONAL contacts (name/service/address/phone) may
    // be attached so the assistant can resolve businesses the user names.
    // Friends/family are never included (spec: name-only in AI payloads).
    includeContacts?: boolean;
  }) => api.post<FormAssistResponse>('/form-assist', data),
};
