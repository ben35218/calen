/**
 * Give every User a linked self-record in the People roster, copying their
 * profile fields (aboutMe → notes / birthday / home address) so the
 * account owner shows up as a "You" card alongside family & friends, shared
 * with the rest of the household. Safe to re-run (idempotent via accountId).
 *
 *   node src/scripts/backfillSelfPeople.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const connectDB = require('../db');
const User = require('../models/User');
const Person = require('../models/Person');

async function run() {
  await connectDB();
  const users = await User.find();
  console.log(`Backfilling self-records for ${users.length} user(s)…`);
  for (const user of users) {
    const self = await Person.ensureSelf(user);
    console.log(`  ✓ ${user.email} ← ${self.name} (${self._id})`);
  }
  console.log('Done.');
  process.exit(0);
}

run().catch((err) => { console.error(err); process.exit(1); });
