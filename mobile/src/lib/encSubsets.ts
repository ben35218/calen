// Sealed content subsets per collection — the client mirror of the server's
// DROP_FIELDS (services/dropReadiness.js). One definition per collection so
// every sealer (forms, assistants, template/odometer flows) picks exactly the
// same fields; a partial sealer would silently drop fields from `enc` that
// another surface had sealed. When editing a record, pass the DECRYPTED
// existing record spread under the update so untouched fields survive:
//   TASK_ENC({ ...decryptedTask, ...updates })
//
// Signal-parity C3b (opaque store cutover): the unified `Record` store keeps NO
// content or routing column — only _id, householdId, userId, keyVersion, enc,
// scope, timestamps, deleted. So EVERY field a screen needs must ride inside
// `enc`; these subsets are the full per-collection field set MINUS those store
// routing keys (and minus server-scheduler-only state like reminderAt/…SentAt
// that no client reads). The server is fully content-blind. See the §C3 decision
// doc (C3b). `author` is folded in separately by lib/e2ee.withAuthor (C4).

type Rec = Record<string, unknown>;

// CalendarEvent seals its whole payload. calendarType joins the sealed set (the
// server no longer filters events by calendar — the client buckets by the
// decrypted calendarType); for an outside-shared calendar it is ALSO the plaintext
// `scope.resource` routing key (D1). Server-scheduler fields (reminderAt,
// reminderSentAt, alert2At, alert2SentAt) are NOT sealed — the scheduler is
// dormant on an e2eeActive household (client owns reminders, D4-style).
export const EVENT_ENC = (p: Rec) => ({
  calendarType: p.calendarType, title: p.title, description: p.description,
  location: p.location, placeId: p.placeId, url: p.url, phone: p.phone,
  startDate: p.startDate, endDate: p.endDate, allDay: p.allDay,
  travelMinutes: p.travelMinutes, travelDistanceKm: p.travelDistanceKm,
  // The transportation method the travel time was computed for (DRIVE when
  // absent — every pre-mode record was a drive time).
  travelMode: p.travelMode,
  reminderMinutes: p.reminderMinutes, alert2Minutes: p.alert2Minutes,
  // Whether each alert's lead time counts back from the start or from departure
  // (lib/calendar). Content, so it rides inside the seal like the minutes do.
  alertAnchor: p.alertAnchor, alert2Anchor: p.alert2Anchor,
  alertAudience: p.alertAudience, guestListVisible: p.guestListVisible,
  invitationId: p.invitationId, cancelled: p.cancelled, recurrence: p.recurrence,
  // Household members (userIds) the creator asked to accept/decline. Their
  // responses live in per-responder EventRsvp records, not on the event.
  householdInvitees: p.householdInvitees,
  // YYYY-MM-DD occurrences removed from a recurring series ("Delete This Event
  // Only"); the shared engine skips them on expansion.
  exceptionDates: p.exceptionDates,
});

// A household member's accept/decline of an event they were invited to
// (householdInvitees). One record per responder per event — each has a single
// writer, so concurrent responses never contend on the event record itself.
// The responder's identity is the folded-in `author` (withAuthor, C4).
export const EVENT_RSVP_ENC = (p: Rec) => ({
  eventId: p.eventId, status: p.status, respondedAt: p.respondedAt,
});

// Multi-value labeled fields (phones/emails/addresses/dates/urls/relatedNames)
// + jobTitle/company are the current shape; the legacy singles (phone/email/
// address/businessName) stay in the subset so re-saving an upgraded record can
// clear them (a field set to undefined is dropped from the sealed blob). See
// lib/personFields for the read-time fold and the save-time clear.
export const PERSON_ENC = (p: Rec) => ({
  type: p.type, name: p.name, firstName: p.firstName, lastName: p.lastName,
  relationship: p.relationship, birthday: p.birthday,
  notes: p.notes, occasionsHidden: p.occasionsHidden,
  phones: p.phones, emails: p.emails, addresses: p.addresses,
  dates: p.dates, urls: p.urls, relatedNames: p.relatedNames,
  jobTitle: p.jobTitle, company: p.company,
  address: p.address, businessName: p.businessName, phone: p.phone, email: p.email,
  accountId: p.accountId, deviceContactId: p.deviceContactId,
});

