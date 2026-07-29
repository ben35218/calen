/**
 * Grant (or deduct) AI credits for a user by email. Goes through the ledger
 * (kind: 'admin'), so it records a CreditLedger row and updates the user's
 * materialized creditBalanceMc atomically — same path as the admin web app.
 *
 *   node src/scripts/grantCredits.js user@example.com 500            # +500 credits
 *   node src/scripts/grantCredits.js user@example.com -100           # -100 credits
 *   node src/scripts/grantCredits.js user@example.com 500 "testing"  # with a note
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const connectDB = require('../db');
const User = require('../models/User');
const CreditLedger = require('../models/CreditLedger');
const { MC_PER_CREDIT } = require('../services/credits');

async function run() {
  const email = process.argv[2]?.toLowerCase();
  const credits = Number(process.argv[3]);
  const note = process.argv[4];
  if (!email || !Number.isFinite(credits) || credits === 0) {
    console.error('Usage: node src/scripts/grantCredits.js <email> <credits> [note]');
    process.exit(1);
  }

  await connectDB();

  const user = await User.findOne({ email });
  if (!user) {
    console.error(`No user found with email ${email}`);
    process.exit(1);
  }

  const deltaMc = Math.round(credits * MC_PER_CREDIT);
  const { balanceMc } = await CreditLedger.grant({
    userId: user._id,
    deltaMc,
    kind: 'admin',
    note: note || 'manual grant via grantCredits.js',
  });

  console.log(
    `Granted ${credits} credit(s) to ${email}. New balance: ` +
    `${Math.floor(balanceMc / MC_PER_CREDIT)} credits (${balanceMc} Mc).`
  );
  process.exit(0);
}

run().catch((err) => { console.error(err); process.exit(1); });
