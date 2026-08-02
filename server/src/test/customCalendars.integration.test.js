// Integration tests for custom calendars (routes/calendars.js): create/list,
// the three access tiers (private, shared with a member, shared household-wide),
// creator-only edit/delete, and the `mine` flag the client keys read-only mode
// off. Real app + in-memory MongoDB.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb, request, registerUser, enrollKeys, joinHousehold, b64u } = require('./harness');

before(startDb);
after(stopDb);

// One owner + one member in the same household, via the real onboarding flow.
async function setupHouseholdOfTwo() {
  const owner = await registerUser({ firstName: 'Olive' });
  const member = await registerUser({ firstName: 'Milo' });
  await enrollKeys(owner.auth);
  await enrollKeys(member.auth);
  const mint = await request().post('/api/household/key')
    .set('Authorization', owner.auth)
    .send({ keyVersion: 1, wrappedHDK: b64u(96) });
  assert.equal(mint.status, 201);
  const hh = await request().get('/api/household').set('Authorization', owner.auth);
  await joinHousehold({ joiner: member, approver: owner, keyVersion: 1 });
  return { owner, member };
}

let seq = 0;
const mintKey = () => `custom-test${Date.now().toString(36)}${(seq++).toString(36)}`;

async function createCalendar(auth, overrides = {}) {
  const res = await request().post('/api/calendars')
    .set('Authorization', auth)
    .send({ key: mintKey(), name: 'Test Calendar', color: '#1976D2', alertsEnabled: true, ...overrides });
  return res;
}

test('create + list: a private calendar is visible to its creator only', async () => {
  const { owner, member } = await setupHouseholdOfTwo();

  const created = await createCalendar(owner.auth, { name: 'Secret Plans' });
  assert.equal(created.status, 201);
  assert.equal(created.body.mine, true);

  const ownerList = await request().get('/api/calendars').set('Authorization', owner.auth);
  assert.ok(ownerList.body.some((c) => c.key === created.body.key));

  const memberList = await request().get('/api/calendars').set('Authorization', member.auth);
  assert.ok(!memberList.body.some((c) => c.key === created.body.key));
});

test('sharing tiers: household-wide and member-specific calendars reach the member (mine=false)', async () => {
  const { owner, member } = await setupHouseholdOfTwo();

  const hhWide = await createCalendar(owner.auth, { name: 'Family', sharedWithHousehold: true });
  const direct = await createCalendar(owner.auth, { name: 'Just Milo', sharedWith: [member.user._id] });
  const priv = await createCalendar(owner.auth, { name: 'Private' });

  const memberList = await request().get('/api/calendars').set('Authorization', member.auth);
  const keys = memberList.body.map((c) => c.key);
  assert.ok(keys.includes(hhWide.body.key));
  assert.ok(keys.includes(direct.body.key));
  assert.ok(!keys.includes(priv.body.key));
  for (const c of memberList.body) {
    if (c.key === hhWide.body.key || c.key === direct.body.key) assert.equal(c.mine, false);
  }
});

test('outsiders see nothing, even when a calendar is household-wide', async () => {
  const { owner } = await setupHouseholdOfTwo();
  const outsider = await registerUser({ firstName: 'Randa' });

  const hhWide = await createCalendar(owner.auth, { sharedWithHousehold: true });
  assert.equal(hhWide.status, 201);

  const list = await request().get('/api/calendars').set('Authorization', outsider.auth);
  assert.equal(list.status, 200);
  assert.ok(!list.body.some((c) => c.key === hhWide.body.key));
});

