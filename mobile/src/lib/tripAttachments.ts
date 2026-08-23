import { Linking, Share } from 'react-native';
import { cacheDirectory, downloadAsync } from 'expo-file-system/legacy';
import { TripItemAttachment } from '../api';
import { API_URL } from '../config';
import { getCachedToken } from './secureToken';
import { getHDK } from './e2ee';
import { decryptDownloadedFile } from './attachments';

// Open a booking's confirmation file (PDF / image), shared by the booking form
// and the booking view — both surfaces show the same list, so neither may own a
// private copy of how a file comes back down.
//
// An encrypted attachment downloads as ciphertext and is decrypted on-device to
// a temp file before the share sheet sees it; a plaintext one (legacy, or a
// shared trip) opens straight from the tokened URL. A TripKey-wrapped file key
// (a `shared_shared` receipt, §D2) unwraps with the trip's resource key — an
// HDK-wrapped one ignores the resource argument.
export async function openTripAttachment(
  tripId: string,
  itemId: string,
  att: TripItemAttachment,
): Promise<void> {
  const url = `${API_URL}/trips/${tripId}/items/${itemId}/attachments/${att._id}/download`;
  if (!att.encrypted) {
    await Linking.openURL(`${url}?token=${getCachedToken()}`);
    return;
  }
  if (!getHDK() || !att.wrappedFileKey) throw new Error('Unlock your account to open this encrypted attachment.');
  const dl = await downloadAsync(url, `${cacheDirectory}dl-att-${att._id}.bin`, {
    headers: { Authorization: `Bearer ${getCachedToken()}` },
  });
  const name = att.filename && att.filename.includes('.')
    ? att.filename
    : `attachment${(att.fileType || '').includes('pdf') ? '.pdf' : ''}`;
  const plainUri = await decryptDownloadedFile(
    'TripItemAttachment', att._id, att.keyVersion, att.wrappedFileKey, dl.uri, name, tripId,
  );
  if (!plainUri) throw new Error('Could not decrypt this attachment.');
  await Share.share({ url: plainUri });
}
