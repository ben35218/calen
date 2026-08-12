// Shopper-facing names for the organized grocery list. Shared between the
// server (which normalizes the AI organize response) and the mobile app (which
// matches a saved organized list against the week's raw items by cleaned name —
// the two sides MUST clean identically or every reconcile misfiles rows).
//
// Recipe ingredients are written for *cooking* ("garlic cloves, minced",
// "fresh basil leaves"), but a shopping list is read while walking an aisle:
// the prep clause is noise, and the name should look like a label. The AI
// organize pass is asked for this shape, but a model is not reliable about
// casing or about dropping every prep tail, so the result is normalized here
// too — the prompt sets the intent, this makes it deterministic.
//
// The casing half of that (`titleCase`) is also what recipe ingredient names go
// through (mobile/src/lib/recipeNames.ts), so a recipe's "olive oil" and the
// grocery list's "Olive Oil" can't disagree about how a name is written.

// Dropped from the front of a name: "fresh basil" -> "Basil".
const LEADING_NOISE = new Set([
  'fresh', 'freshly', 'finely', 'roughly', 'coarsely', 'thinly', 'lightly',
  'chopped', 'minced', 'diced', 'sliced', 'shredded', 'grated', 'crushed',
  'peeled', 'seeded', 'cored', 'trimmed', 'melted', 'softened', 'rinsed',
  'drained', 'thawed', 'beaten', 'cubed', 'halved', 'quartered', 'julienned',
  'torn', 'pitted', 'stemmed', 'washed', 'uncooked', 'cooked',
]);

// Dropped from the end of a name. The prep participles repeat (they appear on
// either side), plus the "form" words that describe how an herb arrives rather
// than what to buy: "basil leaves" -> "Basil".
const TRAILING_NOISE = new Set([
  ...LEADING_NOISE,
  'leaves', 'leaf', 'sprigs', 'sprig', 'divided', 'packed', 'optional',
  'garnish', 'taste',
]);

// Lowercase inside a title unless they lead it.
const MINOR_WORDS = new Set(['a', 'an', 'and', 'at', 'for', 'in', 'of', 'or', 'the', 'to', 'with']);

// Uppercase the word's first *letter*, wherever it sits — "(extra" -> "(Extra",
// and an accented lead letter still capitalizes. Same length in as out, so a
// controlled text input never jumps the caret. (`c.toLowerCase() !==
// c.toUpperCase()` is the letter test that doesn't need a Unicode property
// escape — Hermes is not reliable about those.)
function capitalize(word) {
  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    if (c.toLowerCase() !== c.toUpperCase()) return word.slice(0, i) + c.toUpperCase() + word.slice(i + 1);
  }
  return word;
}

// Title-case one whitespace-delimited token, hyphen segments included
// ("half-and-half" -> "Half-and-Half"). A part that already carries a capital
// anywhere is left exactly as written: "BBQ", "McCormick", and "5-Spice" are all
// things a re-case would damage, and none of them are what this pass is for —
// what it fixes is all-lowercase text (what a model or a hurried typist emits).
function titleToken(token, isFirst) {
  return token
    .split('-')
    .map((part, i) => {
      if (!part || part.toLowerCase() !== part) return part;
      if (MINOR_WORDS.has(part) && !(isFirst && i === 0)) return part;
      return capitalize(part);
    })
    .join('-');
}

// "extra virgin olive oil" -> "Extra Virgin Olive Oil". A display-casing pass
// only: nothing is added, dropped, or re-spaced (unlike `shopperName`, which
// also strips the prep clause), so it is safe on text the user is still typing
// and safe to re-apply to its own output.
function titleCase(raw) {
  if (typeof raw !== 'string') return '';
  let leading = true;
  return raw
    .split(' ')
    .map((token) => {
      if (!token) return token;
      const out = titleToken(token, leading);
      leading = false;
      return out;
    })
    .join(' ');
}

// "garlic cloves, minced" -> "Garlic Cloves"; "fresh basil leaves" -> "Basil".
// Never strips a name down to nothing: the noise lists only apply while at
// least one word would survive, so "Fresh" or "Leaves" on its own is kept.
function shopperName(raw) {
  if (typeof raw !== 'string') return '';
  const clean = (x) => x.replace(/\s+/g, ' ').trim();
  // "basil (fresh)" -> parenthetical prep; "garlic cloves, minced" and
  // "onion - diced" -> prep clause. A name that is *only* a clause separator
  // plus prep falls through to its first non-empty segment rather than nothing.
  const segments = raw
    .replace(/\([^)]*\)/g, ' ')
    .split(/[,;]|\s+[–—-]\s+/)
    .map(clean)
    .filter(Boolean);
  const s = segments[0] ?? '';

  let words = s.split(' ').filter(Boolean);
  while (words.length > 1 && LEADING_NOISE.has(words[0].toLowerCase())) words.shift();
  while (words.length > 1 && TRAILING_NOISE.has(words[words.length - 1].toLowerCase())) words.pop();

  return words.map((w, i) => titleToken(w, i === 0)).join(' ');
}

// Spoon units are always abbreviated on the list — "2 tbsp" reads at a glance
// where "2 tablespoons" eats the row. Recipes spell them a dozen ways
// (tablespoon/Tablespoons/tbs/Tbsp.), so every spelling collapses to one. The
// single-letter forms (T vs t) are deliberately left alone: they're ambiguous,
// and guessing wrong turns a teaspoon into a tablespoon.
const SPOON_UNITS = [
  [/\b(?:tablespoons?|tablespoonfuls?|tbsps?|tbs|tbls|tblsps?)\b\.?/gi, 'tbsp'],
  [/\b(?:teaspoons?|teaspoonfuls?|tsps?|tspns?)\b\.?/gi, 'tsp'],
];

// "2 Tablespoons" -> "2 tbsp". Everything else in the amount rides through
// untouched — this is a unit spelling pass, not a measurement parser.
function shopperAmount(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw;
  for (const [pattern, short] of SPOON_UNITS) s = s.replace(pattern, short);
  return s.replace(/\s+/g, ' ').trim();
}

// Rewrite an organized list in place-safe fashion: every item name becomes its
// shopper name, every amount its short-unit form, and items that collapse onto
// the same name inside a section are merged (their amounts joined) so the
// cleanup can't produce a visible duplicate row. Amounts are shortened *before*
// the merge compares them, so "2 tablespoons" and "2 tbsp" dedupe as one.
function normalizeOrganizedList(organized) {
  if (!organized || !Array.isArray(organized.categories)) return organized;
  return {
    ...organized,
    categories: organized.categories.map((cat) => {
      const merged = new Map();
      for (const item of Array.isArray(cat?.items) ? cat.items : []) {
        const name = shopperName(item?.name);
        if (!name) continue;
        const key = name.toLowerCase();
        const amount = shopperAmount(item?.amount);
        const seen = merged.get(key);
        if (!seen) {
          merged.set(key, { ...item, name, amount });
        } else if (amount && !seen.amount.split(', ').includes(amount)) {
          seen.amount = seen.amount ? `${seen.amount}, ${amount}` : amount;
        }
      }
      return { ...cat, items: [...merged.values()] };
    })
    // A section with nothing in it is not a shopping stop. The household's
    // section order constrains the model to a fixed list, so it routinely
    // returns sections the week's meals never filled (and the name cleanup can
    // empty one on its own) — a bare "Bakery" header over no rows reads as a
    // list that failed to load.
    .filter((cat) => cat.items.length > 0),
  };
}

module.exports = { titleCase, shopperName, shopperAmount, normalizeOrganizedList };
