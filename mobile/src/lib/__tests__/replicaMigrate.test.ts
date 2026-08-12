// The local replica's collection RENAME path (lib/replica.migrateCollection),
// added for Person → Contact.
//
// Why this matters: the replica is keyed by collection name and the record sync
// cursor is a high-water mark. Rows pulled before the rename sit in the old
// bucket and the server will never resend them, so an upgraded install would
// open Contacts on an empty roster until something forced a full resync. The
// re-bucket is what keeps an existing device's contacts visible.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
// Force the AsyncStorage backend (the SQLite native module isn't linked in Jest,
// but pin it so the test doesn't depend on that detail).
jest.mock('../sqliteReplica', () => ({ isAvailable: () => false }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAll, upsert, migrateCollection } from '../replica';

// The replica's Row type is the minimal { _id, updatedAt } shape; content
// fields ride along structurally. Building rows through a function (rather than
// inline literals) keeps the extra `name` off TypeScript's excess-property check.
const row = (_id: string, name: string, updatedAt: string) => ({ _id, name, updatedAt });

beforeEach(async () => {
  await AsyncStorage.clear();
});

test('moves every row to the new bucket and drains the old one', async () => {
  await upsert('Person', [
    row('a', 'Ada', '2026-01-01T00:00:00Z'),
    row('b', 'Grace', '2026-01-02T00:00:00Z'),
  ]);

  const moved = await migrateCollection('Person', 'Contact');

  expect(moved).toBe(2);
  expect(await getAll('Person')).toEqual([]);
  expect((await getAll<{ name: string }>('Contact')).map((r) => r.name).sort()).toEqual(['Ada', 'Grace']);
});

test('is idempotent — a second run moves nothing and keeps the migrated rows', async () => {
  await upsert('Person', [row('a', 'Ada', '2026-01-01T00:00:00Z')]);
  await migrateCollection('Person', 'Contact');

  expect(await migrateCollection('Person', 'Contact')).toBe(0);
  expect(await getAll('Contact')).toHaveLength(1);
});

test('merges into an existing new-name bucket without dropping either side', async () => {
  // A device that synced some rows post-rename still has pre-rename rows parked.
  await upsert('Contact', [row('new', 'Post-rename', '2026-02-01T00:00:00Z')]);
  await upsert('Person', [row('old', 'Pre-rename', '2026-01-01T00:00:00Z')]);

  await migrateCollection('Person', 'Contact');

  expect((await getAll<{ name: string }>('Contact')).map((r) => r.name).sort())
    .toEqual(['Post-rename', 'Pre-rename']);
});

test('a stale legacy row never overwrites a fresher one already under the new name', async () => {
  // Same _id in both buckets: the replica is last-write-wins on updatedAt, so
  // the newer copy must survive the merge.
  await upsert('Contact', [row('a', 'Edited after rename', '2026-03-01T00:00:00Z')]);
  await upsert('Person', [row('a', 'Stale', '2026-01-01T00:00:00Z')]);

  await migrateCollection('Person', 'Contact');

  const rows = await getAll<{ name: string }>('Contact');
  expect(rows).toHaveLength(1);
  expect(rows[0].name).toBe('Edited after rename');
});

test('an absent legacy bucket is a no-op', async () => {
  expect(await migrateCollection('Person', 'Contact')).toBe(0);
  expect(await getAll('Contact')).toEqual([]);
});