test('creator-only writes: a member with read access cannot edit or delete', async () => {
  const { owner, member } = await setupHouseholdOfTwo();
  const cal = await createCalendar(owner.auth, { sharedWithHousehold: true });

  const memberEdit = await request().put(`/api/calendars/${cal.body.key}`)
    .set('Authorization', member.auth).send({ name: 'Hijacked' });
  assert.equal(memberEdit.status, 404);

  const memberDelete = await request().delete(`/api/calendars/${cal.body.key}`)
    .set('Authorization', member.auth);
  assert.equal(memberDelete.status, 404);

  const ownerEdit = await request().put(`/api/calendars/${cal.body.key}`)
    .set('Authorization', owner.auth)
    .send({ name: 'Renamed', sharedWithHousehold: false, sharedWith: [member.user._id] });
  assert.equal(ownerEdit.status, 200);
  assert.equal(ownerEdit.body.name, 'Renamed');

  const ownerDelete = await request().delete(`/api/calendars/${cal.body.key}`)
    .set('Authorization', owner.auth);
  assert.equal(ownerDelete.status, 200);

  const list = await request().get('/api/calendars').set('Authorization', owner.auth);
  assert.ok(!list.body.some((c) => c.key === cal.body.key));
});

test('validation: bad keys are rejected; duplicate keys conflict', async () => {
  const { owner } = await setupHouseholdOfTwo();

  const badKey = await createCalendar(owner.auth, { key: 'not-a-custom-key' });
  assert.equal(badKey.status, 400);

  const key = mintKey();
  const first = await createCalendar(owner.auth, { key });
  assert.equal(first.status, 201);
  const dup = await createCalendar(owner.auth, { key });
  assert.equal(dup.status, 400);
});

// Event CRUD moved to the unified opaque /records store in C3b (the per-collection
// /calendar/events routes were deleted). READS on a shared calendar are governed
// by CalendarKey possession; WRITES in the calendar lane are enforced server-side
// again since free viewer mode — /records 403s creates/updates/deletes from
// 'view' collaborators via the record's plaintext `scope.resource` (see
// records.integration.test.js). So the tests below assert only the calendar-level
// surface (/api/calendars): sharing tiers, the `access`/`mine` flags, and the
// invitation lifecycle.

// ── Outside-household sharing (CalendarInvitation flow, §9.5) ────────────────

test('outside share: invitation lifecycle grants and revokes calendar access', async () => {
  const { owner } = await setupHouseholdOfTwo();
  const outsider = await registerUser({ firstName: 'Piper' });

  // Owner shares a calendar with the outsider's email.
  const cal = await createCalendar(owner.auth, {
    name: 'Carpool',
    sharedWithOutside: [outsider.user.email.toUpperCase()], // case-insensitive
  });
  assert.equal(cal.status, 201);

  // The outsider sees a pending invitation (resolved to their account).
  const inbox = await request().get('/api/calendars/invitations').set('Authorization', outsider.auth);
  assert.equal(inbox.status, 200);
  const inv = inbox.body.find((i) => i.calendarKey === cal.body.key);
  assert.ok(inv);
  assert.equal(inv.status, 'pending');
  assert.equal(inv.calendarName, 'Carpool');
  assert.equal(String(inv.toUserId), String(outsider.user._id));

  // Before accepting: no calendar.
  let calList = await request().get('/api/calendars').set('Authorization', outsider.auth);
  assert.ok(!calList.body.some((c) => c.key === cal.body.key));

  // Accept → the calendar appears (read-only, sharing details stripped). The
  // events on it are read via the CalendarKey wrapped to this collaborator (D1),
  // served by the /records resource lane — not a server calendar feed.
  const accept = await request().post(`/api/calendars/invitations/${inv._id}/accept`)
    .set('Authorization', outsider.auth);
  assert.equal(accept.status, 200);
  assert.equal(accept.body.calendar.mine, false);
  calList = await request().get('/api/calendars').set('Authorization', outsider.auth);
  const shared = calList.body.find((c) => c.key === cal.body.key);
  assert.ok(shared);
  assert.equal(shared.mine, false);
  assert.deepEqual(shared.sharedWithOutside, []);
  assert.deepEqual(shared.sharedWith, []);
  assert.equal(shared.sharedWithHousehold, false);
  // Default outside access is View Only (the client keys read-only mode off this).
  assert.equal(shared.access, 'view');

  // Owner removes the email → invitation deleted, calendar access revoked.
  const unshare = await request().put(`/api/calendars/${cal.body.key}`)
    .set('Authorization', owner.auth).send({ sharedWithOutside: [] });
  assert.equal(unshare.status, 200);
  const inbox2 = await request().get('/api/calendars/invitations').set('Authorization', outsider.auth);
  assert.ok(!inbox2.body.some((i) => i.calendarKey === cal.body.key));
  calList = await request().get('/api/calendars').set('Authorization', outsider.auth);
  assert.ok(!calList.body.some((c) => c.key === cal.body.key));
});

