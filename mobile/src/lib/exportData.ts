// Encrypted export / import (Phase 7, decision 12) — the only sync bridge for a
// solo local-only user (no cloud copy). We gather the on-device replica, encrypt
// it under a passphrase-derived key, and write a portable file the user can move
// to another device and import. Passphrase → Argon2id KEK wraps a random export
// key (reusing the same factor primitive that protects the identity key); the
// export key encrypts the JSON via chunked AEAD. Needs expo-file-system (native).

import * as FileSystem from 'expo-file-system/legacy';
import { loadHouseholdCrypto } from '@household/crypto/adapters/native';
import * as replica from './replica';

// The dual-write collections whose records the replica caches. Kept in sync with
// the server CONTENT_MODELS / DROP_FIELDS map.
const EXPORT_COLLECTIONS = [
  'CalendarEvent', 'Contact', 'MaintenanceTask', 'Chore', 'Recipe',
  'Trip', 'TripItem', 'Item',
];

const CHUNK = 1024 * 1024;

function chunkify(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) out.push(bytes.subarray(i, i + CHUNK));
  return out;
}

// Build a passphrase-encrypted backup of every cached collection and write it to
// a cache file. Returns the file uri to share, or null if there's nothing to
// export. The passphrase is never stored — losing it loses the backup.
export async function exportEncryptedBackup(passphrase: string): Promise<string | null> {
  const crypto = await loadHouseholdCrypto();
  const collections: Record<string, unknown[]> = {};
  let total = 0;
  for (const c of EXPORT_COLLECTIONS) {
    const rows = await replica.getAll(c);
    if (rows.length) { collections[c] = rows; total += rows.length; }
  }
  if (!total) return null;

  const exportKey = crypto.generateFileKey();
  const keyEnvelope = crypto.createPasswordFactor(exportKey, passphrase);
  const plaintext = new TextEncoder().encode(JSON.stringify({ collections }));
  const data = crypto.encryptFile(exportKey, chunkify(plaintext));

  const blob = JSON.stringify({ v: 'hc-export-v1', createdAt: new Date().toISOString(), total, keyEnvelope, data });
  const uri = `${FileSystem.cacheDirectory}household-backup-${Date.now()}.hcbackup`;
  await FileSystem.writeAsStringAsync(uri, blob, { encoding: FileSystem.EncodingType.UTF8 });
  return uri;
}

// Restore a backup file into the local replica (import on a new device). Throws
// on a wrong passphrase or a malformed/incompatible file.
export async function importEncryptedBackup(fileUri: string, passphrase: string): Promise<{ total: number }> {
  const crypto = await loadHouseholdCrypto();
  const raw = await FileSystem.readAsStringAsync(fileUri, { encoding: FileSystem.EncodingType.UTF8 });
  const parsed = JSON.parse(raw);
  if (parsed?.v !== 'hc-export-v1') throw new Error('Not a compatible backup file.');

  let exportKey: Uint8Array;
  try { exportKey = crypto.openPasswordFactor(parsed.keyEnvelope, passphrase); }
  catch { throw new Error('Wrong passphrase for this backup.'); }

  const bytes = crypto.decryptFile(exportKey, parsed.data);
  const { collections } = JSON.parse(new TextDecoder().decode(bytes)) as { collections: Record<string, { _id: string; updatedAt?: string }[]> };

  let total = 0;
  for (const [collection, rows] of Object.entries(collections || {})) {
    if (Array.isArray(rows) && rows.length) { await replica.upsert(collection, rows); total += rows.length; }
  }
  return { total };
}
