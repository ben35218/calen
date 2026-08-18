// The shopping session's sync layer (spec: features/kitchen.md): the sealed,
// versioned household-shared session and — the part that matters when two
// people shop at once — the client-side merge that resolves a 409. The server
// can't merge what it can't read, so this merge IS the concurrency story.

const mockSessionGet = jest.fn();
const mockSessionPut = jest.fn();
jest.mock('../../api', () => ({
  recipeScheduleApi: {
    sessionGet: (...a: unknown[]) => mockSessionGet(...(a as [])),
    sessionPut: (...a: unknown[]) => mockSessionPut(...(a as [])),
  },
}));

const mockEncryptRecord = jest.fn(async () => null as unknown);
const mockDecryptRecord = jest.fn(async () => null as unknown);
jest.mock('../e2ee', () => ({
  encryptRecord: (...a: unknown[]) => mockEncryptRecord(...(a as [])),
  decryptRecord: (...a: unknown[]) => mockDecryptRecord(...(a as [])),
}));

import {
  mergeGrocerySession,
  openGrocerySession,
  saveGrocerySession,
} from '../grocerySession';
import type { GrocerySessionState } from '../../api';

beforeEach(() => {
  mockSessionGet.mockReset();
  mockSessionPut.mockReset();
  mockEncryptRecord.mockReset();
  mockEncryptRecord.mockResolvedValue(null); // no HDK → plaintext lane
  mockDecryptRecord.mockReset();
  mockDecryptRecord.mockResolvedValue(null);
});

const conflict409 = () => Object.assign(new Error('conflict'), { response: { status: 409 } });

describe('mergeGrocerySession', () => {
  it('two concurrent shoppers both survive: checks union, extras union', () => {
    // Device A checked Milk and added Paper Towels; device B checked Basil and
    // added Coffee. Neither shopper's work may be lost.
    const local: GrocerySessionState = {
      checked: { Milk: true },
      extras: [{ name: 'Paper Towels', amount: '2 rolls' }],
    };
    const remote: GrocerySessionState = {
      checked: { Basil: true },
      extras: [{ name: 'Coffee' }],
    };
    const merged = mergeGrocerySession(local, remote);
    expect(merged.checked).toEqual({ Milk: true, Basil: true });
    expect(merged.extras).toEqual([
      { name: 'Paper Towels', amount: '2 rolls' },
      { name: 'Coffee' },
    ]);
  });

  it('unions not-found and have-at-home flags too, dropping unset flags', () => {
    const merged = mergeGrocerySession(
      { notFound: { Saffron: true }, haveHome: { Salt: true, Pepper: false } },
      { notFound: { Basil: true }, haveHome: { Flour: true } },
    );
    expect(merged.notFound).toEqual({ Saffron: true, Basil: true });
    expect(merged.haveHome).toEqual({ Salt: true, Flour: true });
  });

  it('an uncheck racing a check loses to the check (union, not diff)', () => {
    // Local unchecked Milk (absent) while remote still has it — the tick wins;
    // re-unchecking is cheap, a silently lost tick mid-store is not.
    const merged = mergeGrocerySession({ checked: {} }, { checked: { Milk: true } });
    expect(merged.checked).toEqual({ Milk: true });
  });

  it('extras dedupe by cleaned name; a locally deleted extra resurfaces from remote', () => {
    const merged = mergeGrocerySession(
      { extras: [{ name: 'Coffee', amount: '1 bag' }] },
      { extras: [{ name: 'coffee' }, { name: 'Batteries' }] },
    );
    // Local copy (with its amount) wins the collision; the remote-only
    // Batteries — possibly deleted locally — survives (accepted trade-off:
    // resurrection beats losing another shopper's addition).
    expect(merged.extras).toEqual([{ name: 'Coffee', amount: '1 bag' }, { name: 'Batteries' }]);
  });

  it('substitutions union by key with local winning per-key', () => {
    const merged = mergeGrocerySession(
      { substitutions: { Basil: 'oregano' } },
      { substitutions: { Basil: 'thyme', Milk: 'oat milk' } },
    );
    expect(merged.substitutions).toEqual({ Basil: 'oregano', Milk: 'oat milk' });
  });

  it('the organized list is taken whole: local when it has one, else remote', () => {
    const localList = { categories: [{ name: 'Produce', items: [{ name: 'Basil' }] }] };
    const remoteList = { categories: [{ name: 'Dairy', items: [{ name: 'Milk' }] }] };

    const localWins = mergeGrocerySession(
      { organizedList: localList, organizedFor: { basil: '1' } },
      { organizedList: remoteList, organizedFor: { milk: '1' } },
    );
    expect(localWins.organizedList).toBe(localList);
    expect(localWins.organizedFor).toEqual({ basil: '1' });

    const remoteWins = mergeGrocerySession(
      { organizedList: null, organizedFor: null },
      { organizedList: remoteList, organizedFor: { milk: '1' } },
    );
    expect(remoteWins.organizedList).toBe(remoteList);
    expect(remoteWins.organizedFor).toEqual({ milk: '1' });
  });
});

