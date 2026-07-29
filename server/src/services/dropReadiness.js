// §9 drop readiness gate (pure logic, unit-tested).
//
// A household can have its plaintext dropped (records become truly private) only
// when EVERY member has enrolled keys and holds a HouseholdKeyEnvelope for the
// current HDK version — otherwise a member would be locked out of the data after
// the drop. This module is pure so it can be tested without a DB; the script /
// route feed it the fetched rows. See docs/E2EE-SYNC-PLAN.md §9 / §9.2.

// Per-collection **content** fields that are sealed into `enc` and therefore
// safe to null at the drop. Mirrors the client encrypt-subsets exactly (mobile/
// src/lib/encSubsets.ts — the fields the client puts in `enc`).
//
// Signal-parity C3b (opaque store cutover): the 9 author-hidden content
// collections migrate into the unified `Record` store, which keeps NO content or
// routing column. So EVERY field those collections carry — including what was
// once plaintext routing/scheduling (calendarType, recurrence, foreign keys,
// reminder config, active, priority, …) — now rides in `enc`, and is listed here
// so the re-seal + re-drop backfill (DROP_FIELDS_VERSION 4) folds it into the v2
// ciphertext before the old tables are dropped. The ONLY columns kept plaintext
// are the Record store keys (userId/householdId/keyVersion/enc/scope/timestamps/
// deleted) and server-scheduler-only state (reminderAt/reminderSentAt/alert2At/
// alert2SentAt — the scheduler is dormant post-drop, no client reads them).
// Trip/TripItem/Household are NOT migrated (they stay per-collection), so their
// subsets are unchanged.
const DROP_FIELDS = {
  CalendarEvent:  ['calendarType', 'title', 'description', 'location', 'placeId', 'url', 'phone',
                   'startDate', 'endDate', 'allDay', 'travelMinutes', 'travelDistanceKm',
                   'reminderMinutes', 'alert2Minutes', 'alertAudience', 'guestListVisible',
                   'invitationId', 'cancelled', 'recurrence'],
  Person:         ['type', 'name', 'relationship', 'birthday', 'notes', 'address',
                   'businessName', 'phone', 'email', 'accountId', 'deviceContactId'],
  MaintenanceTask:['itemId', 'categoryId', 'title', 'icon', 'description', 'instructions', 'recurrence',
                   'estimatedDurationMins', 'estimatedCost', 'priority', 'seasonal', 'lastCompletedAt',
                   'nextDueDate', 'reminderDaysBefore', 'alert2DaysBefore', 'reminderTime', 'alertAudience',
                   'alertUserIds', 'active', 'templateId', 'intervalKm', 'lastServiceKm', 'nextDueKm'],
  Chore:          ['title', 'instructions', 'description', 'recurrence', 'assignedTo', 'nextDueDate',
                   'reminderDaysBefore', 'alert2DaysBefore', 'reminderTime', 'alertAudience', 'active', 'templateId', 'icon'],
  Recipe:         ['title', 'description', 'source', 'sourceUrl', 'imageUrl', 'servings', 'prepTimeMins',
                   'cookTimeMins', 'ingredients', 'instructions', 'instructionIngredients',
                   'instructionTimers', 'tags'],
  Trip:           ['name', 'destination', 'notes'],
  TripItem:       ['title', 'location', 'url', 'phone', 'notes', 'details'],
  Item:           ['name', 'categoryId', 'propertyId', 'serviceProId', 'type', 'manufacturer',
                   'modelNumber', 'serialNumber', 'location', 'notes', 'customFields', 'photoRef',
                   'autoLookupManual'],
  OdometerLog:    ['itemId', 'reading', 'recordedAt', 'notes'],
  RecipeSchedule: ['recipeId', 'scheduledDate', 'servings', 'notes'],
  Category:       ['parentId', 'name', 'icon', 'color', 'sortOrder'],
  // name joined homeAddress in the sealed settings blob (Signal-parity C2);
  // invitation emails switched to sender-name framing.
  Household:      ['homeAddress', 'name'],
};

