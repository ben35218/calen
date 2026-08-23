/**
 * One-time cleanup: removes the retired per-trip `color` field from every Trip
 * document.
 *
 * A trip has no color of its own any more — every trip surface (month bars and
 * dots, the day view's all-day chip, the trips list card, the widget) paints
 * with the Trips calendar's color, so changing that color recolors trips the
 * way changing any other calendar's color recolors its events. The schema no
 * longer declares the field, so this $unset stops stale values lingering in
 * Mongo (a plaintext top-level column; nothing sealed is touched).
 *
 * Dry-run (default, no writes):
 *   node src/scripts/stripTripColor.js
 *
 * Apply:
 *   node src/scripts/stripTripColor.js --apply
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const connectDB = require('../db');
const Trip = require('../models/Trip');

const DRY_RUN = !process.argv.includes('--apply');

async function run() {
  await connectDB();

  const filter = { color: { $exists: true } };
  const affected = await Trip.countDocuments(filter);
  console.log(`${affected} trip(s) still carry a color field.`);

  if (DRY_RUN) {
    console.log('Dry run — no changes written. Re-run with --apply to strip them.');
    process.exit(0);
  }

  const res = await Trip.updateMany(filter, { $unset: { color: '' } });
  console.log(`Stripped ${res.modifiedCount} trip(s).`);
  process.exit(0);
}

run().catch((err) => { console.error(err); process.exit(1); });