export const TASK_ENC = (p: Rec) => ({
  itemId: p.itemId, categoryId: p.categoryId, title: p.title, icon: p.icon,
  description: p.description, instructions: p.instructions, recurrence: p.recurrence,
  estimatedDurationMins: p.estimatedDurationMins, estimatedCost: p.estimatedCost,
  priority: p.priority, seasonal: p.seasonal, lastCompletedAt: p.lastCompletedAt,
  // Client-owned lifecycle (Signal-parity D4): computed on create/complete via
  // the shared engine, bucketed on-device.
  nextDueDate: p.nextDueDate,
  reminderDaysBefore: p.reminderDaysBefore, alert2DaysBefore: p.alert2DaysBefore,
  reminderTime: p.reminderTime,
  alertAudience: p.alertAudience, alertUserIds: p.alertUserIds, active: p.active,
  templateId: p.templateId, intervalKm: p.intervalKm,
  lastServiceKm: p.lastServiceKm, nextDueKm: p.nextDueKm,
  // Set on a copy created by "Save for This … Only": the series it was detached
  // from and the day it replaces. Sealed like everything else — the link exists
  // so Resume can tell which upcoming days already have a standalone copy and
  // leave those skipped rather than double-booking the day.
  detachedFrom: p.detachedFrom, detachedDate: p.detachedDate,
});

export const CHORE_ENC = (p: Rec) => ({
  title: p.title, instructions: p.instructions, description: p.description,
  recurrence: p.recurrence, assignedTo: p.assignedTo, nextDueDate: p.nextDueDate,
  reminderDaysBefore: p.reminderDaysBefore, alert2DaysBefore: p.alert2DaysBefore,
  reminderTime: p.reminderTime,
  alertAudience: p.alertAudience, active: p.active, templateId: p.templateId,
  icon: p.icon,
  // Set on a copy created by "Save for This … Only": the series it was detached
  // from and the day it replaces. Sealed like everything else — the link exists
  // so Resume can tell which upcoming days already have a standalone copy and
  // leave those skipped rather than double-booking the day.
  detachedFrom: p.detachedFrom, detachedDate: p.detachedDate,
});

export const RECIPE_ENC = (p: Rec) => ({
  title: p.title, description: p.description, source: p.source, sourceUrl: p.sourceUrl,
  imageUrl: p.imageUrl, servings: p.servings, prepTimeMins: p.prepTimeMins,
  cookTimeMins: p.cookTimeMins, ingredients: p.ingredients, instructions: p.instructions,
  instructionIngredients: p.instructionIngredients, instructionTimers: p.instructionTimers,
  tags: p.tags,
});

export const ITEM_ENC = (p: Rec) => ({
  name: p.name, categoryId: p.categoryId, propertyId: p.propertyId,
  serviceProId: p.serviceProId, type: p.type, manufacturer: p.manufacturer,
  modelNumber: p.modelNumber, serialNumber: p.serialNumber, location: p.location,
  notes: p.notes, customFields: p.customFields, photoRef: p.photoRef,
  autoLookupManual: p.autoLookupManual,
});

export const ODOMETER_ENC = (p: Rec) => ({
  itemId: p.itemId, reading: p.reading, recordedAt: p.recordedAt, notes: p.notes,
});
export const RECIPE_SCHEDULE_ENC = (p: Rec) => ({
  recipeId: p.recipeId, scheduledDate: p.scheduledDate, servings: p.servings, notes: p.notes,
});
export const CATEGORY_ENC = (p: Rec) => ({
  parentId: p.parentId, name: p.name, icon: p.icon, color: p.color, sortOrder: p.sortOrder,
});

// The household settings blob (P5a homeAddress + the name since C2). Sealed as
// collection 'Household' with the household's own _id. NOT part of the C3b unified
// store — the Household doc stays its own record (settings route), so this keeps
// its narrow subset.
export const HOUSEHOLD_ENC = (p: Rec) => ({ name: p.name, homeAddress: p.homeAddress });
