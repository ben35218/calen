// Displaying and claiming a recipe's photo (spec: features/kitchen.md, "The
// photo on a recipe"). The stored value is a server PATH, so every surface has
// to join the API host at display time — passing the raw value to <Image>
// renders nothing at all, which is how the card thumbnail and the detail hero
// were already broken before this existed.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import AsyncStorage from '@react-native-async-storage/async-storage';
import { recipeImageUri, claimRecipePhoto, flushPendingPhotoClaims } from '../recipePhoto';
import { API_BASE_URL } from '../../config';

const mockSetPhoto = jest.fn(async () => ({ data: { claimed: null as string | null, removed: 0 } }));
jest.mock('../../api', () => ({
  recipesApi: { setPhoto: (...args: unknown[]) => mockSetPhoto(...(args as [])) },
}));

// An axios-shaped failure the server ANSWERED (retrying can't change it).
const answered = (status: number) => Object.assign(new Error(`http ${status}`), { response: { status } });
// A failure that never reached the server (offline/timeout) — retryable.
const offline = () => new Error('Network Error');

const PENDING_KEY = 'recipePhotoClaims.pending';
const readQueue = async () => JSON.parse((await AsyncStorage.getItem(PENDING_KEY)) ?? '[]');

beforeEach(async () => {
  mockSetPhoto.mockReset();
  mockSetPhoto.mockImplementation(async () => ({ data: { claimed: null, removed: 0 } }));
  await AsyncStorage.clear();
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

// Drive a claim/flush promise past its internal retry delays.
const settle = async <T>(p: Promise<T>): Promise<T> => {
  await jest.advanceTimersByTimeAsync(5_000);
  return p;
};

describe('recipeImageUri', () => {
  it('joins the API host onto a stored server path', () => {
    expect(recipeImageUri('/uploads/recipes/abc.jpg')).toBe(`${API_BASE_URL}/uploads/recipes/abc.jpg`);
  });

  it('leaves an already-absolute source alone', () => {
    // A remote URL on an older recipe, and the file:// preview of a photo the
    // user just picked, both have to render as-is.
    expect(recipeImageUri('https://cdn.example/soup.jpg')).toBe('https://cdn.example/soup.jpg');
    expect(recipeImageUri('file:///var/tmp/pick.jpg')).toBe('file:///var/tmp/pick.jpg');
    expect(recipeImageUri('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
  });

  it('is null when there is nothing to show', () => {
    // A recipe with no photo is the common case — the caller draws its
    // fork-and-knife placeholder instead.
    expect(recipeImageUri(undefined)).toBeNull();
    expect(recipeImageUri('')).toBeNull();
    expect(recipeImageUri('   ')).toBeNull();
    expect(recipeImageUri('uploads/recipes/abc.jpg')).toBeNull();
  });
});

describe('claimRecipePhoto', () => {
  it('claims a file we host', async () => {
    await claimRecipePhoto('r1', '/uploads/recipes/abc.jpg');
    expect(mockSetPhoto).toHaveBeenCalledWith('r1', '/uploads/recipes/abc.jpg');
  });

  it('claims nothing for a removed photo or one hosted elsewhere', async () => {
    await claimRecipePhoto('r1', '');
    await claimRecipePhoto('r1', 'https://cdn.example/soup.jpg');
    expect(mockSetPhoto).toHaveBeenNthCalledWith(1, 'r1', null);
    expect(mockSetPhoto).toHaveBeenNthCalledWith(2, 'r1', null);
  });

  it('never rejects — the recipe is already saved by the time it runs', async () => {
    mockSetPhoto.mockRejectedValueOnce(offline());
    await expect(settle(claimRecipePhoto('r1', '/uploads/recipes/abc.jpg'))).resolves.toBeUndefined();
  });

  it('retries a transient failure inline before giving up', async () => {
    mockSetPhoto.mockRejectedValueOnce(offline()).mockRejectedValueOnce(offline());
    await settle(claimRecipePhoto('r1', '/uploads/recipes/abc.jpg'));
    expect(mockSetPhoto).toHaveBeenCalledTimes(3); // first try + 2 retries, third landed
    expect(await readQueue()).toEqual([]); // nothing left to park
  });

  it('parks a claim the server never answered in the durable queue', async () => {
    mockSetPhoto.mockRejectedValue(offline());
    await settle(claimRecipePhoto('r1', '/uploads/recipes/abc.jpg'));
    expect(await readQueue()).toEqual([{ recipeId: 'r1', imageUrl: '/uploads/recipes/abc.jpg' }]);
  });

  it('a newer save\'s claim supersedes the same recipe\'s parked one', async () => {
    mockSetPhoto.mockRejectedValue(offline());
    await settle(claimRecipePhoto('r1', '/uploads/recipes/old.jpg'));
    await settle(claimRecipePhoto('r1', '/uploads/recipes/new.jpg'));
    expect(await readQueue()).toEqual([{ recipeId: 'r1', imageUrl: '/uploads/recipes/new.jpg' }]);
  });

  it('an answered error (404: already swept) is dropped silently, never queued', async () => {
    mockSetPhoto.mockRejectedValue(answered(404));
    await settle(claimRecipePhoto('r1', '/uploads/recipes/gone.jpg'));
    expect(mockSetPhoto).toHaveBeenCalledTimes(1); // no point retrying an answer
    expect(await readQueue()).toEqual([]);
  });
});

describe('flushPendingPhotoClaims', () => {
  const park = async (recipeId: string, imageUrl: string) => {
    mockSetPhoto.mockRejectedValue(offline());
    await settle(claimRecipePhoto(recipeId, imageUrl));
  };

  it('a successful flush claims and dequeues', async () => {
    await park('r1', '/uploads/recipes/abc.jpg');
    mockSetPhoto.mockReset();
    mockSetPhoto.mockResolvedValue({ data: { claimed: 'abc.jpg' as string | null, removed: 0 } });
    await settle(flushPendingPhotoClaims());
    expect(mockSetPhoto).toHaveBeenCalledWith('r1', '/uploads/recipes/abc.jpg');
    expect(await readQueue()).toEqual([]);
  });

  it('a 404 (photo swept while parked) dequeues silently', async () => {
    await park('r1', '/uploads/recipes/gone.jpg');
    mockSetPhoto.mockReset();
    mockSetPhoto.mockRejectedValue(answered(404));
    await settle(flushPendingPhotoClaims());
    expect(await readQueue()).toEqual([]);
  });

  it('a still-unreachable server keeps the claim parked for next time', async () => {
    await park('r1', '/uploads/recipes/abc.jpg');
    mockSetPhoto.mockReset();
    mockSetPhoto.mockRejectedValue(offline());
    await settle(flushPendingPhotoClaims());
    expect(await readQueue()).toEqual([{ recipeId: 'r1', imageUrl: '/uploads/recipes/abc.jpg' }]);
  });

  it('an empty queue is a no-op', async () => {
    await settle(flushPendingPhotoClaims());
    expect(mockSetPhoto).not.toHaveBeenCalled();
  });
});