test('outside share: decline grants nothing; declining after accept gives up access', async () => {
  const { owner } = await setupHouseholdOfTwo();
  const outsider = await registerUser({ firstName: 'Quinn' });

  const cal = await createCalendar(owner.auth, { sharedWithOutside: [outsider.user.email] });
  const inbox = await request().get('/api/calendars/invitations').set('Authorization', outsider.auth);
  const inv = inbox.body.find((i) => i.calendarKey === cal.body.key);

  const decline = await request().post(`/api/calendars/invitations/${inv._id}/decline`)
    .set('Authorization', outsider.auth);
  assert.equal(decline.status, 200);
  assert.equal(decline.body.invitation.status, 'declined');
  let calList = await request().get('/api/calendars').set('Authorization', outsider.auth);
  assert.ok(!calList.body.some((c) => c.key === cal.body.key));

  // Accept, then decline again → access removed.
  await request().post(`/api/calendars/invitations/${inv._id}/accept`).set('Authorization', outsider.auth);
  calList = await request().get('/api/calendars').set('Authorization', outsider.auth);
  assert.ok(calList.body.some((c) => c.key === cal.body.key));
  await request().post(`/api/calendars/invitations/${inv._id}/decline`).set('Authorization', outsider.auth);
  calList = await request().get('/api/calendars').set('Authorization', outsider.auth);
  assert.ok(!calList.body.some((c) => c.key === cal.body.key));
});

test('outside share: an email without an account is claimed at registration', async () => {
  const { owner } = await setupHouseholdOfTwo();
  const email = `future-${Date.now()}@example.com`;

  const cal = await createCalendar(owner.auth, { sharedWithOutside: [email] });
  assert.equal(cal.status, 201);

  const late = await registerUser({ email, firstName: 'Late' });
  const inbox = await request().get('/api/calendars/invitations').set('Authorization', late.auth);
  const inv = inbox.body.find((i) => i.calendarKey === cal.body.key);
  assert.ok(inv);

  const accept = await request().post(`/api/calendars/invitations/${inv._id}/accept`)
    .set('Authorization', late.auth);
  assert.equal(accept.status, 200);
  const calList = await request().get('/api/calendars').set('Authorization', late.auth);
  assert.ok(calList.body.some((c) => c.key === cal.body.key));
});

// ── Access levels: View Only vs Full Access ──────────────────────────────────

test('member access levels: the calendar carries the member’s view/full access flag', async () => {
  const { owner, member } = await setupHouseholdOfTwo();
  const cal = await createCalendar(owner.auth, {
    name: 'Projects',
    sharedWith: [{ userId: member.user._id, access: 'view' }],
  });

  // The member sees the calendar with access: 'view' (the client keys read-only
  // mode off this; /records also rejects calendar-lane writes from 'view'
  // holders server-side).
  const list = await request().get('/api/calendars').set('Authorization', member.auth);
  assert.equal(list.body.find((c) => c.key === cal.body.key).access, 'view');

  // Owner upgrades to full access → the flag flips.
  const upgrade = await request().put(`/api/calendars/${cal.body.key}`)
    .set('Authorization', owner.auth)
    .send({ sharedWith: [{ userId: member.user._id, access: 'full' }] });
  assert.equal(upgrade.status, 200);
  const list2 = await request().get('/api/calendars').set('Authorization', member.auth);
  assert.equal(list2.body.find((c) => c.key === cal.body.key).access, 'full');
});

test('household-wide view-only calendar: members see access:view', async () => {
  const { owner, member } = await setupHouseholdOfTwo();
  const cal = await createCalendar(owner.auth, {
    name: 'Announcements',
    sharedWithHousehold: true,
    householdAccess: 'view',
  });
  const list = await request().get('/api/calendars').set('Authorization', member.auth);
  assert.equal(list.body.find((c) => c.key === cal.body.key).access, 'view');
});

