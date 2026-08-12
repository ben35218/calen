/**
 * §9 PLAINTEXT DROP — the point of no return. For one household, verify readiness,
 * confirm every content record already carries ciphertext, then null the plaintext
 * content columns and set `Household.e2eeActive = true`. After this the server can
 * no longer read the household's content — the E2EE boundary is live.
 *
 *   node src/scripts/dropPlaintext.js <householdId>            # DRY RUN (default)
 *   node src/scripts/dropPlaintext.js <householdId> --commit   # perform the drop
 *
 * Dry run is read-only: it prints readiness + how many records would be nulled.
 * --commit is IRREVERSIBLE. Run the dry run first, and verify on-device that an
 * unlocked member can still read everything (see docs/E2EE-SYNC-PLAN.md §9.2)
 * BEFORE committing.
 *
 * The logic lives in `dropPlaintext()` (exported, integration-tested over an
 * in-memory MongoDB); this file doubles as the thin CLI around it.
 */
const mongoose = require('mongoose');
const Household = require('../models/Household');
const User = require('../models/User');
const HouseholdKeyEnvelope = require('../models/HouseholdKeyEnvelope');
const Record = require('../models/Record');
const AuditLog = require('../models/AuditLog');
const { computeReadiness, dropUnsetFor, DROP_FIELDS_VERSION } = require('../services/dropReadiness');
const { AUTHOR_HIDDEN } = require('../services/e2eePolicy');
const { sharedTripIds, excludeSharedFilter } = require('../services/tripSharing');
const { outsideSharedCalendarKeys, excludeOutsideCalendarFilter } = require('../services/calendarSharing');
const CustomCalendar = require('../models/CustomCalendar');

// Content collections scoped by userId. Household is handled separately (by _id).
const MODELS = {
  CalendarEvent:  require('../models/CalendarEvent'),
  Contact:         require('../models/Contact'),
  MaintenanceTask:require('../models/MaintenanceTask'),
  Chore:          require('../models/Chore'),
  Recipe:         require('../models/Recipe'),
  Trip:           require('../models/Trip'),
  TripItem:       require('../models/TripItem'),
  Item:           require('../models/Item'),
  // Signal-parity D5 (thin collections).
  OdometerLog:    require('../models/OdometerLog'),
  RecipeSchedule: require('../models/RecipeSchedule'),
  Category:       require('../models/Category'),
};