// The DROP_FIELDS schema version. Bumped whenever fields are ADDED to DROP_FIELDS
// (a household dropped under an older version still has those newer columns in
// plaintext). A committed drop stamps `Household.dropFieldsVersion` with this, so
// the re-seal + re-drop backfill (scripts/reDropPlaintext.js) can tell which
// already-active households predate the current field set and must be migrated.
//
//   v1 — original drop (title/description/…, homeAddress, per-collection content)
//   v2 — Signal-parity pass 2 ADDED: MaintenanceTask/Chore.nextDueDate (D4),
//        OdometerLog.reading+notes, RecipeSchedule.notes, Category.name (D5),
//        Household.name (C2)
//   v3 — Signal-parity C4 ADDED: the member-granular plaintext `userId` (author)
//        on HDK-sealed records of the author-hidden collections. Not a DROP_FIELDS
//        content column (it's nulled by a dedicated author-null step in the drop /
//        re-drop, gated on `enc.ks` absent), but it bumps the version so already-
//        active households re-seal their author into `enc` before the null.
//   v4 — Signal-parity C3b (opaque store cutover) ADDED, for the 9 migrated
//        collections, every column that was still plaintext routing/scheduling
//        (calendarType, recurrence, foreign keys, reminder config, active,
//        priority, dates, …) — the unified `Record` store keeps none of them, so
//        they seal into the v2 ciphertext. Bumping to 4 makes every already-active
//        household re-run the re-seal-all pass, folding those columns into `enc`
//        (and upgrading any lingering v1 envelope to v2) before the per-collection
//        tables are dropped. NEVER bump this without the reseal wired: dual-accept
//        means nothing REQUIRES v2, so a premature bump is a no-op reseal cycle.
const DROP_FIELDS_VERSION = 4;

// Compare dotted numeric versions ("1.4.0" vs "1.10.2"). Returns -1/0/1.
// Non-numeric/missing segments count as 0. Used for the min-app-version gate.
function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// A member's reported client version satisfies the gate when it's >= the
// required minimum. An unset requirement passes everyone; an unset client
// version (member hasn't reported one) fails so we don't drop on unknown apps.
function versionSatisfied(clientVersion, minAppVersion) {
  if (!minAppVersion) return true;
  if (!clientVersion) return false;
  return compareVersions(clientVersion, minAppVersion) >= 0;
}

function computeReadiness({ members = [], envelopes = [], currentKeyVersion = 0, minAppVersion = null }) {
  const perMember = members.map((m) => {
    const enrolled = !!m.identityPublicKey;
    const hasEnvelope = envelopes.some(
      (e) => String(e.userId) === String(m._id) && Number(e.keyVersion) === Number(currentKeyVersion),
    );
    const versionOk = versionSatisfied(m.clientVersion, minAppVersion);
    return { userId: String(m._id), email: m.email, enrolled, hasEnvelope, clientVersion: m.clientVersion || null, versionOk };
  });

  const reasons = [];
  if (!(currentKeyVersion >= 1)) reasons.push('household has no HDK yet (currentKeyVersion is 0)');
  if (!members.length) reasons.push('household has no members');
  for (const pm of perMember) {
    if (!pm.enrolled) reasons.push(`${pm.email || pm.userId} has not enrolled keys`);
    else if (!pm.hasEnvelope) reasons.push(`${pm.email || pm.userId} has no key envelope for v${currentKeyVersion}`);
    if (minAppVersion && !pm.versionOk) {
      reasons.push(`${pm.email || pm.userId} is on app ${pm.clientVersion || 'unknown'} (needs ${minAppVersion})`);
    }
  }

  return {
    ready:
      currentKeyVersion >= 1 &&
      members.length > 0 &&
      perMember.every((pm) => pm.enrolled && pm.hasEnvelope && pm.versionOk),
    currentKeyVersion,
    minAppVersion: minAppVersion || null,
    perMember,
    reasons,
  };
}

// The $unset spec to null a collection's plaintext content columns at the drop.
function dropUnsetFor(collection) {
  const fields = DROP_FIELDS[collection];
  if (!fields) return null;
  const unset = {};
  for (const f of fields) unset[f] = '';
  return unset;
}

module.exports = { computeReadiness, dropUnsetFor, DROP_FIELDS, DROP_FIELDS_VERSION, compareVersions, versionSatisfied };
