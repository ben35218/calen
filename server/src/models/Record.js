const mongoose = require('mongoose');
const { encFields } = require('./encFields');

// Signal-parity C3 (opaque record envelopes) — the unified content store.
//
// ONE physical Mongo collection holds every content record (a task, an event, a
// contact, a recipe, …), so the server no longer learns a row's collection TYPE
// from the table it lives in. The type and all content fields ride INSIDE the
// opaque `enc` blob (the v2 envelope — see shared/crypto: the collection moved
// out of the AAD and into the sealed payload). Only routing metadata is
// plaintext, and none of it reveals what kind of record this is:
//   - householdId  — C4 attribution + the primary read scope (the sync cursor is
//                    keyed on householdId + updatedAt).
//   - userId       — author routing for a solo user (no household yet) and for the
//                    D1/D2 shared lane, where a cross-household collaborator's
//                    write must still be attributable for owner-side rotation.
//   - keyVersion + enc { alg, nonce, ct, ks } — the ciphertext (`ks` = the D1/D2
//                    key-scope discriminator: absent = HDK, 'cal'/'trip' = resource
//                    key).
//   - scope { kind, resource, version } — the D1/D2 resource lane: a collaborator
//                    in another household reads these records by `scope.resource`
//                    (a CalendarKey `key` / a Trip `_id`), never by householdId.
//   - deleted      — a tombstone. A unified LWW sync must propagate deletes, so a
//                    delete flips this + bumps updatedAt rather than removing the
//                    row; the client drops it from its replica and the tombstone
//                    can be reaped later.
//
// The server is fully content-blind here: it never reads `enc`, only stores and
// serves it, scoped by the plaintext routing above. See docs/SIGNAL-PARITY-PLAN.md
// §C3 and the C3 decision doc.
const recordSchema = new mongoose.Schema({
  // encFields provides householdId (indexed), keyVersion, and enc {alg,nonce,ct,ks}.
  ...encFields,
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  // D1/D2 resource lane (plaintext routing only — the same fields already exposed
  // as calendarType / tripId on the per-collection models, no NEW identifier).
  scope: {
    kind:     { type: String, enum: ['calendar', 'trip'] },
    resource: { type: String, index: true },
    version:  { type: Number },
  },
  deleted:  { type: Boolean, default: false },
}, { timestamps: true });

// The unified sync cursor: "every record in this household updated after X".
recordSchema.index({ householdId: 1, updatedAt: 1 });
// The solo-user / shared-lane cursors mirror it.
recordSchema.index({ userId: 1, updatedAt: 1 });
recordSchema.index({ 'scope.resource': 1, updatedAt: 1 });

module.exports = mongoose.model('Record', recordSchema);
