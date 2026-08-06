import { ecardPhotoUploadPath } from '../api';
import { uploadFile } from './upload';
import type { PickedFile } from './media';

// Upload a card's freshly picked photos. Runs AFTER the e-card form has
// closed — the card row itself saves fast (a small JSON POST), and the
// multi-MB photo uploads shouldn't hold the user on the screen. Uploads run
// in parallel; a failure never loses the card (the photo can be re-added from
// the edit screen). Returns the number of photos that failed so the caller
// can tell the user.
export async function uploadECardPhotos(cardId: string, files: PickedFile[]): Promise<number> {
  const results = await Promise.allSettled(
    files.map((f) => uploadFile(ecardPhotoUploadPath(cardId), f, 'photo')),
  );
  return results.filter((r) => r.status === 'rejected').length;
}
