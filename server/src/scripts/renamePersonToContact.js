/**
 * Person → Contact rename: move the server-side names that are PERSISTED.
 *
 *   node src/scripts/renamePersonToContact.js            # DRY RUN (default)
 *   node src/scripts/renamePersonToContact.js --commit   # write
 *
 * RUN THIS BEFORE DEPLOYING the renamed server. Three things move:
 *
 *   1. the `people` collection → `contacts`. The Mongoose model is now
 *      `mongoose.model('Contact', …)`, which pluralizes to `contacts`; without
 *      this the legacy rows are simply not where the model looks. Under
 *      mandatory E2EE these rows are vestigial (content lives in the opaque
 *      `records` store), but the collection still backs `Contact.ensureSelf`'s
 *      pre-E2EE seed path and any household that has not yet dropped plaintext.
 *   2. `User.personId`   → `User.contactId`
 *   3. `ECard.personId`  → `ECard.contactId`
 *      plus `relatedNames[].personId` → `.contactId` on any plaintext contact
 *      rows (the SEALED copy of that field is handled on the client, in
 *      lib/contactFields — the server cannot read it).
 *
 * Ordering: if `contacts` already exists (a fresh deploy created it) the
 * collection rename is skipped rather than merged, and the run reports it —
 * merging two live collections is not something a migration should guess at.
 *
 * Idempotent: $rename on an absent field is a no-op, and the collection rename
 * is skipped once `people` is gone. Safe to re-run.
 */
const mongoose = require('mongoose');
require('dotenv').config();

const COMMIT = process.argv.includes('--commit');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const label = COMMIT ? '' : '[dry run] ';

  const names = (await db.listCollections().toArray()).map((c) => c.name);
  const hasPeople = names.includes('people');
  const hasContacts = names.includes('contacts');

  // 1. people → contacts
  if (!hasPeople) {
    console.log(`${label}collection: no 'people' collection — nothing to rename`);
  } else if (hasContacts) {
    const [p, c] = await Promise.all([
      db.collection('people').countDocuments(),
      db.collection('contacts').countDocuments(),
    ]);
    console.log(
      `${label}collection: BOTH 'people' (${p} docs) and 'contacts' (${c} docs) exist — ` +
      'refusing to merge. Inspect and consolidate by hand.',
    );
  } else {
    const n = await db.collection('people').countDocuments();
    console.log(`${label}collection: rename 'people' → 'contacts' (${n} docs)`);
    if (COMMIT) await db.collection('people').rename('contacts');
  }

  // 2. Top-level personId → contactId. $rename handles these directly.
  for (const collection of ['users', 'ecards']) {
    if (!names.includes(collection)) {
      console.log(`${label}${collection}: absent — skipped`);
      continue;
    }
    const n = await db.collection(collection).countDocuments({ personId: { $exists: true } });
    console.log(`${label}${collection}: $rename personId → contactId on ${n} doc(s)`);
    if (COMMIT && n) {
      await db.collection(collection).updateMany(
        { personId: { $exists: true } },
        { $rename: { personId: 'contactId' } },
      );
    }
  }

  // 3. relatedNames[].personId → .contactId on plaintext contact rows.
  // $rename cannot reach inside an array, so rewrite each affected doc. These
  // rows only exist pre-plaintext-drop, so the set is small; a loop is clearer
  // than the equivalent $map/$objectToArray aggregation pipeline.
  // After a committed rename the rows live in `contacts`; mid-dry-run they are
  // still in `people`, so read from whichever currently holds them.
  const rosterCollection = hasPeople && !COMMIT ? 'people' : 'contacts';
  if (!names.includes(rosterCollection) && !(rosterCollection === 'contacts' && hasPeople)) {
    console.log(`${label}${rosterCollection}: absent — skipped`);
  } else {
    const cursor = db.collection(rosterCollection).find({ 'relatedNames.personId': { $exists: true } });
    let n = 0;
    for await (const doc of cursor) {
      n++;
      if (!COMMIT) continue;
      const relatedNames = (doc.relatedNames || []).map((r) => {
        if (!r || r.personId === undefined) return r;
        const { personId, ...rest } = r;
        return { ...rest, contactId: personId };
      });
      await db.collection(rosterCollection).updateOne({ _id: doc._id }, { $set: { relatedNames } });
    }
    console.log(`${label}${rosterCollection}: relatedNames[].personId → .contactId on ${n} doc(s)`);
  }

  if (!COMMIT) console.log('\nDry run — nothing written. Re-run with --commit to apply.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