describe('openGrocerySession', () => {
  it('reads a legacy plaintext session from the top-level fields', async () => {
    const opened = await openGrocerySession('2026-08-15', {
      checked: { Milk: true }, version: 3,
    });
    expect(opened).toEqual({ state: { checked: { Milk: true } }, version: 3, locked: false });
    expect(mockDecryptRecord).not.toHaveBeenCalled();
  });

  it('an empty response is an empty state at version 0', async () => {
    expect(await openGrocerySession('2026-08-15', {})).toEqual({ state: {}, version: 0, locked: false });
    expect(await openGrocerySession('2026-08-15', undefined)).toEqual({ state: {}, version: 0, locked: false });
  });

  it('decrypts a sealed session with weekStart as its AAD identity', async () => {
    mockDecryptRecord.mockResolvedValue({ checked: { Basil: true } });
    const enc = { alg: 'a', nonce: 'n', ct: 'c' };
    const opened = await openGrocerySession('2026-08-15', { enc, keyVersion: 2, version: 5 });
    expect(mockDecryptRecord).toHaveBeenCalledWith('ShoppingSession', '2026-08-15', 2, enc);
    expect(opened).toEqual({ state: { checked: { Basil: true } }, version: 5, locked: false });
  });

  it('a sealed blob this device cannot open is surfaced as locked, never as empty-writable', async () => {
    const opened = await openGrocerySession('2026-08-15', {
      enc: { alg: 'a', nonce: 'n', ct: 'c' }, version: 5,
    });
    expect(opened.locked).toBe(true);
    expect(opened.state).toEqual({});
  });
});

describe('saveGrocerySession', () => {
  it('seals when the household key is held and clears the legacy lane server-side', async () => {
    const enc = { alg: 'xchacha20poly1305', nonce: 'n', ct: 'c' };
    mockEncryptRecord.mockResolvedValue({ enc, keyVersion: 1 });
    mockSessionPut.mockResolvedValue({ data: { ok: true, version: 4 } });
    const result = await saveGrocerySession('2026-08-15', { checked: { Milk: true } }, 3);
    expect(mockEncryptRecord).toHaveBeenCalledWith('ShoppingSession', '2026-08-15', { checked: { Milk: true } });
    expect(mockSessionPut).toHaveBeenCalledWith('2026-08-15', { enc, keyVersion: 1, baseVersion: 3 });
    expect(result).toEqual({ state: { checked: { Milk: true } }, version: 4, merged: false });
  });

  it('falls back to the plaintext lane without the key (a session never blocks on it)', async () => {
    mockSessionPut.mockResolvedValue({ data: { ok: true, version: 1 } });
    await saveGrocerySession('2026-08-15', { checked: {} }, 0);
    expect(mockSessionPut).toHaveBeenCalledWith('2026-08-15', { state: { checked: {} }, baseVersion: 0 });
  });

  it('a 409 re-fetches, merges both shoppers, and retries at the new version', async () => {
    mockSessionPut
      .mockRejectedValueOnce(conflict409())
      .mockResolvedValueOnce({ data: { ok: true, version: 6 } });
    mockSessionGet.mockResolvedValue({ data: { checked: { Basil: true }, extras: [{ name: 'Coffee' }], version: 5 } });

    const result = await saveGrocerySession(
      '2026-08-15',
      { checked: { Milk: true }, extras: [{ name: 'Paper Towels' }] },
      3,
    );
    expect(result.merged).toBe(true);
    expect(result.version).toBe(6);
    expect(result.state.checked).toEqual({ Milk: true, Basil: true });
    expect(result.state.extras).toEqual([{ name: 'Paper Towels' }, { name: 'Coffee' }]);
    // The retry carried the merged state against the version it just read.
    expect(mockSessionPut).toHaveBeenLastCalledWith('2026-08-15', expect.objectContaining({
      baseVersion: 5,
      state: expect.objectContaining({ checked: { Milk: true, Basil: true } }),
    }));
  });

  it('gives up after bounded retries instead of looping on a hot conflict', async () => {
    mockSessionPut.mockRejectedValue(conflict409());
    mockSessionGet.mockResolvedValue({ data: { version: 9 } });
    await expect(saveGrocerySession('2026-08-15', {}, 0)).rejects.toThrow('conflict');
    expect(mockSessionPut).toHaveBeenCalledTimes(3);
  });

  it('a non-409 failure rethrows without a merge fetch', async () => {
    mockSessionPut.mockRejectedValue(new Error('Network Error'));
    await expect(saveGrocerySession('2026-08-15', {}, 0)).rejects.toThrow('Network Error');
    expect(mockSessionGet).not.toHaveBeenCalled();
  });

  it('a 409 against a blob it cannot open rethrows rather than writing blind', async () => {
    mockSessionPut.mockRejectedValue(conflict409());
    mockSessionGet.mockResolvedValue({ data: { enc: { alg: 'a', nonce: 'n', ct: 'c' }, version: 9 } });
    await expect(saveGrocerySession('2026-08-15', { checked: {} }, 0)).rejects.toThrow('conflict');
    expect(mockSessionPut).toHaveBeenCalledTimes(1);
  });
});