test('full-access outside collaborator: the invitation carries access:full', async () => {
  const { owner } = await setupHouseholdOfTwo();
  const outsider = await registerUser({ firstName: 'Remy' });

  const cal = await createCalendar(owner.auth, {
    name: 'Co-parenting',
    sharedWithOutside: [{ email: outsider.user.email, access: 'full' }],
  });
  const inbox = await request().get('/api/calendars/invitations').set('Authorization', outsider.auth);
  const inv = inbox.body.find((i) => i.calendarKey === cal.body.key);
  assert.equal(inv.access, 'full');
  const accept = await request().post(`/api/calendars/invitations/${inv._id}/accept`).set('Authorization', outsider.auth);
  assert.equal(accept.status, 200);

  // The accepted calendar carries the full-access flag (the client offers writes;
  // the collaborator holds the CalendarKey to seal events into the /records lane).
  const list = await request().get('/api/calendars').set('Authorization', outsider.auth);
  assert.equal(list.body.find((c) => c.key === cal.body.key).access, 'full');
});

// ── Subscribed (ICS feed) calendars ──────────────────────────────────────────

test('feed subscription: webcal:// normalizes to https and is stored', async () => {
  const { owner, member } = await setupHouseholdOfTwo();
  const cal = await createCalendar(owner.auth, {
    name: 'School',
    sharedWithHousehold: true,
    feedUrl: 'webcal://example.com/school.ics',
  });
  assert.equal(cal.status, 201);
  assert.equal(cal.body.feedUrl, 'https://example.com/school.ics');

  // The URL flows to a housemate so their device can fetch the feed itself.
  const list = await request().get('/api/calendars').set('Authorization', member.auth);
  const seen = list.body.find((c) => c.key === cal.body.key);
  assert.equal(seen.feedUrl, 'https://example.com/school.ics');
});

