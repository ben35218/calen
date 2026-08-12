// The CRUD chokepoint over the unified opaque store (lib/recordStore). The
// mirror-into-the-replica half is covered by the sync suite; this pins the
// CACHE half: the calendar assembles from the replica, so a write that changes
// what the calendar shows must also invalidate the ['calendar'] queries —
// otherwise an edit lands on device but the month grid keeps painting the
// pre-edit sources (the contact-dates bug: Occasions repainted, the grid didn't).

jest.mock('../queryClient', () => ({ queryClient: { invalidateQueries: jest.fn() } }));
jest.mock('../replica', () => ({ getAll: jest.fn(async () => []), upsert: jest.fn(), remove: jest.fn() }));
jest.mock('../records', () => ({ syncRecords: jest.fn(async () => ({})) }));
jest.mock('../../api', () => ({
  recordsApi: {
    create: jest.fn(async (body: any) => ({ data: { _id: body._id ?? 'new-id', updatedAt: 't1' } })),
    update: jest.fn(async () => ({ data: { updatedAt: 't2' } })),
    remove: jest.fn(async () => ({ data: {} })),
  },
}));

let store: typeof import('../recordStore');
let queryClient: { invalidateQueries: jest.Mock };
let replica: { getAll: jest.Mock; upsert: jest.Mock; remove: jest.Mock };

// The invalidation is coalesced on a timer (a bulk import writes one record per
// contact), so the suite drives fake timers to observe it.
beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.useFakeTimers();
  queryClient = require('../queryClient').queryClient;
  replica = require('../replica');
  store = require('../recordStore');
});

afterEach(() => {
  jest.useRealTimers();
});

const SEALED = { _id: 'p1', name: 'Sam', dates: [{ label: 'anniversary', value: '1998-06-12' }], enc: 'ct', keyVersion: 1 };

test('editing a contact invalidates the calendar queries after the replica write', async () => {
  await store.update('Contact', 'p1', SEALED);
  expect(replica.upsert).toHaveBeenCalledWith('Contact', [expect.objectContaining({ _id: 'p1', name: 'Sam' })]);
  jest.runAllTimers();
  expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['calendar'] });
});

test('creating and deleting a calendar-bearing record invalidate too', async () => {
  await store.create('CalendarEvent', { _id: 'e1', enc: 'ct', keyVersion: 1, title: 'Dentist' });
  jest.runAllTimers();
  expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(1);

  await store.remove('Chore', 'c1');
  jest.runAllTimers();
  expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2);
});

test('a burst of writes coalesces into one invalidation', async () => {
  await Promise.all([
    store.create('Contact', { _id: 'a', enc: 'ct', keyVersion: 1 }),
    store.create('Contact', { _id: 'b', enc: 'ct', keyVersion: 1 }),
    store.create('Contact', { _id: 'c', enc: 'ct', keyVersion: 1 }),
  ]);
  jest.runAllTimers();
  expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(1);
});

test('a collection the calendar never expands does not invalidate it', async () => {
  await store.update('Category', 'cat1', { enc: 'ct', keyVersion: 1, name: 'Plumbing' });
  jest.runAllTimers();
  expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
});

// The ciphertext must travel into the replica with the plaintext.
//
// `splitSealed` moves `enc`/`keyVersion` out of the content payload and into the
// wire body, so a row merged as `{ ...existing, ...plain }` keeps whatever
// ciphertext it already had. `openRecord` decrypts that and spreads the result
// OVER the plaintext, so the row displays its PREVIOUS content — an edit that
// silently doesn't take until a background sync replaces the whole row, which
// reads to the user as "I had to do it twice".
test('a local update leaves the replica row decrypting to the NEW content', async () => {
  replica.getAll.mockResolvedValueOnce([{ _id: 'p1', name: 'Sam', enc: 'stale-ct', keyVersion: 1 }]);

  await store.update('Contact', 'p1', { _id: 'p1', name: 'Sammy', enc: 'fresh-ct', keyVersion: 2 });

  const [, [row]] = replica.upsert.mock.calls[0];
  expect(row.name).toBe('Sammy');
  expect(row.enc).toBe('fresh-ct');
  expect(row.keyVersion).toBe(2);
});

// list() is EQUALITY-only. Filtering on a field no record carries empties the
// list — which is exactly how the meal planner's leftover `{ start, end }` range
// made every scheduled meal invisible. Callers do range selection themselves
// (lib/mealSchedule); this pins the contract that forces them to.
test('a param naming a field no record carries yields an empty list', async () => {
  const rows = [{ _id: 's1', recipeId: 'r1', scheduledDate: '2026-08-12' }];
  replica.getAll.mockResolvedValue(rows);
  // The dev-only warning that surfaces this case is the point; keep it off stdout.
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

  expect((await store.list('RecipeSchedule')).data).toEqual(rows);
  expect((await store.list('RecipeSchedule', { recipeId: 'r1' })).data).toEqual(rows);
  expect((await store.list('RecipeSchedule', { start: '2026-08-10', end: '2026-08-16' })).data).toEqual([]);
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});

test('a created row carries its own ciphertext too', async () => {
  await store.create('Contact', { _id: 'p2', name: 'Alex', enc: 'ct2', keyVersion: 3 });

  const [, [row]] = replica.upsert.mock.calls[0];
  expect(row.enc).toBe('ct2');
  expect(row.keyVersion).toBe(3);
});
