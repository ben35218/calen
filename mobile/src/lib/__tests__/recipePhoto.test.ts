// Displaying and claiming a recipe's photo (spec: features/kitchen.md, "The
// photo on a recipe"). The stored value is a server PATH, so every surface has
// to join the API host at display time — passing the raw value to <Image>
// renders nothing at all, which is how the card thumbnail and the detail hero
// were already broken before this existed.

import { recipeImageUri, claimRecipePhoto } from '../recipePhoto';
import { API_BASE_URL } from '../../config';

const mockSetPhoto = jest.fn(async () => ({ data: { claimed: null, removed: 0 } }));
jest.mock('../../api', () => ({
  recipesApi: { setPhoto: (...args: unknown[]) => mockSetPhoto(...(args as [])) },
}));

beforeEach(() => mockSetPhoto.mockClear());

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
    mockSetPhoto.mockRejectedValueOnce(new Error('offline'));
    await expect(claimRecipePhoto('r1', '/uploads/recipes/abc.jpg')).resolves.toBeUndefined();
  });
});
