/**
 * C3b DATA MIGRATION (Signal-parity C3 store cutover) — move the per-collection
 * content backlog into the unified opaque `Record` store.
 *
 * After the code cutover (writes+reads go through /records), the ~9 author-hidden
 * content collections' EXISTING rows still live in their own Mongo tables — where
 * the collection type leaks from the table name. This script copies each row's
 * ciphertext (`enc`) + routing (householdId/userId/keyVersion/timestamps, and the
 * D1/D2 resource lane derived from `enc.ks`) into a `Record`, keyed by the SAME
 * `_id`, so nothing else has to be re-pointed. It does NOT drop the old tables —
 * that is the LAST step (scripts/dropContentCollections.js), run only after the
 * v1→v2 re-seal backlog (DROP_FIELDS_VERSION 4) has drained, since the re-seal
 * pass reads the still-present old tables to fold the now-sealed routing columns
 * (calendarType/recurrence/reminders/…) into the v2 ciphertext.
 *
 *   node src/scripts/migrateToRecords.js                 # DRY RUN (all households)
 *   node src/scripts/migrateToRecords.js --commit        # perform it
 *   node src/scripts/migrateToRecords.js <householdId> [--commit]   # one household
 *
 * Idempotent: a Record with a given `_id` is upserted, so a second run re-copies
 * the current source row (last-write-wins) rather than duplicating it. Copying,
 * not moving, keeps the migration safe to re-run and the old rows readable by the
 * re-seal pass until the final drop.
 *
 * The logic lives in `migrateToRecords()` (exported, integration-tested); this
 * file doubles as the thin CLI.
 */
const mongoose = require('mongoose');
const Record = require('../models/Record');

// The author-hidden content set — exactly the collections whose type C3b hides.
// Trip / TripItem are NOT migrated: they stay their own collections (their
// plaintext userId is load-bearing cross-household routing for the D2 shared
// lane — the documented C4 deviation), as do the other non-content models
// (CustomCalendar, PhoneCall, Property, Manual, Receipt, EventInvitation, key
// envelopes). Mirrors e2eePolicy.AUTHOR_HIDDEN.
const MIGRATE_MODELS = {
  CalendarEvent:  require('../models/CalendarEvent'),
  Contact:         require('../models/Contact'),
  MaintenanceTask:require('../models/MaintenanceTask'),
  Chore:          require('../models/Chore'),
  Recipe:         require('../models/Recipe'),
  Item:           require('../models/Item'),
  OdometerLog:    require('../models/OdometerLog'),
  RecipeSchedule: require('../models/RecipeSchedule'),
  Category:       require('../models/Category'),
};

// Derive the D1/D2 resource lane from a source row. Only resource-sealed records
// (enc.ks) carry a scope; an HDK record has none. The resource id is already a
// plaintext routing field on the source (no NEW identifier leaks):
//   - a CalendarKey-sealed event (ks:'cal') → the calendar it lives on
//     (calendarType, a globally-unique `custom-<slug>` key);
//   - a TripKey-sealed record (ks:'trip') would map by tripId, but no migrated
//     collection is trip-scoped (Trip/TripItem stay), so this arm is defensive.
// version = the row's keyVersion, which for a resource-sealed row IS the
// resource-key version (see models/encFields.js).
function deriveScope(row) {
  const ks = row.enc?.ks;
  if (ks === 'cal' && row.calendarType) {
    return { kind: 'calendar', resource: String(row.calendarType), version: row.keyVersion };
  }
  if (ks === 'trip' && row.tripId) {
    return { kind: 'trip', resource: String(row.tripId), version: row.keyVersion };
  }
  return undefined;
}

// Build the opaque Record document from a source content row. Only routing +
// ciphertext — never a content column, and never the collection type.
function toRecordDoc(row) {
  const doc = {
    _id: row._id,
    userId: row.userId,
    householdId: row.householdId,
    keyVersion: row.keyVersion,
    enc: row.enc && row.enc.ct ? {
      alg: row.enc.alg, nonce: row.enc.nonce, ct: row.enc.ct,
      ...(row.enc.ks ? { ks: row.enc.ks } : {}),
    } : undefined,
    deleted: false,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  const scope = deriveScope(row);
  if (scope) doc.scope = scope;
  return doc;
}

// Copy every source row into Record (upsert by _id). Returns per-collection
// counts. `filter` scopes to one household when a householdId is given.
async function migrateToRecords({ householdId = null, commit = false, log = () => {} } = {}) {
  const filter = householdId ? { householdId: new mongoose.Types.ObjectId(householdId) } : {};
  const perCollection = {};
  let total = 0;
  for (const [collection, Model] of Object.entries(MIGRATE_MODELS)) {
    const rows = await Model.find(filter).lean();
    perCollection[collection] = rows.length;
    total += rows.length;
    if (!commit || !rows.length) continue;
    const ops = rows.map((row) => ({
      replaceOne: {
        filter: { _id: row._id },
        replacement: toRecordDoc(row),
        upsert: true,
      },
    }));
    // Chunk so a very large household doesn't build one giant bulk op.
    for (let i = 0; i < ops.length; i += 1000) {
      await Record.bulkWrite(ops.slice(i, i + 1000), { ordered: false, timestamps: false });
    }
  }
  log(`${commit ? 'Migrated' : 'Would migrate'} ${total} rows into Record`);
  for (const [c, n] of Object.entries(perCollection)) if (n) log(`  ${c}: ${n}`);
  return { total, perCollection, committed: commit };
}

async function runCli() {
  require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
  const connectDB = require('../db');
  const arg = process.argv[2];
  const householdId = arg && !arg.startsWith('--') ? arg : null;
  const commit = process.argv.includes('--commit');
  if (householdId && !mongoose.isValidObjectId(householdId)) {
    console.error('usage: node src/scripts/migrateToRecords.js [<householdId>] [--commit]');
    process.exit(1);
  }
  await connectDB();
  try {
    await migrateToRecords({ householdId, commit, log: console.log });
    process.exit(0);
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}

if (require.main === module) {
  runCli().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { migrateToRecords, toRecordDoc, deriveScope, MIGRATE_MODELS };
