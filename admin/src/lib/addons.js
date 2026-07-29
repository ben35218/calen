// Display metadata for the feature-calendar add-on keys stored in
// Household.addons. Labels mirror the MonetizationConfig catalog defaults;
// `paid` distinguishes store purchases from the free opt-in claims. Unknown
// keys (a future catalog addition) fall back to the raw key so nothing hides.
export const ADDON_META = {
  recipes:     { label: 'Meals',       paid: true },
  maintenance: { label: 'Maintenance', paid: true },
  trips:       { label: 'Trips',       paid: true },
  birthdays:   { label: 'Occasions',   paid: false },
  chores:      { label: 'Chores',      paid: false },
};

export function addonLabel(key) {
  return ADDON_META[key]?.label || key;
}

export function addonPaid(key) {
  return !!ADDON_META[key]?.paid;
}

// Stable display order: paid first (catalog order), then free, then unknowns.
const ORDER = Object.keys(ADDON_META);
export function sortAddons(keys) {
  return [...(keys || [])].sort((a, b) => {
    const ia = ORDER.indexOf(a);
    const ib = ORDER.indexOf(b);
    return (ia === -1 ? ORDER.length : ia) - (ib === -1 ? ORDER.length : ib);
  });
}
