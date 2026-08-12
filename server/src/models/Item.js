const mongoose = require('mongoose');
const { encFields, requiredUntilSealed } = require('./encFields');

const itemSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: requiredUntilSealed },
  name: { type: String, required: requiredUntilSealed },
  categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
  propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property' },
  // The service professional (a type:'service' Contact in the user's contacts)
  // who maintains this item. A plaintext ref, like categoryId/propertyId.
  serviceProId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
  type: { type: String, enum: ['appliance', 'vehicle', 'system', 'structure', 'equipment', 'other'], default: 'other' },
  manufacturer: String,
  modelNumber: String,
  serialNumber: String,
  location: String,
  notes: String,
  customFields: [{ key: String, value: String }],
  photoRef: String,
  autoLookupManual: { type: Boolean, default: true },
  // E2EE dual-write ciphertext (Phase 3+): see models/encFields.js.
  ...encFields,
}, { timestamps: true });

itemSchema.index({ userId: 1, name: 'text', manufacturer: 'text', modelNumber: 'text', location: 'text' });

module.exports = mongoose.model('Item', itemSchema);
