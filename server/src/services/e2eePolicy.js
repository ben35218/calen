// Mandatory-E2EE policy (pure, unit-tested). Single source of truth for "does
// this household have to be end-to-end encrypted?" — consumed by the born-
// encrypted onboarding finalize and the plaintext write-guard.
//
// E2EE is required for EVERY household. There is no per-household opt-out: the
// old `Household.e2eeExempt` grandfather flag was removed once all pre-mandate
// households were migrated. The only bypass left is the test-env one below, so
// the integration suite (which uses stand-in ciphertext, not real crypto) can
// keep exercising the plaintext paths.
function e2eeRequired(household) {
  // Under the integration suite the plaintext paths must keep working (stand-in
  // ciphertext, not real crypto), so E2EE is off by default in test. A single
  // opt-in flag lets the mandate tests turn enforcement on exactly as in
  // production without changing behaviour anywhere else.
  if (process.env.NODE_ENV === 'test' && process.env.E2EE_ENFORCE_IN_TEST !== '1') return false;
  return !!household;
}

// Should this plaintext content-create be rejected? True when the household is
// under the E2EE mandate but the create carries no ciphertext (`enc`) blob. The
// single gate every content-create route consults before writing plaintext.
function plaintextCreateBlocked(household, enc) {
  return e2eeRequired(household) && !enc;
}

// One user-facing message for a blocked plaintext write, so the copy (and the
// "update your app" hint the min-version gate implies) stays consistent.
const E2EE_REQUIRED_MESSAGE =
  'This account is end-to-end encrypted. Please update to the latest app version to save changes.';

// ── Steady-state write rule (Signal-parity pass-2 insert) ───────────────────
// The plaintext drop nulls content columns ONCE. Without this rule the dual-
// write clients keep sending plaintext columns and every create/update route
// re-persists them, so an e2eeActive household's new/edited records silently
// regain plaintext on the server. This closes that: once a household is
// e2eeActive, a write that carries ciphertext (`enc`) must NOT also store the
// plaintext content columns.
//
// It is deliberately a NO-OP in two cases, which keeps the two lanes the drop
// itself preserves working:
//   1. Before the drop (`!household.e2eeActive`) — the dual-write window still
//      needs plaintext for readiness verification and pre-enrollment reads.
//   2. Writes that carry NO `enc` — the shared-trip (§9.3) and outside-shared-
//      calendar (§9.5) plaintext lanes write without ciphertext so cross-
//      household collaborators (who hold no HDK) can read them; their plaintext
//      must survive.
// The columns nulled are exactly the drop's DROP_FIELDS for that collection, so
// the write rule and the drop can never disagree about what's content.
const { DROP_FIELDS } = require('./dropReadiness');

function hasCiphertext(enc) {
  return !!(enc && enc.ct);
}

// The sealed content columns this particular write must not persist, or [] when
// the rule is a no-op (see the two cases above).
function sealedContentFields(collection, household, enc) {
  if (!hasCiphertext(enc)) return [];
  // Signal-parity D1/D2: a resource-sealed record (any `enc.ks` — 'cal' for a
  // CalendarKey, 'trip' for a TripKey) is private by construction — readable only
  // via that resource key, never the server. Its plaintext is stripped
  // UNCONDITIONALLY, independent of the writer's household `e2eeActive` (a cross-
  // household collaborator may be writing from a household that isn't active yet).
  // This closes the §9.5 / §9.3 ongoing-plaintext-feed leaks.
  if (enc.ks) return DROP_FIELDS[collection] || [];
  if (!household || !household.e2eeActive) return [];
  return DROP_FIELDS[collection] || [];
}

// ── Author-hiding (Signal-parity C4) ────────────────────────────────────────
// The member-granular plaintext author. On an e2eeActive household an HDK-sealed
// record's author is sealed inside `enc` (client `sealNew`/`sealUpdate` inject an
// `author` field) and the plaintext column is nulled — the server then attributes
// the record only to `householdId`. A resource-scoped (`enc.ks` cal/trip) record
// KEEPS its plaintext `userId`: there it is a cross-household routing artifact for
// the shared lane, not private authorship (deviation, see the §C4 decision doc).
const AUTHOR_FIELD = 'userId';

// Collections whose HDK-sealed records hide the author. Trip/TripItem are
// excluded: their plaintext `userId` is load-bearing owner/collaborator routing
// for the D2 share flow (same spirit as the `ks` deviation) — hiding their
// author is a later cleanup. CalendarEvent's outside-shared (cal-sealed) events
// also keep `userId` via the `enc.ks` guard below; only its private HDK events
// hide it. Mirrors the AUTHOR_HIDDEN set the drop nulls.
const AUTHOR_HIDDEN = new Set([
  'CalendarEvent', 'Contact', 'MaintenanceTask', 'Chore', 'Recipe', 'Item',
  'OdometerLog', 'RecipeSchedule', 'Category',
]);

function stripsAuthor(collection, household, enc) {
  return !!(
    AUTHOR_HIDDEN.has(collection) &&
    household && household.e2eeActive && hasCiphertext(enc) && !enc.ks
  );
}

// Stamp the plaintext household attribution (C4). Every content write records
// which household it belongs to, so the server can scope by `householdId` once
// the author column is nulled. Backfills legacy records on edit; harmless (plain
// routing) before a household is e2eeActive. No-op for a solo user (no household).
function stampHousehold(household, data) {
  // Authoritative: always set from the requester's household, so a client can't
  // spoof `householdId` (some create routes spread `req.body` wholesale) to place
  // a record in — or read it out of — another household's scope.
  if (data && household && household._id != null) data.householdId = household._id;
  return data;
}

// Strip the sealed content keys from a plain create/update payload (mutates +
// returns it). `data.enc` is the ciphertext discriminator. Also stamps the C4
// household attribution and nulls the member-granular author on an HDK-sealed
// e2eeActive write.
function stripSealedContent(collection, household, data) {
  if (!data) return data;
  stampHousehold(household, data);
  for (const f of sealedContentFields(collection, household, data.enc)) delete data[f];
  if (stripsAuthor(collection, household, data.enc)) delete data[AUTHOR_FIELD];
  return data;
}

// Same rule for a mongoose document about to be `.save()`d: unset the paths so
// the persisted document loses the plaintext (assigning `undefined` makes save
// emit a `$unset`). Uses the doc's own `enc` as the discriminator.
function stripSealedDoc(collection, household, doc) {
  if (!doc) return doc;
  stampHousehold(household, doc);
  for (const f of sealedContentFields(collection, household, doc.enc)) doc[f] = undefined;
  if (stripsAuthor(collection, household, doc.enc)) doc[AUTHOR_FIELD] = undefined;
  return doc;
}

module.exports = {
  e2eeRequired,
  plaintextCreateBlocked,
  E2EE_REQUIRED_MESSAGE,
  sealedContentFields,
  stripSealedContent,
  stripSealedDoc,
  stripsAuthor,
  stampHousehold,
  AUTHOR_FIELD,
  AUTHOR_HIDDEN,
};
