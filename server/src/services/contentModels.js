// Registry mapping a dual-write collection name to its mongoose model, for the
// userId-scoped content collections that carry an `enc` blob. Used by the §9
// straggler re-encrypt pass (find/seal records lacking ciphertext) and kept
// aligned with dropReadiness.DROP_FIELDS (minus Household, which is a single
// per-household settings doc handled via /settings, not userId-scoped rows).

const CONTENT_MODELS = {
  CalendarEvent:   require('../models/CalendarEvent'),
  Contact:          require('../models/Contact'),
  MaintenanceTask: require('../models/MaintenanceTask'),
  Chore:           require('../models/Chore'),
  Recipe:          require('../models/Recipe'),
  Trip:            require('../models/Trip'),
  TripItem:        require('../models/TripItem'),
  Item:            require('../models/Item'),
  // Signal-parity D5 (thin collections).
  OdometerLog:     require('../models/OdometerLog'),
  RecipeSchedule:  require('../models/RecipeSchedule'),
  Category:        require('../models/Category'),
};

module.exports = { CONTENT_MODELS };
