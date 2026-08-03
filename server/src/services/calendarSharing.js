// Outside-household calendar sharing vs. E2EE (§9.5).
//
// A custom calendar can be shared with collaborators OUTSIDE the owner's
// household (models/CalendarInvitation.js), who hold no HDK. So the EVENTS on
// an outside-shared calendar must stay PLAINTEXT — the same deliberate
// exception shared trips take (services/tripSharing.js), because a shared
// calendar is an ongoing feed, not a one-shot snapshot like event invitations.
//
// Consequences this module centralizes (mirroring tripSharing):
//   - the plaintext drop must NOT null these events' plaintext, and must not
//     treat a (legitimately) missing `enc` on them as an unsealed straggler;
//   - the straggler/re-encrypt pass must not try to seal them.
//
// "Outside-shared" = an outside email is on the calendar (an invitation is
// pending) OR a collaborator has already joined. Removing every outside email
// revokes both, after which the calendar's events are normal private records
// again (lazy re-encrypt: each re-seals on its next edit).

const OUTSIDE_SHARED_MATCH = {
  $or: [
    { sharedWithOutside: { $exists: true, $not: { $size: 0 } } },
    { collaborators: { $exists: true, $not: { $size: 0 } } },
  ],
};

// Whether a calendar is outside-shared (an outside invitation is pending OR a
// collaborator has joined) — the trigger for the Signal-parity D1 CalendarKey
// (its events seal under the CalendarKey rather than the household HDK).
function isCalendarOutsideShared(cal) {
  const has = (a) => Array.isArray(a) && a.length > 0;
  return !!(cal && (has(cal.sharedWithOutside) || has(cal.collaborators)));
}

// The calendarType keys of every outside-shared calendar owned by this scope.
async function outsideSharedCalendarKeys(CustomCalendar, scopeIds) {
  const rows = await CustomCalendar
    .find({ userId: { $in: scopeIds }, ...OUTSIDE_SHARED_MATCH }, 'key').lean();
  return rows.map((r) => r.key);
}

// Extra query fragment that EXCLUDES outside-shared calendar events for a given
// collection, so the straggler scan and the drop leave those plaintext rows
// alone. Other collections are unaffected.
function excludeOutsideCalendarFilter(collection, sharedKeys) {
  if (!sharedKeys || !sharedKeys.length) return {};
  if (collection === 'CalendarEvent') return { calendarType: { $nin: sharedKeys } };
  return {};
}

// ── Access levels (View Only / Full Access) ─────────────────────────────────
// Normalizers accept both the current subdoc shape and the legacy plain
// ObjectId/String arrays (see models/CustomCalendar.js): legacy members kept
// their historical capability (household members could edit events → 'full');
// legacy outside people were read-only → 'view'.
function normalizeMemberEntry(m) {
  if (m && m.userId) return { userId: m.userId, access: m.access === 'view' ? 'view' : 'full' };
  return { userId: m, access: 'full' };
}
// An outside-share entry is addressed by email OR phone. `phone` is left as-is
// here (loose normalization happens at the route, via services/phone.js).
function normalizeOutsideEntry(o) {
  const access = o && o.access === 'full' ? 'full' : 'view';
  if (o && o.phone) return { phone: String(o.phone).trim(), access };
  if (o && o.email) return { email: String(o.email).toLowerCase().trim(), access };
  return { email: String(o).toLowerCase().trim(), access: 'view' };
}
// `keyChangedAt` / `reapprovalRequestedAt` are SERVER state (the re-key
// suppression — see the model), not part of the client's sharing payload, so
// they ride through untouched. Dropping them here would clear the suppression
// on any ordinary calendar edit (rename, recolour, add a collaborator), and the
// owner's next background pass would then silently re-wrap the CalendarKey to a
// re-keyed collaborator that nobody ever approved.
function normalizeCollaboratorEntry(c) {
  if (c && c.userId) {
    const out = { userId: c.userId, access: c.access === 'full' ? 'full' : 'view' };
    if (c.keyChangedAt) out.keyChangedAt = c.keyChangedAt;
    if (c.reapprovalRequestedAt) out.reapprovalRequestedAt = c.reapprovalRequestedAt;
    return out;
  }
  return { userId: c, access: 'view' };
}

// The requester's effective access on a calendar (plain object or doc):
// 'full' = may create/edit/delete its events, 'view' = read only, null = none.
function effectiveCalendarAccess(cal, userId, scopeIds) {
  const uid = String(userId);
  if (String(cal.userId) === uid) return 'full';
  const sameHousehold = (scopeIds || []).some((id) => String(id) === String(cal.userId));
  if (sameHousehold) {
    if (cal.sharedWithHousehold) return cal.householdAccess === 'view' ? 'view' : 'full';
    const entry = (cal.sharedWith || []).map(normalizeMemberEntry).find((m) => String(m.userId) === uid);
    return entry ? entry.access : null;
  }
  const collab = (cal.collaborators || []).map(normalizeCollaboratorEntry).find((c) => String(c.userId) === uid);
  return collab ? collab.access : null;
}

// Whether the requester may WRITE events carrying this calendarType. Returns
// true/false for known custom keys; null when it has no opinion (built-ins,
// unknown keys) — the caller falls back to its household-scope rule.
async function canWriteCalendarType(CustomCalendar, { userId, scopeIds }, calendarType) {
  if (!calendarType || !String(calendarType).startsWith('custom-')) return null;
  const cal = await CustomCalendar.findOne({ key: calendarType }).lean();
  if (!cal) return null;
  return effectiveCalendarAccess(cal, userId, scopeIds) === 'full';
}

// Invitations addressed to a user: to their account, or (before claiming) to
// their email or saved phone. Shared by the invitations routes and the billing
// status viewer counts, so a freshly registered invitee matches by address
// before the lazy toUserId claim.
function addressedToUser(user) {
  const or = [{ toUserId: user._id }];
  if (user.email) or.push({ toEmail: user.email.toLowerCase() });
  if (user.phone) or.push({ toPhone: user.phone });
  return or;
}

// Free viewer mode's eligibility signal (GET /billing/status → `viewer`): how
// many shared calendars this user is seated on, and how many pending calendar
// invitations are addressed to them. The collaborator $or arms mirror
// accessFilter's (subdoc shape + legacy plain-id rows).
async function viewerContentCounts({ CustomCalendar, CalendarInvitation }, user) {
  const [calendarCollaborations, pendingCalendarInvitations] = await Promise.all([
    CustomCalendar.countDocuments({
      $or: [{ 'collaborators.userId': user._id }, { collaborators: user._id }],
    }),
    CalendarInvitation.countDocuments({ status: 'pending', $or: addressedToUser(user) }),
  ]);
  return { calendarCollaborations, pendingCalendarInvitations };
}

module.exports = {
  OUTSIDE_SHARED_MATCH,
  isCalendarOutsideShared,
  outsideSharedCalendarKeys,
  excludeOutsideCalendarFilter,
  normalizeMemberEntry,
  normalizeOutsideEntry,
  normalizeCollaboratorEntry,
  effectiveCalendarAccess,
  canWriteCalendarType,
  addressedToUser,
  viewerContentCounts,
};
