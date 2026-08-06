import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';

// A file ready to append to a multipart FormData (React Native shape).
export interface PickedFile {
  uri: string;
  name: string;
  type: string;
}

// How a picked file is presented to Claude: images and PDFs are sent inline as
// multimodal content blocks; anything else is announced to the model as a plain
// filename note (it can't read the bytes).
export type AttachmentKind = 'image' | 'document' | 'other';

export function classifyAttachment(mime: string): AttachmentKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'document';
  return 'other';
}

// Read a picked file's bytes as base64 (no data: prefix) for the chat transport,
// which carries attachments inline in the JSON request body.
export function readFileBase64(file: PickedFile): Promise<string> {
  return FileSystem.readAsStringAsync(file.uri, { encoding: FileSystem.EncodingType.Base64 });
}

function inferName(uri: string, fallback: string): string {
  const last = uri.split('/').pop();
  return last && last.includes('.') ? last : fallback;
}

// Take a photo with the camera. Returns null if permission is denied or the
// user cancels. Used by the "scan" flows (item / receipt / recipe / confirmation
// photo) that POST to the existing from-photo endpoints.
export async function takePhoto(): Promise<PickedFile | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) return null;
  const result = await ImagePicker.launchCameraAsync({ quality: 0.7 });
  if (result.canceled) return null;
  const asset = result.assets[0];
  return {
    uri: asset.uri,
    name: asset.fileName ?? inferName(asset.uri, 'photo.jpg'),
    type: asset.mimeType ?? 'image/jpeg',
  };
}

function assetToFile(asset: ImagePicker.ImagePickerAsset): PickedFile {
  return {
    uri: asset.uri,
    name: asset.fileName ?? inferName(asset.uri, 'photo.jpg'),
    type: asset.mimeType ?? 'image/jpeg',
  };
}

export async function pickImage(): Promise<PickedFile | null> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return null;
  const result = await ImagePicker.launchImageLibraryAsync({ quality: 0.7 });
  if (result.canceled) return null;
  return assetToFile(result.assets[0]);
}

// Pick up to `limit` photos in one library visit (e-card photos). Returns []
// when permission is denied or the picker is cancelled.
export async function pickImages(limit: number): Promise<PickedFile[]> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return [];
  const result = await ImagePicker.launchImageLibraryAsync({
    quality: 0.7,
    allowsMultipleSelection: true,
    selectionLimit: limit,
  });
  if (result.canceled) return [];
  return result.assets.map(assetToFile);
}

// Pick a document (PDF, image, or .eml) for manual/attachment/confirmation
// uploads. Mirrors the web app's file inputs.
export async function pickDocument(): Promise<PickedFile | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['application/pdf', 'image/*', 'message/rfc822'],
    copyToCacheDirectory: true,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  return {
    uri: asset.uri,
    name: asset.name ?? inferName(asset.uri, 'document'),
    type: asset.mimeType ?? 'application/octet-stream',
  };
}