// Run the drop (or its dry run) against the current mongoose connection.
// Returns { status, ... } instead of exiting so tests can assert on it:
//   already-active | not-ready | stragglers | dry-run | committed
async function dropPlaintext(householdId, { commit = false, log = () => {} } = {}) {
  const hh = await Household.findById(householdId);
  if (!hh) throw new Error('No such household');
  if (hh.e2eeActive) {
    log('Household is already E2EE-active. Nothing to do.');
    return { status: 'already-active' };
  }

  const members = await User.find({ householdId: hh._id });
  const memberIds = members.map((m) => m._id);
  const envelopes = await HouseholdKeyEnvelope.find({ householdId: hh._id });

  log(`\nHousehold "${hh.name || hh._id}" (${hh._id}) — HDK v${hh.currentKeyVersion}, ${members.length} member(s)\n`);

  // 1) Readiness gate.
  const readiness = computeReadiness({
    members,
    envelopes,
    currentKeyVersion: hh.currentKeyVersion,
    minAppVersion: process.env.E2EE_MIN_APP_VERSION || null,
  });
  log(`Readiness: ${readiness.ready ? 'READY' : 'NOT READY'}`);
  readiness.reasons.forEach((r) => log('  - ' + r));
  if (!readiness.ready) {
    log('\nAborting — resolve the above first.');
    return { status: 'not-ready', readiness };
  }

  // 2) Straggler check — every content record must already carry ciphertext,
  // EXCEPT shared trips (and their items): those stay plaintext on purpose so
  // cross-household collaborators can read them, so they're exempt here and in
  // the commit below. See services/tripSharing.js / §6.
  let stragglers = 0;
  const scope = { userId: { $in: memberIds } };
  const sharedIds = await sharedTripIds(MODELS.Trip, memberIds);
  if (sharedIds.length) log(`  (${sharedIds.length} shared trip(s) + their items are plaintext-exempt)\n`);
  // Events on outside-shared custom calendars are likewise plaintext-exempt
  // (§9.5) — collaborators outside the household hold no HDK.
  const sharedCalKeys = await outsideSharedCalendarKeys(CustomCalendar, memberIds);
  if (sharedCalKeys.length) log(`  (events on ${sharedCalKeys.length} outside-shared calendar(s) are plaintext-exempt)\n`);
  for (const [name, Model] of Object.entries(MODELS)) {
    // C3b: author-hidden content lives in the unified `Record` store, and the
    // sealer (/e2ee/seal) writes ciphertext THERE — never back to these legacy
    // per-collection tables. So the gate must NOT count author-hidden legacy
    // rows: an un-migrated / orphaned legacy row (e.g. a pre-mandate seeded
    // Category with no Record twin) can never be sealed in place, so counting it
    // would deadlock activation forever — the count could never reach zero. The
    // legacy tables are migrated + dropped out-of-band (dropContentCollections);
    // author-hidden stragglers are counted from `Record` below. Trip/TripItem
    // stay their own collections (the C4 routing deviation), so they're checked
    // here in place.
    if (AUTHOR_HIDDEN.has(name)) continue;
    const exempt = { ...excludeSharedFilter(name, sharedIds), ...excludeOutsideCalendarFilter(name, sharedCalKeys) };
    const [sealed, missing] = await Promise.all([
      Model.countDocuments({ ...scope, enc: { $exists: true } }),
      Model.countDocuments({ ...scope, ...exempt, enc: { $exists: false } }),
    ]);
    stragglers += missing;
    log(`  ${name.padEnd(16)} ${sealed} sealed, ${missing} missing enc`);
  }
  // Author-hidden content, from the Record store (the C3b source of truth). A
  // straggler = a household record with no ciphertext yet. Scoped by householdId
  // (every Record carries it), so orphans from other/dead households can't leak
  // into this household's gate.
  const [recSealed, recMissing] = await Promise.all([
    Record.countDocuments({ householdId: hh._id, 'enc.ct': { $exists: true } }),
    Record.countDocuments({ householdId: hh._id, 'enc.ct': { $exists: false } }),
  ]);
  stragglers += recMissing;
  log(`  ${'Record'.padEnd(16)} ${recSealed} sealed, ${recMissing} missing enc`);
  // The household settings blob covers name + homeAddress (C2): any plaintext
  // there without a sealed blob blocks the drop until the client seals it (the
  // straggler pass PUTs the enc via /settings). NOTE: `hh.enc` is a mongoose
  // nested path — truthy ({}) even when unset — so test the ciphertext itself.
  const hhBlobSealed = !!hh.enc?.ct;
  const hhContentUnsealed = !!((hh.homeAddress || hh.name) && !hhBlobSealed);
  log(`  ${'Household'.padEnd(16)} name/location ${hhBlobSealed ? 'sealed' : (hhContentUnsealed ? 'NOT sealed' : 'none set')}`);
  if (hhContentUnsealed) stragglers++;

  if (stragglers > 0) {
    log(`\n${stragglers} record(s) still lack ciphertext. The owner's device must open + re-save them (or run the client re-encrypt pass) before the drop. Aborting.`);
    return { status: 'stragglers', stragglers, readiness };
  }

  if (!commit) {
    log('\nDRY RUN — nothing changed. Re-run with --commit to null the plaintext content columns and set e2eeActive.');
    log('IMPORTANT: verify on-device that an unlocked member reads everything first (§9.2). --commit is irreversible.');
    return { status: 'dry-run', readiness };
  }

  // 3) COMMIT — null plaintext content only where ciphertext exists.
  log('\nCOMMITTING drop…');
  const nulled = {};
  for (const [name, Model] of Object.entries(MODELS)) {
    const unset = dropUnsetFor(name);
    if (!unset) continue;
    // Signal-parity D1/D2: outside-shared calendar events AND shared trips/items
    // are NO LONGER exempt from the NULL step — a resource-sealed record (a
    // CalendarKey- or TripKey-sealed event/trip/item) carries `enc`, so `enc
    // exists` nulls its plaintext (correct — collaborators read it via the
    // resource key), while an un-migrated plaintext-lane record (no `enc`, exempt
    // in the straggler check above) is skipped by `enc exists`. The full
    // excludeSharedFilter retirement waits until zero plaintext-lane shared
    // records remain; for now the `enc exists` gate is the correct shield.
    const res = await Model.updateMany({ ...scope, enc: { $exists: true } }, { $unset: unset });
    nulled[name] = res.modifiedCount;
    log(`  ${name.padEnd(16)} nulled ${res.modifiedCount}`);
  }
  // Signal-parity C4 (hide record authorship): stamp the plaintext householdId on
  // every record so scoping survives the author null, THEN null the member-
  // granular plaintext `userId` on HDK-sealed records of the author-hidden
  // collections. Order matters — never null `userId` before `householdId` is set,
  // or the record becomes unscopable. A resource-sealed (`enc.ks` cal/trip) record
  // KEEPS its `userId` (a cross-household routing artifact — the §C4 deviation).
  for (const [name, Model] of Object.entries(MODELS)) {
    await Model.updateMany({ ...scope, householdId: { $exists: false } }, { $set: { householdId: hh._id } });
    if (AUTHOR_HIDDEN.has(name)) {
      const res = await Model.updateMany(
        { householdId: hh._id, enc: { $exists: true }, 'enc.ks': { $exists: false } },
        { $unset: { userId: '' } },
      );
      log(`  ${name.padEnd(16)} author-nulled ${res.modifiedCount}`);
    }
  }
  // C3b: author-hidden content lives in the `Record` store — the loop above only
  // still reaches Trip/TripItem (their tables stay; the 9 author-hidden per-
  // collection tables are dropped). Null the plaintext author `userId` on this
  // household's HDK-sealed Records too, so the server can't attribute a record to
  // a member (C4). Only HDK-sealed rows (`enc.ks` absent) — a resource-sealed
  // Record keeps `userId` (the shared-lane routing deviation). The author itself
  // is folded inside `enc` at write time on an active household
  // (e2eePolicy.stripSealedContent) / by the client reseal for pre-activation
  // rows; scoping survives because `householdId` is authoritative on every Record.
  const recNull = await Record.updateMany(
    { householdId: hh._id, 'enc.ct': { $exists: true }, 'enc.ks': { $exists: false }, userId: { $exists: true } },
    { $unset: { userId: '' } },
  );
  log(`  ${'Record'.padEnd(16)} author-nulled ${recNull.modifiedCount}`);
  // Household name + location (C2): lat/lon derive from homeAddress, so they go
  // with it; the sealed settings blob is now the only source of both.
  if (hh.enc?.ct) await Household.updateOne({ _id: hh._id }, { $unset: { homeAddress: '', lat: '', lon: '', name: '' } });
  // Stamp the DROP_FIELDS schema version so a household dropped now is never
  // flagged for the re-seal + re-drop backfill (its plaintext is fully current).
  await Household.updateOne({ _id: hh._id }, { $set: { e2eeActive: true, dropFieldsVersion: DROP_FIELDS_VERSION } });
  await AuditLog.create({ householdId: hh._id, event: 'plaintext_dropped', meta: { memberCount: members.length, keyVersion: hh.currentKeyVersion } });

  log('\nDONE. e2eeActive = true; plaintext content nulled. The E2EE boundary is now live for this household.');
  return { status: 'committed', nulled, readiness };
}

async function runCli() {
  require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
  const connectDB = require('../db');
  const householdId = process.argv[2];
  const commit = process.argv.includes('--commit');
  if (!householdId || !mongoose.isValidObjectId(householdId)) {
    console.error('usage: node src/scripts/dropPlaintext.js <householdId> [--commit]');
    process.exit(1);
  }
  await connectDB();
  try {
    const result = await dropPlaintext(householdId, { commit, log: console.log });
    process.exit(['not-ready', 'stragglers'].includes(result.status) ? 1 : 0);
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}

if (require.main === module) {
  runCli().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { dropPlaintext, MODELS };
