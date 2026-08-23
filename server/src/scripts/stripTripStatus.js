/**
 * One-time cleanup: removes the retired trip `status` and `candidateRanges`
 * fields from every Trip document.
 *
 * Trip status (considering / booked / completed) was removed from the app —
 * trip surfaces derive everything from the date range now — and candidate
 * ranges were only reachable through the `considering` status. The schema no
 * longer declares either field, so this $unset stops stale values lingering
 * in Mongo (both were plaintext top-level columns; nothing sealed is touched).
 *
 * Dry-run (default, no writes):
 *   node src/scripts/stripTripStatus.js
 *
 * Apply:
 *   node src/scripts/stripTripStatus.js --apply
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const connectDB = require('../db');
const Trip = require('../models/Trip');

const DRY_RUN = !process.argv.includes('--apply');

async function run() {
  await connectDB();

  const filter = { $or: [{ status: { $exists: true } }, { candidateRanges: { $exists: true } }] };
  const affected = await Trip.countDocuments(filter);
  console.log(`${affected} trip(s) still carry a status or candidateRanges field.`);

  if (DRY_RUN) {
    console.log('Dry run — no changes written. Re-run with --apply to strip them.');
    process.exit(0);
  }

  const res = await Trip.updateMany(filter, { $unset: { status: '', candidateRanges: '' } });
  console.log(`Stripped ${res.modifiedCount} trip(s).`);
  process.exit(0);
}

run().catch((err) => { console.error(err); process.exit(1); });
