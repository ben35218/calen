// The picture on a recipe (spec: features/kitchen.md, "The photo on a recipe").
//
// A recipe's `imageUrl` is stored the way the server hands it back — a path,
// `/uploads/recipes/<key>.jpg`, not a URL. That is deliberate: the API host
// differs per environment (a LAN IP in dev, the Render host in production) and
// a stored absolute URL would pin a household's photos to whatever host they
// were saved from. The host is therefore joined at display time, here, and
// every surface that shows a recipe photo goes through `recipeImageUri` —
// passing the raw value to <Image> silently renders nothing.

import { API_BASE_URL } from '../config';
import { recipesApi } from '../api';
import { uploadFile } from './upload';
import type { PickedFile } from './media';

// Anything already absolute (a remote URL, a local file:// preview of a photo
// the user just picked, a data: URI) is left alone; a server path gets the API
// host; anything else is nothing to show.
export function recipeImageUri(imageUrl?: string | null): string | null {
  const value = imageUrl?.trim();
  if (!value) return null;
  if (/^(?:https?|file|data|content|asset|ph):/i.test(value)) return value;
  return value.startsWith('/') ? `${API_BASE_URL}${value}` : null;
}

// Upload a picked photo and return the server path to store on the recipe.
// Deliberately its own endpoint rather than the from-photo importer: this is a
// picture OF the dish, so there is no extraction to run, nothing to meter, and
// no AI consent to check.
export async function uploadRecipePhoto(file: PickedFile): Promise<string | null> {
  const { imageUrl } = await uploadFile<{ imageUrl?: string }>('/recipes/photo', file, 'photo');
  return imageUrl ?? null;
}

// Tell the server which photo a just-saved recipe kept, so the nightly sweep
// stops treating it as an abandoned draft (and so a replaced photo's bytes go).
//
// Best-effort on purpose: the recipe itself is already saved by the time this
// runs, and a failed claim costs a picture at worst — never the recipe, and
// never an error the cook has to read. The photo survives until the sweep, so a
// later save re-claims it.
export function claimRecipePhoto(recipeId: string, imageUrl?: string | null): Promise<void> {
  // Only a file we host is ours to claim or delete; an absolute URL on an older
  // recipe points at someone else's server, where there is nothing to keep.
  const ours = imageUrl?.startsWith('/uploads/recipes/') ? imageUrl : null;
  return recipesApi.setPhoto(recipeId, ours).then(() => undefined, () => undefined);
}
