/**
 * Grant (or revoke) the $4.99 one-time app unlock for a user by email — the same
 * effect as a RevenueCat purchase webhook or the admin override
 * POST /monetization-config/unlock. Per-USER (every member buys their own).
 * Useful as a tester escape hatch when the store/purchase flow isn't wired up yet.
 *
 *   node src/scripts/grantUnlock.js user@example.com          # grant unlock
 *   node src/scripts/grantUnlock.js user@example.com --revoke # revoke unlock
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const connectDB = require('../db');
const User = require('../models/User');

async function run() {
  const email = process.argv[2]?.toLowerCase();
  const revoke = process.argv.includes('--revoke');
  if (!email) {
    console.error('Usage: node src/scripts/grantUnlock.js <email> [--revoke]');
    process.exit(1);
  }

  await connectDB();

  const update = revoke
    ? { $set: { appUnlocked: false } }
    : { $set: { appUnlocked: true, appUnlockedAt: new Date() } };
  const res = await User.updateOne({ email }, update);
  if (res.matchedCount === 0) {
    console.error(`No user found with email ${email}`);
    process.exit(1);
  }
  console.log(`Set appUnlocked=${!revoke} for ${email}.`);
  process.exit(0);
}

run().catch((err) => { console.error(err); process.exit(1); });
