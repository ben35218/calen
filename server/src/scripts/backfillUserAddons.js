/**
 * Move feature-calendar add-on ownership from the household onto its members:
 * `Household.addons` → `User.addons` for every current member. Safe to re-run
 * ($addToSet, never removes).
 *
 *   node src/scripts/backfillUserAddons.js                      # DRY RUN (default)
 *   node src/scripts/backfillUserAddons.js --commit             # write
 *   node src/scripts/backfillUserAddons.js --paid-to-owner      # see ATTRIBUTION
 *
 * RUN THIS BEFORE DEPLOYING the per-user add-on change, not after. It only
 * writes `User.addons`, which the current server ignores — so it is inert until
 * the new code ships. Deploy first and `GET /billing/status` unions an empty set
 * and every customer loses their add-ons until this runs.
 *
 * ATTRIBUTION — the one judgement call. The local data never recorded WHICH
 * member paid (the webhook resolved the buyer to a household and wrote only
 * there), so the true buyer isn't recoverable from this side. Two modes:
 *
 *   default          every current member is granted the household's whole set.
 *                    Preserves exactly today's visible entitlements, so nobody
 *                    loses paid access — but a shared household yields several
 *                    users who each OWN the add-on and all keep it if they later
 *                    split. Over-granting, safely.
 *
 *   --paid-to-owner  PAID add-ons go to the household owner only; FREE ones
 *                    (catalog price 0 — claimed, never bought) still go to every
 *                    member. The household keeps full access either way, since
 *                    the effect is the union across members — the difference is
 *                    only who KEEPS it on leaving. Right when the owner is the
 *                    buyer, which is the normal case for a household that formed
 *                    around one contact's purchase, and it avoids gifting a
 *                    permanent paid entitlement to someone who joined later
 *                    (an invited relative, a beta tester).
 *
 * Neither can be wrong in the direction that matters — no current member loses
 * ACCESS on migration under either mode.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const connectDB = require('../db');
const User = require('../models/User');
const Household = require('../models/Household');
const MonetizationConfig = require('../models/MonetizationConfig');

async function run() {
  const commit = process.argv.includes('--commit');
  const paidToOwner = process.argv.includes('--paid-to-owner');
  await connectDB();

  // Which keys are FREE (catalog price 0). Free add-ons are claimed, not bought,
  // so there is no buyer to attribute them to — every member may keep them.
  const config = await MonetizationConfig.getSingleton();
  const isFree = (key) => (config.addons?.items?.[key]?.price ?? 1) === 0;

  const households = await Household.find({ addons: { $exists: true, $ne: [] } }, 'name ownerId addons').lean();
  console.log(
    `${commit ? 'Backfilling' : 'DRY RUN —'} add-ons from ${households.length} household(s) onto their members`
    + `${paidToOwner ? ' (paid → owner only)' : ''}…`
  );

  let granted = 0;
  let skipped = 0;
  for (const hh of households) {
    const addons = [...new Set(hh.addons || [])];
    if (!addons.length) continue;
    const members = await User.find({ householdId: hh._id }, 'email addons').lean();
    if (!members.length) {
      // A memberless household still holding add-ons: nothing to grant them to.
      // Left alone rather than dropped — the row is the only record of the
      // purchase, and a member may yet rejoin (see households-sharing.md).
      console.log(`  – ${hh._id} [${addons.join(', ')}]: no members, skipped`);
      skipped += 1;
      continue;
    }
    for (const m of members) {
      const isOwner = String(m._id) === String(hh.ownerId);
      // In --paid-to-owner mode a non-owner receives only the free (claimed)
      // keys; the paid ones stay with the owner. Household ACCESS is unchanged
      // either way — status unions across members — only durable ownership moves.
      const forThisMember = paidToOwner && !isOwner ? addons.filter(isFree) : addons;
      const already = new Set(m.addons || []);
      const missing = forThisMember.filter((a) => !already.has(a));
      if (!missing.length) continue;
      if (commit) {
        await User.updateOne({ _id: m._id }, { $addToSet: { addons: { $each: missing } } });
      }
      console.log(`  ${commit ? '✓' : '·'} ${m.email} += [${missing.join(', ')}]`);
      granted += 1;
    }
  }

  console.log(
    `${commit ? `Done: ${granted} user(s) gained add-ons` : `DRY RUN complete: ${granted} user(s) would gain add-ons`}`
    + `, ${skipped} memberless household(s) skipped.`
  );
  if (!commit) console.log('Re-run with --commit to write.');
  process.exit(0);
}

run().catch((err) => { console.error(err); process.exit(1); });