test('feed subscription: a non-http(s) feed URL is rejected', async () => {
  const { owner } = await setupHouseholdOfTwo();
  const bad = await createCalendar(owner.auth, { feedUrl: 'ftp://example.com/x.ics' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_feed_url');
});

// (Feed calendars' events are computed client-side from the ICS source and are
// never CalendarEvent/Record rows, so their read-only nature is a client concern
// now — the deleted /calendar/events route used to reject writes here.)

// ── Holiday calendars (client-computed, read-only, shareable) ────────────────

test('holiday calendar: config is stored and reaches a housemate', async () => {
  const { owner, member } = await setupHouseholdOfTwo();
  const cal = await createCalendar(owner.auth, {
    name: 'Canadian Holidays',
    sharedWithHousehold: true,
    holiday: { country: 'CA', selectedRegions: ['Ontario'], disabledIds: ['boxing-day'] },
  });
  assert.equal(cal.status, 201);
  assert.equal(cal.body.holiday.country, 'CA');
  assert.deepEqual(cal.body.holiday.selectedRegions, ['Ontario']);

  const list = await request().get('/api/calendars').set('Authorization', member.auth);
  const seen = list.body.find((c) => c.key === cal.body.key);
  assert.ok(seen);
  assert.equal(seen.holiday.country, 'CA');
  assert.deepEqual(seen.holiday.disabledIds, ['boxing-day']);
});

// (Holiday calendars' events are computed client-side; like feeds, their
// read-only nature is now enforced by the client, not the deleted event route.)

test('holiday calendar: owner can edit its regions/disabled config', async () => {
  const { owner } = await setupHouseholdOfTwo();
  const cal = await createCalendar(owner.auth, {
    name: 'UK Holidays',
    holiday: { country: 'GB', selectedRegions: [], disabledIds: [] },
  });
  const edit = await request().put(`/api/calendars/${cal.body.key}`)
    .set('Authorization', owner.auth)
    .send({ holiday: { selectedRegions: ['Scotland'], disabledIds: [] } });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.holiday.country, 'GB'); // country preserved
  assert.deepEqual(edit.body.holiday.selectedRegions, ['Scotland']);
});

// ── Free viewer mode: the billing-status viewer counts ──────────────────────
// GET /billing/status → `viewer` carries how many calendars are shared with the
// caller + how many calendar invitations await them. A locked user with either
// count > 0 gets the read-only viewer shell instead of the hard paywall
// (billing-plans.md "Free viewer mode").

const viewerCounts = async (auth) => {
  const res = await request().get('/api/billing/status').set('Authorization', auth);
  assert.equal(res.status, 200);
  return res.body.viewer;
};

test('viewer counts: pending → accepted → revoked across the invitation lifecycle', async () => {
  const { owner } = await setupHouseholdOfTwo();
  const outsider = await registerUser({ firstName: 'Vera' });

  // Nothing shared yet → both counts zero (this user would see the paywall).
  assert.deepEqual(await viewerCounts(outsider.auth), {
    calendarCollaborations: 0,
    pendingCalendarInvitations: 0,
  });

  // Owner shares → the pending invitation counts (viewer shell opens to accept).
  const cal = await createCalendar(owner.auth, { sharedWithOutside: [outsider.user.email] });
  assert.deepEqual(await viewerCounts(outsider.auth), {
    calendarCollaborations: 0,
    pendingCalendarInvitations: 1,
  });

  // Accept → the pending invite becomes a collaboration.
  const inbox = await request().get('/api/calendars/invitations').set('Authorization', outsider.auth);
  const inv = inbox.body.find((i) => i.calendarKey === cal.body.key);
  await request().post(`/api/calendars/invitations/${inv._id}/accept`).set('Authorization', outsider.auth);
  assert.deepEqual(await viewerCounts(outsider.auth), {
    calendarCollaborations: 1,
    pendingCalendarInvitations: 0,
  });

  // Owner revokes the share → both counts drop to zero (back to the paywall).
  await request().put(`/api/calendars/${cal.body.key}`)
    .set('Authorization', owner.auth).send({ sharedWithOutside: [] });
  assert.deepEqual(await viewerCounts(outsider.auth), {
    calendarCollaborations: 0,
    pendingCalendarInvitations: 0,
  });
});

test('viewer counts: an email-only pre-signup invite counts for the freshly registered recipient', async () => {
  const { owner } = await setupHouseholdOfTwo();
  const email = `viewer-${Date.now()}@example.com`;
  await createCalendar(owner.auth, { sharedWithOutside: [email] });

  // The recipient registers AFTER the share: the invitation still has no
  // toUserId (the lazy claim happens on their first inbox fetch), so the count
  // must match by address — this is what routes their very first session into
  // the viewer shell.
  const late = await registerUser({ email, firstName: 'Wren' });
  const counts = await viewerCounts(late.auth);
  assert.equal(counts.pendingCalendarInvitations, 1);
});

test('outside share now succeeds on an E2EE-active household (Signal-parity D1 CalendarKey)', async () => {
  const { owner } = await setupHouseholdOfTwo();
  const cal = await createCalendar(owner.auth);

  const Household = require('../models/Household');
  const hh = await request().get('/api/household').set('Authorization', owner.auth);
  await Household.updateOne({ _id: hh.body._id }, { $set: { e2eeActive: true } });

  // D1 replaced the old 409 fail-safe: sharing outside is allowed because the
  // events seal under a CalendarKey wrapped to the collaborator (no plaintext
  // feed). The owner's device provisions the CalendarKey after the share.
  const shared = await request().put(`/api/calendars/${cal.body.key}`)
    .set('Authorization', owner.auth).send({ sharedWithOutside: ['friend@example.com'] });
  assert.equal(shared.status, 200);

  const mint = await request().post(`/api/calendars/${cal.body.key}/keys`)
    .set('Authorization', owner.auth)
    .send({ keyVersion: 1, household: { hdkVersion: 1, wrappedKey: b64u(120) } });
  assert.equal(mint.status, 201);
  const keys = await request().get(`/api/calendars/${cal.body.key}/keys`).set('Authorization', owner.auth);
  assert.equal(keys.body.currentKeyVersion, 1);
  assert.equal(keys.body.household.length, 1);

  await Household.updateOne({ _id: hh.body._id }, { $set: { e2eeActive: false } });
});
