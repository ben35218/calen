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
// Quiet but no longer fire-and-forget: a claim that dies (offline, server
// blip) after the recipe itself saved used to leave the RecipePhoto row
// unclaimed, and the 24h orphan sweep deleted the file while the sealed
// recipe's imageUrl still pointed at it — a permanently broken hero. The claim
// now retries a couple of times inline, and a claim that still can't reach the
// server is parked in a durable AsyncStorage queue, flushed opportunistically
// (app foreground, recipe detail open). It still never rejects and never
// surfaces an error the cook has to read.

const PENDING_CLAIMS_KEY = 'recipePhotoClaims.pending';
const CLAIM_RETRIES = 2; // quick inline retries after the first attempt
const CLAIM_RETRY_DELAY_MS = 700;

// Required lazily: AsyncStorage is a native module, and most importers of this
// file (thumbnails, heroes) never touch the claim queue — a static import
// would drag it into every one of their test module graphs.
const storage = () => {
  const mod = require('@react-native-async-storage/async-storage');
  return (mod.default ?? mod) as {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
  };
};

interface PendingClaim {
  recipeId: string;
  imageUrl: string;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// One claim attempt. 'done' = nothing left to do — success, or the server
// ANSWERED with an error (a 404 means the file was already swept, a 400 means
// it was never ours; retrying can't change either answer). 'retry' = the
// request never got an answer (offline, timeout) — worth trying again later.
async function attemptClaim(recipeId: string, imageUrl: string | null): Promise<'done' | 'retry'> {
  try {
    await recipesApi.setPhoto(recipeId, imageUrl);
    return 'done';
  } catch (err) {
    return (err as { response?: unknown })?.response ? 'done' : 'retry';
  }
}

async function readPendingClaims(): Promise<PendingClaim[]> {
  try {
    const raw = await storage().getItem(PENDING_CLAIMS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function writePendingClaims(list: PendingClaim[]): Promise<void> {
  try {
    if (list.length) await storage().setItem(PENDING_CLAIMS_KEY, JSON.stringify(list));
    else await storage().removeItem(PENDING_CLAIMS_KEY);
  } catch {
    // Losing the queue costs a picture at worst — same posture as the claim.
  }
}

// Park a claim for a later flush. One entry per recipe (a newer save's claim
// supersedes an older one — the server claim unbinds the rest anyway).
async function enqueuePendingClaim(claim: PendingClaim): Promise<void> {
  const queue = await readPendingClaims();
  await writePendingClaims([...queue.filter((c) => c.recipeId !== claim.recipeId), claim]);
}

export async function claimRecipePhoto(recipeId: string, imageUrl?: string | null): Promise<void> {
  // Only a file we host is ours to claim or delete; an absolute URL on an older
  // recipe points at someone else's server, where there is nothing to keep.
  const ours = imageUrl?.startsWith('/uploads/recipes/') ? imageUrl : null;
  for (let attempt = 0; attempt <= CLAIM_RETRIES; attempt++) {
    if (attempt) await delay(CLAIM_RETRY_DELAY_MS);
    if ((await attemptClaim(recipeId, ours)) === 'done') return;
  }
  // A null "claim" (photo removed/external) that can't get through is not
  // queued: nothing is at risk of the sweep — the cost is a replaced photo's
  // bytes lingering, which the next successful save clears.
  if (ours) await enqueuePendingClaim({ recipeId, imageUrl: ours });
}

// Retry every parked claim once. Called opportunistically (app foreground,
// recipe detail open); serialized so overlapping flushes can't double-send or
// resurrect each other's dequeued entries.
let flushInFlight: Promise<void> | null = null;
export function flushPendingPhotoClaims(): Promise<void> {
  if (flushInFlight) return flushInFlight;
  flushInFlight = (async () => {
    const queue = await readPendingClaims();
    if (!queue.length) return;
    const remaining: PendingClaim[] = [];
    for (const claim of queue) {
      if ((await attemptClaim(claim.recipeId, claim.imageUrl)) === 'retry') remaining.push(claim);
    }
    await writePendingClaims(remaining);
  })().finally(() => { flushInFlight = null; });
  return flushInFlight;
}
