// Default maintenance categories, seeded per-user at registration. The lists
// live in shared/seed/defaultCategories.json so the mobile client-side seeder
// (Signal-parity D5: an E2EE-active household seeds ENCRYPTED categories from
// the same data) can never drift from the server seed.
//
// Register-time seeding stays plaintext on purpose (the P1 self-Contact
// pattern): a fresh household isn't e2eeActive yet, and the born-encrypted
// activation's straggler pass seals these rows before the drop nulls the names.
const { categories: defaultCategories, subcategories: defaultSubcategories } =
  require('../../shared/seed/defaultCategories.json');

async function seedDefaultCategories(userId) {
  const Category = require('./models/Category');
  const existing = await Category.countDocuments({ userId, parentId: null });
  if (existing > 0) return;
  await Category.insertMany(defaultCategories.map(c => ({ ...c, userId, parentId: null })));
}

async function seedDefaultSubcategories(userId) {
  const Category = require('./models/Category');
  const existingSubs = await Category.countDocuments({ userId, parentId: { $ne: null } });
  if (existingSubs > 0) return;

  const parents = await Category.find({ userId, parentId: null }).lean();
  const parentMap = new Map(parents.map(c => [c.name, c._id]));

  const toInsert = [];
  for (const [parentName, subs] of Object.entries(defaultSubcategories)) {
    const parentId = parentMap.get(parentName);
    if (!parentId) continue;
    subs.forEach(s => toInsert.push({ ...s, userId, parentId, icon: 'mdi-circle-small', color: '#9E9E9E' }));
  }
  if (toInsert.length) await Category.insertMany(toInsert);
}

module.exports = { seedDefaultCategories, seedDefaultSubcategories };
